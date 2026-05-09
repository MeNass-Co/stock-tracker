import type Database from "better-sqlite3";
import { openStockPositions } from "../db/queries.js";
import type { ExecutionSleeve, StockPosition } from "../types.js";
import type { AlpacaAccount } from "./alpaca-client.js";
import type { SignalDecision } from "./signal-filter.js";

export interface SizeResult {
  allowed: boolean;
  reason: string;
  amountUsd: number;
  quantity: number;
  notional: number;
  sizePct: number;
}

export class PositionSizer {
  constructor(private readonly db: Database.Database) {}

  calculate(decision: SignalDecision, account: AlpacaAccount, currentPrice?: number | null): SizeResult {
    const totalValue = parseMoney(account.portfolio_value);
    const cash = parseMoney(account.cash);
    if (totalValue <= 0) return denied("portfolio value is unavailable");

    const sleeveValue = decision.sleeve === "senator" ? totalValue * 0.6 : totalValue * 0.3;
    const slice = typeof decision.metadata?.dailyFraction === "number" ? decision.metadata.dailyFraction : 1;
    const baseAmount = (decision.sleeve === "senator" ? this.senatorBase(decision, sleeveValue) : this.thirteenFBase(decision, sleeveValue)) * slice;
    const hardCapped = this.applyHardCaps(baseAmount, decision, totalValue, cash);
    if (hardCapped.amountUsd < 1) return denied(hardCapped.reason);

    const price = currentPrice && currentPrice > 0 ? currentPrice : 0;
    return {
      allowed: true,
      reason: hardCapped.reason,
      amountUsd: roundCurrency(hardCapped.amountUsd),
      quantity: price > 0 ? hardCapped.amountUsd / price : 0,
      notional: roundCurrency(hardCapped.amountUsd),
      sizePct: hardCapped.amountUsd / totalValue
    };
  }

  private senatorBase(decision: SignalDecision, senatorSleeveValue: number) {
    let amount = senatorSleeveValue * 0.025;
    const rank = decision.senatorRank ?? 99;
    if (rank <= 5) amount *= 1.5;
    else if (rank <= 10) amount *= 1.25;
    if (decision.boosts.includes("committee_aligned")) amount *= 1.3;
    if (decision.boosts.includes("repeat_buy")) amount *= 1.3;
    if (decision.boosts.includes("cluster")) amount *= 1.5;
    const delayDays = typeof decision.metadata?.filingDelayDays === "number" ? decision.metadata.filingDelayDays : 0;
    if (delayDays > 0) amount *= Math.max(0.25, 1 - delayDays / 50);
    return amount;
  }

  private thirteenFBase(decision: SignalDecision, thirteenfSleeveValue: number) {
    const fundSignalCount = Number(decision.metadata?.fundSignalCount ?? 1);
    const fundName = (decision.fundName ?? "").toLowerCase();
    if (fundName.includes("berkshire") || fundName.includes("buffett")) return thirteenfSleeveValue * 0.05;
    if (fundSignalCount >= 3) return thirteenfSleeveValue * 0.05;
    if (fundSignalCount === 2) return thirteenfSleeveValue * 0.03;
    return thirteenfSleeveValue * 0.02;
  }

  private applyHardCaps(amount: number, decision: SignalDecision, totalValue: number, cash: number) {
    const positions = openStockPositions(this.db);
    const maxSinglePosition = totalValue * 0.05;
    const maxSameTicker = totalValue * 0.05;
    const maxSingleSenator = totalValue * 0.15;
    const maxSector = totalValue * 0.25;
    const minCashAfterTrade = totalValue * 0.1;

    let adjusted = Math.min(amount, maxSinglePosition);
    const reasons = adjusted < amount ? ["single position cap"] : [];

    adjusted = capByExposure(adjusted, maxSameTicker, exposureFor(positions, (position) => position.ticker === decision.ticker), reasons, "same ticker cap");

    if (decision.sleeve === "senator" && decision.senatorName) {
      adjusted = capByExposure(
        adjusted,
        maxSingleSenator,
        exposureFor(positions, (position) => position.senatorName === decision.senatorName),
        reasons,
        "single senator cap"
      );
    }

    const sector = typeof decision.metadata?.sector === "string" ? decision.metadata.sector : null;
    if (sector) {
      adjusted = capByExposure(adjusted, maxSector, exposureFor(positions, (position) => position.sector === sector), reasons, "sector cap");
    }

    const cashAvailable = Math.max(0, cash - minCashAfterTrade);
    if (adjusted > cashAvailable) {
      adjusted = cashAvailable;
      reasons.push("cash reserve cap");
    }

    return {
      amountUsd: Math.max(0, adjusted),
      reason: reasons.length > 0 ? `reduced by ${Array.from(new Set(reasons)).join(", ")}` : "base size accepted"
    };
  }
}

function exposureFor(positions: StockPosition[], predicate: (position: StockPosition) => boolean) {
  return positions.filter(predicate).reduce((sum, position) => sum + positionValue(position), 0);
}

function capByExposure(amount: number, cap: number, currentExposure: number, reasons: string[], reason: string) {
  const room = Math.max(0, cap - currentExposure);
  if (amount > room) {
    reasons.push(reason);
    return room;
  }
  return amount;
}

function positionValue(position: StockPosition) {
  const price = position.currentPrice ?? position.avgEntryPrice;
  return Math.max(0, position.quantity * price);
}

function parseMoney(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function denied(reason: string): SizeResult {
  return { allowed: false, reason, amountUsd: 0, quantity: 0, notional: 0, sizePct: 0 };
}
