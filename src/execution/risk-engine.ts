import type Database from "better-sqlite3";
import { config } from "../config.js";
import {
  countExecutionsToday,
  getAppState,
  insertPortfolioSnapshot,
  latestPortfolioSnapshot,
  openStockPositions,
  setAppState
} from "../db/queries.js";
import { logger } from "../utils/logger.js";
import type { PriceCache } from "../prices/price-cache.js";
import { AlpacaClient, type AlpacaAccount } from "./alpaca-client.js";
import type { SignalDecision } from "./signal-filter.js";

const INITIAL_CAPITAL_USD = 100_000;
const SPY_BENCHMARK_SHARES_KEY = "spy_benchmark_shares";

export interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
}

export class RiskEngine {
  constructor(
    private readonly db: Database.Database,
    private readonly alpaca = new AlpacaClient(),
    private readonly prices: PriceCache | null = null
  ) {}

  async checkNewOrder(decision: SignalDecision, requestedSize: number): Promise<RiskCheck> {
    const account = await this.alpaca.getAccount();
    const accountStop = this.accountStop(account);
    if (accountStop) return accountStop;

    const circuitBreaker = this.circuitBreaker(account, decision);
    if (!circuitBreaker.allowed) return circuitBreaker;

    if (decision.direction === "buy" && countExecutionsToday(this.db) >= config.MAX_DAILY_TRADES) {
      return { allowed: false, reason: `max ${config.MAX_DAILY_TRADES} new trades reached today` };
    }

    const totalValue = money(account.portfolio_value);
    const cash = money(account.cash);
    if (totalValue <= 0) return { allowed: false, reason: "portfolio value unavailable" };
    let adjustedSize = Math.min(requestedSize, totalValue * 0.05);

    const minCash = totalValue * 0.1;
    if (decision.direction === "buy" && cash - adjustedSize < minCash) adjustedSize = Math.max(0, cash - minCash);
    if (adjustedSize < 1) return { allowed: false, reason: "cash reserve would fall below 10%" };

    const positions = openStockPositions(this.db);
    const tickerExposure = positions.filter((position) => position.ticker === decision.ticker).reduce((sum, position) => sum + positionValue(position), 0);
    adjustedSize = Math.min(adjustedSize, Math.max(0, totalValue * 0.05 - tickerExposure));
    if (adjustedSize < 1) return { allowed: false, reason: "same ticker aggregate cap reached" };

    if (decision.sleeve === "senator" && decision.senatorName) {
      const senatorExposure = positions
        .filter((position) => position.senatorName === decision.senatorName)
        .reduce((sum, position) => sum + positionValue(position), 0);
      adjustedSize = Math.min(adjustedSize, Math.max(0, totalValue * 0.15 - senatorExposure));
      if (adjustedSize < 1) return { allowed: false, reason: "single senator exposure cap reached" };
    }

    const sector = typeof decision.metadata?.sector === "string" ? decision.metadata.sector : null;
    if (sector) {
      const sectorExposure = positions.filter((position) => position.sector === sector).reduce((sum, position) => sum + positionValue(position), 0);
      adjustedSize = Math.min(adjustedSize, Math.max(0, totalValue * 0.25 - sectorExposure));
      if (adjustedSize < 1) return { allowed: false, reason: "sector exposure cap reached" };
    }

    const vix = Number(decision.metadata?.vix ?? 0);
    if (vix > 30) return { allowed: false, reason: "VIX above 30" };

    const heat = this.portfolioHeat(totalValue);
    if (heat > 0.08) {
      const heatAdjustment = Math.max(0.25, 0.08 / heat);
      adjustedSize *= heatAdjustment;
      logger.warn({ heat, heatAdjustment }, "portfolio heat above limit; reducing new order size");
    }

    return {
      allowed: true,
      adjustedSize: Math.round(adjustedSize * 100) / 100,
      reason: adjustedSize < requestedSize ? "risk checks reduced order size" : "risk checks passed"
    };
  }

  async snapshot() {
    const [account, alpacaPositions] = await Promise.all([this.alpaca.getAccount(), this.alpaca.getPositions()]);
    const totalValue = money(account.portfolio_value);
    const cashValue = money(account.cash);
    const localPositions = openStockPositions(this.db);
    const bySymbol = new Map(alpacaPositions.map((position) => [position.symbol, position]));
    const sleeveValue = (sleeve: "senator" | "13f") =>
      localPositions
        .filter((position) => position.sleeve === sleeve)
        .reduce((sum, position) => {
          const alpacaPosition = bySymbol.get(position.ticker);
          return sum + money(alpacaPosition?.market_value ?? positionValue(position));
        }, 0);

    const latest = latestPortfolioSnapshot(this.db);
    const highWaterMark = Math.max(totalValue, latest?.high_water_mark ?? totalValue);
    const startOfDay = this.startOfDayValue() ?? totalValue;
    const dailyPnl = totalValue - startOfDay;
    const dailyPnlRatio = startOfDay > 0 ? dailyPnl / startOfDay : 0;
    // Real cumulative P&L vs initial capital; the old value (totalValue − HWM)
    // was actually drawdown-vs-high-water-mark, which now lives in drawdown_usd.
    const cumulativePnl = totalValue - INITIAL_CAPITAL_USD;
    const drawdownUsd = totalValue - highWaterMark;
    const spyEquity = await this.spyBenchmarkEquity();

    insertPortfolioSnapshot(this.db, {
      totalValue,
      senatorSleeveValue: sleeveValue("senator"),
      thirteenfSleeveValue: sleeveValue("13f"),
      cashValue,
      dailyPnl,
      dailyPnlRatio,
      cumulativePnl,
      drawdownUsd,
      spyEquity,
      openPositions: localPositions.length,
      highWaterMark
    });
    logger.info({ totalValue, dailyPnl, dailyPnlRatio, spyEquity, openPositions: localPositions.length }, "portfolio snapshot stored");
  }

