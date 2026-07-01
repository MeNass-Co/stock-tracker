import { AlertEngine } from "./alerting/alert-engine.js";
import { startApi } from "./api/server.js";
import { getDb, insertFundHoldings, insertRankingRun, insertTrades, upsertSourceHealth } from "./db/queries.js";
import { EdgarSource } from "./ingestion/edgar.js";
import { HouseClerkSource } from "./ingestion/house-clerk.js";
import type { HouseFilingDetection } from "./ingestion/house-clerk.js";
import { QuiverSource } from "./ingestion/quiver.js";
import { OrderManager } from "./execution/order-manager.js";
import { PositionMonitor } from "./execution/position-monitor.js";
import { Rebalancer } from "./execution/rebalancer.js";
import { RiskEngine } from "./execution/risk-engine.js";
import { SignalFilter } from "./execution/signal-filter.js";
import { compositeRank } from "./ranking/composite-score.js";
import { calculateMetrics } from "./ranking/metrics.js";
import { PriceCache } from "./prices/price-cache.js";
import { YahooFinancePriceProvider } from "./prices/yahoo-finance.js";
import { diffHoldings, previousQuarterHoldings } from "./tracking/portfolio-diff.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { scheduleCron, scheduleEvery } from "./utils/scheduler.js";
import type { NormalizedTrade } from "./types.js";

const db = getDb();
const alertEngine = new AlertEngine(db);
const edgar = new EdgarSource();
const quiver = new QuiverSource();
const houseClerk = new HouseClerkSource(db);
const prices = new PriceCache(db, new YahooFinancePriceProvider());
const signalFilter = new SignalFilter(db, undefined, prices);
const orderManager = new OrderManager(db);
orderManager.setAlertEngine(alertEngine);
const positionMonitor = new PositionMonitor(db, alertEngine);
const riskEngine = new RiskEngine(db, undefined, prices);
const rebalancer = new Rebalancer(db, alertEngine, undefined, prices);

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled rejection");
  process.exit(1);
});
process.on("SIGTERM", () => { logger.info("SIGTERM received"); db.close(); process.exit(0); });
process.on("SIGINT", () => { logger.info("SIGINT received"); db.close(); process.exit(0); });

async function ingestTradeSource(name: string, fetchTrades: () => Promise<NormalizedTrade[]>) {
  const trades = await fetchTrades();
  const results = insertTrades(db, trades);
  const inserted = trades
    .map((trade, index) => ({ ...trade, id: results[index]?.id ?? 0, inserted: results[index]?.inserted ?? false }))
    .filter((trade) => trade.inserted);
  if (inserted.length > 0) await alertEngine.processTrades(inserted);
  if (config.EXECUTION_ENABLED && inserted.length > 0) {
    const decisions = await Promise.all(inserted.map((trade) => signalFilter.evaluateTrade(trade)));
    for (const decision of decisions.filter((decision) => decision.copy).sort((left, right) => right.priority - left.priority)) {
      await orderManager.submitSignal(decision);
    }
  }
  logger.info({ source: name, fetched: trades.length, inserted: inserted.length }, "congress source ingestion complete");
}

