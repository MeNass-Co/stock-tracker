import { AlertEngine } from "./alerting/alert-engine.js";
import { startApi } from "./api/server.js";
import { getDb, insertFundHoldings, insertRankingRun, insertTrades, upsertSourceHealth } from "./db/queries.js";
import { EdgarSource } from "./ingestion/edgar.js";
import { HouseClerkSource } from "./ingestion/house-clerk.js";
import { QuiverSource } from "./ingestion/quiver.js";
import { SenateEfdSource } from "./ingestion/senate-efd.js";
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
const senateEfd = new SenateEfdSource();
const houseClerk = new HouseClerkSource();
const prices = new PriceCache(db, new YahooFinancePriceProvider());
const signalFilter = new SignalFilter(db);
const orderManager = new OrderManager(db);
orderManager.setAlertEngine(alertEngine);
const positionMonitor = new PositionMonitor(db, alertEngine);
const riskEngine = new RiskEngine(db);
const rebalancer = new Rebalancer(db, alertEngine);

process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "unhandled rejection");
  process.exit(1);
});
process.on("SIGTERM", () => { logger.info("SIGTERM received"); db.close(); process.exit(0); });
process.on("SIGINT", () => { logger.info("SIGINT received"); db.close(); process.exit(0); });

async function ingestCongressTrades() {
  await Promise.all([
    ingestTradeSource("edgar", () => edgar.fetchNewTrades()),
    ingestTradeSource("quiver", () => quiver.fetchNewTrades()),
    ingestTradeSource("senate-efd", () => senateEfd.fetchNewTrades()),
  ]);
}

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
  for (const source of [edgar, quiver, senateEfd, houseClerk]) {
    upsertSourceHealth(db, await source.healthCheck());
  }
}

async function main() {
  await startApi();
  scheduleEvery("edgar-congress", config.POLL_EDGAR, () => ingestTradeSource("edgar", () => edgar.fetchNewTrades()));
  scheduleEvery("quiver-congress", config.POLL_QUIVER, () => ingestTradeSource("quiver", () => quiver.fetchNewTrades()));
  scheduleEvery("senate-efd", config.POLL_SENATE_EFD, () => ingestTradeSource("senate-efd", () => senateEfd.fetchNewTrades()));
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
    }
    logger.info({ source: "house-clerk", detected: detections.length }, "house-clerk scan complete");
  });
  scheduleEvery("13f-tier1", 6 * 60 * 60 * 1000, ingest13F);
  scheduleEvery("source-health", 15 * 60 * 1000, updateHealth);
  await recalculateRankings().catch((err) => logger.error({ err }, "initial ranking failed"));
  scheduleCron("weekly-ranking", "0 0 * * 0", recalculateRankings);
  if (config.EXECUTION_ENABLED) {
    scheduleEvery("position-monitor", 5 * 60 * 1000, () => positionMonitor.checkAll());
    scheduleEvery("portfolio-snapshot", 60 * 60 * 1000, () => riskEngine.snapshot());
    scheduleEvery("13f-rebalance", 6 * 60 * 60 * 1000, () => rebalancer.runDueRebalances());
  }
  scheduleEvery("wal-checkpoint", 4 * 60 * 60 * 1000, async () => {
    try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
  });
}

main().catch((error) => {
  logger.fatal({ error }, "stock tracker crashed");
  process.exit(1);
});
