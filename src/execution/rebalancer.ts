import type Database from "better-sqlite3";
import type { AlertEngine } from "../alerting/alert-engine.js";
import type { FundHoldingInput } from "../types.js";
import type { PriceCache } from "../prices/price-cache.js";
import { logger } from "../utils/logger.js";
import { AlpacaClient } from "./alpaca-client.js";
import { OrderManager, isExecutionWindow } from "./order-manager.js";
import { SignalFilter } from "./signal-filter.js";
import { completeRebalanceRun, markRebalanceRun, markRebalanceRunFailed, openStockPositions, recordSignalDecision } from "../db/queries.js";

export class Rebalancer {
  private readonly signalFilter: SignalFilter;
  private readonly orderManager: OrderManager;

  constructor(
    private readonly db: Database.Database,
    private readonly alertEngine?: AlertEngine,
    private readonly alpaca = new AlpacaClient(),
    prices: PriceCache | null = null
  ) {
    this.signalFilter = new SignalFilter(db, alpaca, prices);
    this.orderManager = new OrderManager(db, alpaca);
  }

  async onNewFiling(diffs: FundHoldingInput[]) {
    if (diffs.length === 0) return;
    const first = diffs[0];
    if (!first) return;
    if (!this.isRebalanceWindow(first.filingDate)) {
      logger.info({ filingDate: first.filingDate, fundName: first.fundName, fundCik: first.fundCik }, "13F filing queued until delayed rebalance window");
      return;
    }
    if (!(await this.canTradeNow(first.fundCik, first.reportDate))) return;
    if (!markRebalanceRun(this.db, first.fundCik, first.reportDate)) return;
    try {
      const ordersSubmitted = await this.executeDiffs(diffs, first.fundCik, first.reportDate);
      completeRebalanceRun(this.db, first.fundCik, first.reportDate);
      await this.alertIfZeroOrders(first.fundCik, first.reportDate, diffs.length, ordersSubmitted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { error, fundCik: first.fundCik, reportDate: first.reportDate },
        "rebalance failed; persisting failed claim (manual intervention required to retry)"
      );
      markRebalanceRunFailed(this.db, first.fundCik, first.reportDate, message);
      throw error;
    }
  }