async function evaluateUnevaluatedTradesForFilers(filerNames: string[]) {
  if (!config.EXECUTION_ENABLED || filerNames.length === 0) return;

  // Find recent trades for these politicians that have no corresponding stock_execution.
  // This catches trades that were inserted by quiver/edgar when EXECUTION_ENABLED was off,
  // or before the process restarted, or that were missed for any reason.
  const placeholders = filerNames.map(() => "?").join(", ");
  const unevaluated = db
    .prepare(
      `SELECT t.id, t.politician_id, t.ticker, t.asset_name, t.trade_date, t.filing_date,
              t.detected_at, t.direction, t.amount_range, t.amount_midpoint, t.asset_type,
              t.source, t.source_id, t.raw_data,
              p.name, p.chamber, p.state, p.party, p.committees
       FROM trades t
       JOIN politicians p ON p.id = t.politician_id
       WHERE p.chamber = 'house'
         AND p.name IN (${placeholders})
         AND t.detected_at >= datetime('now', '-30 days')
         AND t.id NOT IN (SELECT trigger_id FROM stock_executions WHERE trigger_id IS NOT NULL)
         AND NOT EXISTS (
           SELECT 1 FROM signal_decisions sd
           WHERE sd.trade_id = t.id
             AND (sd.decision IN ('reject', 'ordered') OR sd.reason = 'no open positions for exit')
         )
       ORDER BY t.detected_at DESC`
    )
    .all(...filerNames) as Array<{
      id: number; politician_id: number; ticker: string | null; asset_name: string;
      trade_date: string; filing_date: string; detected_at: string; direction: string;
      amount_range: string | null; amount_midpoint: number | null; asset_type: string;
      source: string; source_id: string | null; raw_data: string | null;
      name: string; chamber: string; state: string | null; party: string | null; committees: string | null;
    }>;

  if (unevaluated.length === 0) {
    logger.info({ filerNames: filerNames.slice(0, 5) }, "house-clerk: no unevaluated trades found for PTR filers");
    return;
  }

  logger.info({ count: unevaluated.length, filers: filerNames.slice(0, 5) }, "house-clerk: evaluating previously-unevaluated trades for PTR filers");

  const trades = unevaluated.map((row) => ({
    id: row.id,
    politician: {
      name: row.name,
      chamber: row.chamber as "senate" | "house",
      state: row.state,
      party: row.party,
      committees: row.committees ? JSON.parse(row.committees) : [],
    },
    ticker: row.ticker,
    assetName: row.asset_name,
    tradeDate: row.trade_date,
    filingDate: row.filing_date,
    detectedAt: row.detected_at,
    direction: row.direction as "buy" | "sell" | "exchange",
    amountRange: row.amount_range,
    amountMidpoint: row.amount_midpoint,
    assetType: row.asset_type,
    source: row.source,
    sourceId: row.source_id,
    rawData: row.raw_data ? JSON.parse(row.raw_data) : null,
  }));

  const decisions = await Promise.all(trades.map((trade) => signalFilter.evaluateTrade(trade)));
  const actionable = decisions.filter((d) => d.copy).sort((a, b) => b.priority - a.priority);
  logger.info({ evaluated: decisions.length, actionable: actionable.length }, "house-clerk: PTR filer trade evaluation complete");

  for (const decision of actionable) {
    await orderManager.submitSignal(decision);
  }
}

async function ingest13F() {
  const holdings = await edgar.fetch13FForTier1Funds();
  const grouped = new Map<string, typeof holdings>();
  for (const holding of holdings) {
    const key = `${holding.fundCik}|${holding.reportDate}`;
    grouped.set(key, [...(grouped.get(key) ?? []), holding]);
  }
  for (const current of grouped.values()) {
    const first = current[0];
    if (!first) continue;
    const { cnt } = db
      .prepare("SELECT count(*) as cnt FROM fund_holdings WHERE fund_cik = ? AND report_date = ?")
      .get(first.fundCik, first.reportDate) as { cnt: number };
    const isNewFiling = cnt === 0;
    const previous = previousQuarterHoldings(db, first.fundCik, first.reportDate);
    const diffs = diffHoldings(previous, current);
    insertFundHoldings(db, diffs);
    if (isNewFiling) {
      await alertEngine.process13FDiffs(diffs);
      if (config.EXECUTION_ENABLED) await rebalancer.onNewFiling(diffs);
    }
  }
  logger.info({ holdings: holdings.length }, "13F ingestion complete");
}

async function recalculateRankings() {
  const metrics = await calculateMetrics(db, prices);
  const rankings = compositeRank(metrics);
  insertRankingRun(db, rankings);
  await alertEngine.rankingChanged();
  logger.info({ rankings: rankings.length }, "ranking complete");
}