  /**
   * $100k SPY buy-and-hold benchmark: the share count is fixed at the first
   * snapshot that sees a SPY price (persisted in app_state) and thereafter
   * spy_equity = shares × latest SPY price.
   */
  private async spyBenchmarkEquity(): Promise<number | null> {
    if (!this.prices) return null;
    try {
      const latest = await this.prices.getLatestCloses("SPY");
      const spyPrice = latest?.currentPrice;
      if (!spyPrice || spyPrice <= 0) return null;
      let shares = Number(getAppState(this.db, SPY_BENCHMARK_SHARES_KEY));
      if (!Number.isFinite(shares) || shares <= 0) {
        shares = INITIAL_CAPITAL_USD / spyPrice;
        setAppState(this.db, SPY_BENCHMARK_SHARES_KEY, String(shares));
        logger.info({ shares, spyPrice }, "SPY benchmark share count fixed");
      }
      return shares * spyPrice;
    } catch (error) {
      logger.warn({ error }, "SPY benchmark price unavailable; spy_equity null for this snapshot");
      return null;
    }
  }

  private accountStop(account: AlpacaAccount): RiskCheck | null {
    if (account.trading_blocked || account.account_blocked) return { allowed: false, reason: "Alpaca account is blocked" };
    const equity = money(account.equity);
    const totalValue = money(account.portfolio_value);
    if (equity > 0 && totalValue / equity > 1.3) return { allowed: false, reason: "margin utilization above 130%" };
    return null;
  }

  private circuitBreaker(account: AlpacaAccount, decision?: SignalDecision): RiskCheck {
    const equity = money(account.equity);
    const startOfDay = this.startOfDayValue();
    if (startOfDay && startOfDay > 0 && (startOfDay - equity) / startOfDay >= 0.03) {
      return { allowed: false, reason: "daily drawdown circuit breaker active" };
    }

    const weeklyStart = this.snapshotValueSince("-7 days");
    if (weeklyStart && weeklyStart > 0 && (weeklyStart - equity) / weeklyStart >= 0.07) {
      return { allowed: false, reason: "weekly drawdown circuit breaker active" };
    }

    const latest = latestPortfolioSnapshot(this.db);
    if (latest?.high_water_mark && (latest.high_water_mark - equity) / latest.high_water_mark >= 0.15) {
      return { allowed: false, reason: "monthly high-water drawdown circuit breaker active" };
    }

    const losingTrades = this.db
      .prepare(
        `SELECT pnl_usd
         FROM stock_positions
         WHERE status = 'closed' AND pnl_usd IS NOT NULL
         ORDER BY closed_at DESC
         LIMIT 5`
      )
      .all() as { pnl_usd: number }[];
    if (losingTrades.length === 5 && losingTrades.every((trade) => trade.pnl_usd < 0)) {
      const lastLoss = this.db
        .prepare("SELECT closed_at FROM stock_positions WHERE status = 'closed' AND pnl_usd < 0 ORDER BY closed_at DESC LIMIT 1")
        .get() as { closed_at: string } | undefined;
      const pauseExpiry = lastLoss ? new Date(lastLoss.closed_at).getTime() + 6 * 60 * 60 * 1000 : 0;
      if (Date.now() < pauseExpiry) return { allowed: false, reason: "5 consecutive losses — 6h pause active" };
    }

    const positions = openStockPositions(this.db);
    const senatorCount = positions.filter((p) => p.sleeve === "senator").length;
    const thirteenfCount = positions.filter((p) => p.sleeve === "13f").length;
    if (decision?.sleeve === "senator" && senatorCount >= 25) return { allowed: false, reason: "max 25 senator positions reached" };
    if (decision?.sleeve === "13f" && thirteenfCount >= 15) return { allowed: false, reason: "max 15 13F positions reached" };

    return { allowed: true };
  }

  private portfolioHeat(totalValue: number) {
    if (totalValue <= 0) return 0;
    return openStockPositions(this.db).reduce((sum, position) => {
      const valuePct = positionValue(position) / totalValue;
      const stopDistance = position.stopLossPrice ? Math.max(0, (position.avgEntryPrice - position.stopLossPrice) / position.avgEntryPrice) : 0;
      return sum + valuePct * stopDistance;
    }, 0);
  }

  private startOfDayValue() {
    const row = this.db
      .prepare(
        `SELECT total_value
         FROM portfolio_snapshots
         WHERE date(snapshot_at) = date('now')
         ORDER BY snapshot_at ASC
         LIMIT 1`
      )
      .get() as { total_value: number } | undefined;
    return row?.total_value ?? null;
  }

  private snapshotValueSince(modifier: string) {
    const row = this.db
      .prepare(
        `SELECT total_value
         FROM portfolio_snapshots
         WHERE snapshot_at >= datetime('now', ?)
         ORDER BY snapshot_at ASC
         LIMIT 1`
      )
      .get(modifier) as { total_value: number } | undefined;
    return row?.total_value ?? null;
  }
}

function money(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function positionValue(position: { quantity: number; currentPrice?: number | null; avgEntryPrice: number }) {
  return position.quantity * (position.currentPrice ?? position.avgEntryPrice);
}
