import { getDb } from "../src/db/queries.js";
import { SignalFilter } from "../src/execution/signal-filter.js";
import { OrderManager } from "../src/execution/order-manager.js";
import { AlertEngine } from "../src/alerting/alert-engine.js";
import { logger } from "../src/utils/logger.js";
import type { NormalizedTrade } from "../src/types.js";

interface TradeRow {
  id: number;
  politician_id: number;
  name: string;
  chamber: string;
  committees: string | null;
  ticker: string | null;
  asset_name: string;
  trade_date: string;
  filing_date: string;
  direction: string;
  amount_range: string | null;
  amount_midpoint: number | null;
  asset_type: string | null;
  source: string;
  source_id: string | null;
  detected_at: string;
  raw_data: string | null;
}

async function main() {
  const db = getDb();
  const alertEngine = new AlertEngine(db);
  const signalFilter = new SignalFilter(db);
  const orderManager = new OrderManager(db);
  orderManager.setAlertEngine(alertEngine);

  const rows = db
    .prepare(
      `SELECT t.id, t.politician_id, p.name, p.chamber, p.committees,
              t.ticker, t.asset_name, t.trade_date, t.filing_date, t.direction,
              t.amount_range, t.amount_midpoint, t.asset_type, t.source, t.source_id, t.detected_at, t.raw_data
       FROM trades t
       JOIN politicians p ON p.id = t.politician_id
       WHERE t.source = 'quiver'
         AND t.detected_at > datetime('now','-7 days')
       ORDER BY t.detected_at ASC`
    )
    .all() as TradeRow[];

  logger.info({ count: rows.length }, "replay: loaded backlog trades");

  let copied = 0;
  let rejected = 0;
  const decisions: { decision: Awaited<ReturnType<SignalFilter["evaluateTrade"]>>; tradeId: number }[] = [];

  for (const row of rows) {
    let committees: string[] = [];
    try {
      committees = row.committees ? JSON.parse(row.committees) : [];
    } catch {
      committees = [];
    }
    let rawData: unknown = null;
    try {
      rawData = row.raw_data ? JSON.parse(row.raw_data) : null;
    } catch {
      rawData = row.raw_data;
    }
    const trade: NormalizedTrade & { id: number } = {
      id: row.id,
      politician: { name: row.name, chamber: row.chamber as "senate" | "house", committees },
      ticker: row.ticker ?? null,
      assetName: row.asset_name,
      tradeDate: row.trade_date,
      filingDate: row.filing_date,
      direction: row.direction as "buy" | "sell" | "exchange",
      amountRange: row.amount_range ?? null,
      amountMidpoint: row.amount_midpoint ?? null,
      assetType: (row.asset_type ?? "stock") as NormalizedTrade["assetType"],
      source: row.source as NormalizedTrade["source"],
      sourceId: row.source_id ?? undefined,
      detectedAt: row.detected_at,
      rawData
    };

    const decision = await signalFilter.evaluateTrade(trade);
    if (decision.copy) {
      copied++;
      decisions.push({ decision, tradeId: row.id });
      logger.info(
        { tradeId: row.id, ticker: decision.ticker, name: row.name, priority: decision.priority, boosts: decision.boosts },
        "replay: PASS"
      );
    } else {
      rejected++;
    }
  }

  logger.info({ copied, rejected, total: rows.length }, "replay: evaluation complete");

  decisions.sort((a, b) => b.decision.priority - a.decision.priority);
  for (const { decision, tradeId } of decisions) {
    try {
      await orderManager.submitSignal(decision);
      logger.info({ tradeId, ticker: decision.ticker }, "replay: submitted");
    } catch (err) {
      logger.error({ err, tradeId, ticker: decision.ticker }, "replay: submit failed");
    }
  }

  logger.info("replay: done");
  db.close();
}

main().catch((err) => {
  logger.error({ err }, "replay: fatal");
  process.exit(1);
});