async function updateHealth() {
  for (const [sourceName, source] of [
    ["edgar", edgar],
    ["quiver", quiver],
    ["house-clerk", houseClerk]
  ] as const) {
    try {
      upsertSourceHealth(db, await source.healthCheck());
    } catch (error) {
      logger.warn({ error, source: sourceName }, "source healthCheck failed; recording unhealthy");
      upsertSourceHealth(db, {
        source: sourceName,
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  await alertEngine.checkSourceHealthAlerts().catch((error) => logger.warn({ error }, "source-down alert check failed"));
  await alertEngine.checkIngestionStalled().catch((error) => logger.warn({ error }, "ingestion-stalled alert check failed"));
}

async function main() {
  await startApi();
  scheduleEvery("edgar-congress", config.POLL_EDGAR, () => ingestTradeSource("edgar", () => edgar.fetchNewTrades()));
  scheduleEvery("quiver-congress", config.POLL_QUIVER, () => ingestTradeSource("quiver", () => quiver.fetchNewTrades()));
  scheduleEvery("house-clerk", config.POLL_HOUSE_CLERK, async () => {
    await houseClerk.fetchNewTrades();
    const detections = houseClerk.lastDetections;
    if (detections.length > 0) {
      const names = detections.map((d) => d.name).join(", ");
      await alertEngine.processBatchNotification({
        type: "house-filing",
        severity: "low",
        title: `${detections.length} new House PTR filing(s) detected`,
        body: `New filings: ${names.slice(0, 300)}${names.length > 300 ? "..." : ""}`,
        data: detections,
      });

      // Bridge PTR filings → trade evaluation:
      // 1. Re-fetch Quiver to pick up any new trades from detected filers (best-effort:
      //    a Quiver outage must not kill the job — that once swallowed filings for good)
      // 2. Evaluate DB trades for these filers that were never sent to signal-filter
      logger.info({ filers: detections.length }, "house-clerk: triggering quiver re-fetch for PTR filer trade evaluation");
      try {
        await ingestTradeSource("quiver", () => quiver.fetchNewTrades());
      } catch (error) {
        logger.warn({ error }, "house-clerk: quiver bridge re-fetch failed; continuing with trades already in DB");
      }
      const filerNames = detections.map((d: HouseFilingDetection) => d.name);
      await evaluateUnevaluatedTradesForFilers(filerNames);

      // Only now that the whole pipeline succeeded do the filings count as seen.
      houseClerk.markProcessed(detections.map((d) => d.docId));
    }
    logger.info({ source: "house-clerk", detected: detections.length }, "house-clerk scan complete");
  });
  scheduleEvery("13f-tier1", 6 * 60 * 60 * 1000, ingest13F);
  scheduleEvery("source-health", 15 * 60 * 1000, updateHealth);
  await recalculateRankings().catch((err) => logger.error({ err }, "initial ranking failed"));
  scheduleCron("daily-ranking", "0 0 * * *", recalculateRankings);
  if (config.EXECUTION_ENABLED) {
    scheduleEvery("position-monitor", 5 * 60 * 1000, () => positionMonitor.checkAll());
    scheduleEvery("portfolio-snapshot", 60 * 60 * 1000, () => riskEngine.snapshot());
    scheduleEvery("13f-rebalance", 6 * 60 * 60 * 1000, () => rebalancer.runDueRebalances());
    // Runs once at startup, then daily.
    scheduleEvery("position-reconcile", 24 * 60 * 60 * 1000, () => positionMonitor.reconcile());
  }
  scheduleEvery("wal-checkpoint", 4 * 60 * 60 * 1000, async () => {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
  });
}

main().catch((error) => {
  logger.fatal({ error }, "stock tracker crashed");
  process.exit(1);
});