  async runDueRebalances() {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT fund_cik, report_date
         FROM fund_holdings
         WHERE change_type IS NOT NULL
           AND date('now') BETWEEN date(filing_date, '+3 days') AND date(filing_date, '+5 days')`
      )
      .all() as { fund_cik: string; report_date: string }[];
    if (rows.length === 0) return;

    for (const row of rows) {
      if (!(await this.canTradeNow(row.fund_cik, row.report_date))) return;
      if (!markRebalanceRun(this.db, row.fund_cik, row.report_date)) continue;
      const diffs = this.db
        .prepare("SELECT * FROM fund_holdings WHERE fund_cik = ? AND report_date = ? AND change_type IS NOT NULL")
        .all(row.fund_cik, row.report_date)
        .map(mapHolding);
      try {
        const ordersSubmitted = await this.executeDiffs(diffs, row.fund_cik, row.report_date);
        completeRebalanceRun(this.db, row.fund_cik, row.report_date);
        await this.alertIfZeroOrders(row.fund_cik, row.report_date, diffs.length, ordersSubmitted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, fundCik: row.fund_cik, reportDate: row.report_date },
          "rebalance failed; persisting failed claim (manual intervention required to retry)"
        );
        markRebalanceRunFailed(this.db, row.fund_cik, row.report_date, message);
      }
    }
  }

  /**
   * Root cause of the never-trading 13F sleeve: the 6-hourly tick claimed
   * rebalance runs while the market was closed; every buy was then silently
   * dropped by the execution-window gate, and completeRebalanceRun consumed
   * the signals forever. Never CLAIM a run unless orders can actually be
   * submitted right now.
   */
  private async canTradeNow(fundCik: string, reportDate: string): Promise<boolean> {
    try {
      const clock = await this.alpaca.getClock();
      if (clock.is_open && isExecutionWindow()) return true;
      logger.info({ fundCik, reportDate, isOpen: clock.is_open }, "rebalance deferred: outside market hours / execution window (run not claimed)");
      return false;
    } catch (error) {
      logger.warn({ error, fundCik, reportDate }, "rebalance deferred: Alpaca clock unavailable (run not claimed)");
      return false;
    }
  }

  private async alertIfZeroOrders(fundCik: string, reportDate: string, diffCount: number, ordersSubmitted: number) {
    if (ordersSubmitted > 0) return;
    logger.warn({ fundCik, reportDate, diffCount }, "completed rebalance produced 0 orders");
    await this.alertEngine
      ?.systemAlert({
        type: "rebalance_zero_orders",
        severity: "high",
        title: `13F rebalance produced 0 orders (${fundCik} ${reportDate})`,
        body: `Rebalance for fund ${fundCik} report ${reportDate} completed with ${diffCount} actionable diffs but submitted no orders. See signal_decisions for per-holding reasons.`,
        data: { fundCik, reportDate, diffCount }
      })
      .catch((error) => logger.warn({ error }, "zero-order rebalance alert failed"));
  }

  /** Returns the number of orders actually submitted to Alpaca. */
  private async executeDiffs(diffs: FundHoldingInput[], fundCik: string, reportDate: string): Promise<number> {
    let ordersSubmitted = 0;
    const exitsByTicker = this.crossFundExits(diffs);
    const fullyExitedTickers = new Set<string>();
    for (const [ticker, count] of exitsByTicker) {
      if (count >= 2) {
        fullyExitedTickers.add(ticker);
        ordersSubmitted += await this.exitTicker(ticker, "fund_exit");
      }
    }

    const sells = diffs.filter((holding) => {
      const ticker = holding.ticker?.toUpperCase();
      if (ticker && fullyExitedTickers.has(ticker)) return false;
      return holding.changeType === "exit" || (holding.changeType === "decrease" && Math.abs(holding.changePct ?? 0) >= 0.25);
    });
    const buys = diffs.filter((holding) => holding.changeType === "new" || (holding.changeType === "increase" && (holding.changePct ?? 0) >= 0.25));

    // Per-holding funnel rows: every diff in a rebalance leaves a decision.
    for (const holding of diffs) {
      if (sells.includes(holding) || buys.includes(holding)) continue;
      const ticker = holding.ticker?.toUpperCase() ?? null;
      const reason = ticker && fullyExitedTickers.has(ticker)
        ? "handled by cross-fund exit"
        : `not actionable (changeType=${holding.changeType ?? "none"}, changePct=${holding.changePct ?? 0})`;
      this.recordHoldingDecision(holding, "reject", reason);
    }

    for (const holding of sells) {
      ordersSubmitted += await this.rebalanceSell(holding);
    }

    if (sells.length > 0 && buys.length > 0) await new Promise((resolve) => setTimeout(resolve, 30 * 1000));

    for (const holding of buys) {
      const decision = await this.signalFilter.evaluate13FDiff(holding);
      if (!decision.copy) continue;
      decision.metadata = { ...decision.metadata, dailyFraction: 0.2, fundSignalCount: this.fundSignalCount(diffs, decision.ticker) };
      const order = await this.orderManager.submitSignal(decision);
      if (order) ordersSubmitted += 1;
    }

    try {
      await this.alertEngine?.executionNotification({
        type: "rebalance",
        ticker: "13F",
        direction: "buy",
        size: buys.length,
        reason: `processed ${sells.length} sells and ${buys.length} buys; submitted ${ordersSubmitted} orders`
      });
    } catch (error) {
      logger.warn({ error, fundCik, reportDate }, "rebalance alert failed (run already persisted)");
    }
    return ordersSubmitted;
  }

  private recordHoldingDecision(holding: FundHoldingInput, decision: "reject" | "ordered" | "skipped", reason: string) {
    try {
      recordSignalDecision(this.db, {
        sleeve: "13f",
        ticker: holding.ticker?.toUpperCase() ?? null,
        decision,
        reason,
        fundCik: holding.fundCik,
        reportDate: holding.reportDate
      });
    } catch (error) {
      logger.warn({ error, ticker: holding.ticker }, "failed to persist rebalance holding decision");
    }
  }

  private async rebalanceSell(holding: FundHoldingInput): Promise<number> {
    const ticker = holding.ticker?.toUpperCase();
    if (!ticker) return 0;
    const positions = openStockPositions(this.db).filter(
      (position) => position.sleeve === "13f" && position.ticker === ticker && (!position.fundName || position.fundName === holding.fundName)
    );
    if (positions.length === 0) {
      this.recordHoldingDecision(holding, "skipped", "sell signal but no open 13f position");
      return 0;
    }
    const trimPct = holding.changeType === "exit" ? 1 : Math.min(1, Math.abs(holding.changePct ?? 0));
    let submitted = 0;
    for (const position of positions) {
      const quantity = position.quantity * trimPct;
      await this.orderManager.submitMarketExit(position.id, position.ticker, quantity, "fund_exit", "13f", trimPct >= 0.999);
      submitted += 1;
    }
    this.recordHoldingDecision(holding, "ordered", `sell orders for ${submitted} position(s), trim ${Math.round(trimPct * 100)}%`);
    return submitted;
  }

  private async exitTicker(ticker: string, reason: "fund_exit"): Promise<number> {
    const positions = openStockPositions(this.db).filter((position) => position.sleeve === "13f" && position.ticker === ticker);
    let submitted = 0;
    for (const position of positions) {
      await this.orderManager.submitMarketExit(position.id, position.ticker, position.quantity, reason, "13f", true);
      submitted += 1;
    }
    return submitted;
  }

  private crossFundExits(diffs: FundHoldingInput[]) {
    const exits = new Map<string, number>();
    for (const holding of diffs) {
      if (holding.changeType !== "exit" || !holding.ticker) continue;
      exits.set(holding.ticker.toUpperCase(), (exits.get(holding.ticker.toUpperCase()) ?? 0) + 1);
    }
    return exits;
  }

  private fundSignalCount(diffs: FundHoldingInput[], ticker: string) {
    return new Set(
      diffs
        .filter((holding) => holding.ticker?.toUpperCase() === ticker && (holding.changeType === "new" || (holding.changeType === "increase" && (holding.changePct ?? 0) >= 0.25)))
        .map((holding) => holding.fundCik)
    ).size;
  }

  private isRebalanceWindow(filingDate: string) {
    const filed = new Date(`${filingDate.slice(0, 10)}T00:00:00Z`);
    const now = new Date();
    const daysSinceFiling = Math.floor((now.getTime() - filed.getTime()) / 86_400_000);
    return daysSinceFiling >= 3 && daysSinceFiling <= 5;
  }

}

function mapHolding(row: any): FundHoldingInput {
  return {
    fundName: row.fund_name,
    fundCik: row.fund_cik,
    reportDate: row.report_date,
    filingDate: row.filing_date,
    ticker: row.ticker,
    cusip: row.cusip,
    securityName: row.security_name,
    shares: row.shares,
    valueThousands: row.value_thousands,
    changeType: row.change_type,
    changeShares: row.change_shares,
    changePct: row.change_pct
  };
}
