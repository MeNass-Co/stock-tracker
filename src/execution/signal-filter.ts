import type Database from "better-sqlite3";
import { activeWashSale } from "../db/queries.js";
import type { ExecutionDirection, ExecutionSleeve, ExecutionTriggerType, FundHoldingInput, NormalizedTrade } from "../types.js";
import { logger } from "../utils/logger.js";
import { AlpacaClient } from "./alpaca-client.js";

const BROAD_ETF_BLOCKLIST = new Set([
  "SPY",
  "QQQ",
  "VOO",
  "VTI",
  "IWM",
  "DIA",
  "IVV",
  "VEA",
  "VWO",
  "EFA",
  "EEM",
  "AGG",
  "BND",
  "TLT",
  "GLD",
  "SLV"
]);

const SENSITIVE_SELL_COMMITTEES = ["intelligence", "armed services"];

export interface SignalDecision {
  copy: boolean;
  reason: string;
  sleeve: ExecutionSleeve;
  priority: number;
  boosts: string[];
  direction: ExecutionDirection;
  ticker: string;
  triggerType: ExecutionTriggerType;
  triggerId?: number | null;
  senatorName?: string | null;
  senatorRank?: number | null;
  fundName?: string | null;
  metadata?: Record<string, unknown>;
}

type TradeWithOptionalId = NormalizedTrade & { id?: number };

export class SignalFilter {
  constructor(
    private readonly db: Database.Database,
    private readonly alpaca = new AlpacaClient()
  ) {}

  async evaluateTrade(trade: TradeWithOptionalId): Promise<SignalDecision> {
    const ticker = trade.ticker?.toUpperCase();
    if (!ticker) return this.reject("missing ticker", "senator", "buy", "");
    if (trade.politician.chamber !== "senate") return this.reject("not a senator disclosure", "senator", "buy", ticker);
    if (trade.assetType !== "stock") return this.reject("not a stock trade", "senator", "buy", ticker);
    if (BROAD_ETF_BLOCKLIST.has(ticker)) return this.reject("broad ETF blocklisted", "senator", "buy", ticker);

    const amount = trade.amountMidpoint ?? 0;
    const sellException = this.isSensitiveCommittee(trade) && amount > 250_000;
    if (trade.direction !== "buy" && !(trade.direction === "sell" && sellException)) {
      return this.reject("senator signal is not a qualifying buy", "senator", "buy", ticker);
    }
    if (trade.direction === "buy" && amount < 50_000) return this.reject("amount midpoint below $50,000", "senator", "buy", ticker);

    const filingDelayDays = daysBetween(trade.tradeDate, trade.filingDate);
    if (filingDelayDays > 45) return this.reject("filing delay above 45 days", "senator", "buy", ticker);

    const rank = this.latestRankFor(trade.politician.name, trade.politician.chamber);
    if (rank === null || rank > 20) return this.reject("senator is not currently ranked top 20", "senator", "buy", ticker);

    if (this.isRetiringOrUnderInvestigation(trade)) return this.reject("senator flagged as retiring or under investigation", "senator", "buy", ticker);
    if (this.isManagedOrSpouseOnly(trade)) return this.reject("spouse-only, blind trust, or managed account trade", "senator", "buy", ticker);

    const washSale = activeWashSale(this.db, ticker);
    if (washSale) return this.reject(`wash sale cooldown until ${washSale.cooldown_until}`, "senator", "buy", ticker);

    const marketCap = numberFromRaw(trade.rawData, ["marketCap", "market_cap"]);
    if (marketCap !== null && marketCap < 1_000_000_000) return this.reject("market cap below $1B", "senator", "buy", ticker);

    const earningsDate = stringFromRaw(trade.rawData, ["earningsDate", "earnings_date"]);
    if (earningsDate && Math.abs(daysBetween(new Date().toISOString().slice(0, 10), earningsDate)) <= 5) {
      return this.reject("within 5 days of earnings", "senator", "buy", ticker);
    }

    const asset = await this.safeGetAsset(ticker);
    if (!asset?.tradable || asset.status !== "active" || !asset.fractionable) {
      return this.reject("ticker is not active, tradable, and fractionable on Alpaca", "senator", "buy", ticker);
    }

    const boosts = this.senatorBoosts(trade);
    const priority = Math.min(10, 5 + boosts.length + (rank <= 5 ? 2 : rank <= 10 ? 1 : 0) + (sellException ? 2 : 0));
    return {
      copy: true,
      reason: sellException ? "sensitive committee sell exception passed" : "senator copy gates passed",
      sleeve: "senator",
      priority,
      boosts,
      direction: trade.direction === "sell" ? "sell" : "buy",
      ticker,
      triggerType: "senator_trade",
      triggerId: trade.id ?? null,
      senatorName: trade.politician.name,
      senatorRank: rank,
      metadata: { amountMidpoint: amount, filingDelayDays, sector: stringFromRaw(trade.rawData, ["sector", "gicsSector", "gics_sector"]) }
    };
  }

  async evaluate13FDiff(holding: FundHoldingInput): Promise<SignalDecision> {
    const ticker = holding.ticker?.toUpperCase();
    if (!ticker) return this.reject("missing ticker", "13f", "buy", "");
    if (BROAD_ETF_BLOCKLIST.has(ticker)) return this.reject("broad ETF blocklisted", "13f", "buy", ticker);
    if (holding.putCall === "PUT") return this.reject("put position — bearish bet, skip", "13f", "buy", ticker);
    if (activeWashSale(this.db, ticker)) return this.reject("wash sale cooldown", "13f", "buy", ticker);

    const portfolioNameCount = this.db
      .prepare("SELECT count(DISTINCT cusip) AS count FROM fund_holdings WHERE fund_cik = ? AND report_date = ?")
      .get(holding.fundCik, holding.reportDate) as { count: number };
    if (portfolioNameCount.count >= 500) return this.reject("fund holds 500+ names", "13f", "buy", ticker);

    const changeType = holding.changeType;
    const changePct = holding.changePct ?? 0;
    let direction: ExecutionDirection | null = null;
    if (changeType === "new" || (changeType === "increase" && changePct >= 0.25)) direction = "buy";
    if (changeType === "exit" || (changeType === "decrease" && Math.abs(changePct) >= 0.25)) direction = "sell";
    if (!direction) return this.reject("13F change is not actionable", "13f", "buy", ticker);

    const asset = await this.safeGetAsset(ticker);
    if (!asset?.tradable || asset.status !== "active" || !asset.fractionable) {
      return this.reject("ticker is not active, tradable, and fractionable on Alpaca", "13f", direction, ticker);
    }

    const priority = direction === "sell" ? 9 : changeType === "new" ? 7 : 6;
    return {
      copy: true,
      reason: "13F action gates passed",
      sleeve: "13f",
      priority,
      boosts: [],
      direction,
      ticker,
      triggerType: "13f_diff",
      fundName: holding.fundName,
      metadata: {
        fundCik: holding.fundCik,
        reportDate: holding.reportDate,
        filingDate: holding.filingDate,
        changeType,
        changePct,
        valueThousands: holding.valueThousands
      }
    };
  }

  private senatorBoosts(trade: NormalizedTrade) {
    const boosts: string[] = [];
    if (committeeAligned(trade)) boosts.push("committee_aligned");
    if (trade.ticker && this.hasRepeatBuy(trade)) boosts.push("repeat_buy");
    if (trade.ticker && this.hasClusterSignal(trade)) boosts.push("cluster");
    return boosts;
  }

  private hasRepeatBuy(trade: NormalizedTrade) {
    const row = this.db
      .prepare(
        `SELECT count(*) AS count
         FROM trades t
         JOIN politicians p ON p.id = t.politician_id
         WHERE p.name = ? AND p.chamber = ?
           AND t.ticker = ?
           AND t.direction = 'buy'
           AND date(t.trade_date) >= date(?, '-90 days')
           AND t.trade_date < ?`
      )
      .get(trade.politician.name, trade.politician.chamber, trade.ticker, trade.tradeDate, trade.tradeDate) as { count: number };
    return row.count > 0;
  }

  private hasClusterSignal(trade: NormalizedTrade) {
    const row = this.db
      .prepare(
        `SELECT count(DISTINCT p.name) AS count
         FROM trades t
         JOIN politicians p ON p.id = t.politician_id
         WHERE p.chamber = 'senate'
           AND t.ticker = ?
           AND t.direction = 'buy'
           AND date(t.trade_date) BETWEEN date(?, '-14 days') AND date(?, '+14 days')`
      )
      .get(trade.ticker, trade.tradeDate, trade.tradeDate) as { count: number };
    return row.count >= 3;
  }

  private isSensitiveCommittee(trade: NormalizedTrade) {
    const committees = (trade.politician.committees ?? []).map((committee) => committee.toLowerCase());
    return SENSITIVE_SELL_COMMITTEES.some((needle) => committees.some((committee) => committee.includes(needle)));
  }

  private isRetiringOrUnderInvestigation(trade: NormalizedTrade) {
    const text = rawText(trade.rawData).toLowerCase();
    return text.includes("retiring") || text.includes("under investigation");
  }

  private isManagedOrSpouseOnly(trade: NormalizedTrade) {
    const text = rawText(trade.rawData).toLowerCase();
    return text.includes("spouse") || text.includes("blind trust") || text.includes("managed account");
  }

  private latestRankFor(name: string, chamber: string) {
    const row = this.db
      .prepare(
        `SELECT r.rank_position
         FROM rankings r
         JOIN politicians p ON p.id = r.politician_id
         WHERE p.name = ? AND p.chamber = ?
           AND r.computed_at = (SELECT max(computed_at) FROM rankings)
         ORDER BY r.rank_position ASC
         LIMIT 1`
      )
      .get(name, chamber) as { rank_position: number } | undefined;
    return row?.rank_position ?? null;
  }

  private async safeGetAsset(ticker: string) {
    try {
      return await this.alpaca.getAsset(ticker);
    } catch (error) {
      logger.warn({ ticker, error }, "Alpaca asset lookup failed during signal filtering");
      return null;
    }
  }

  private reject(reason: string, sleeve: ExecutionSleeve, direction: ExecutionDirection, ticker: string): SignalDecision {
    logger.debug({ ticker, sleeve, reason }, "execution signal rejected");
    return { copy: false, reason, sleeve, priority: 0, boosts: [], direction, ticker, triggerType: sleeve === "senator" ? "senator_trade" : "13f_diff" };
  }
}

function committeeAligned(trade: NormalizedTrade) {
  const committees = (trade.politician.committees ?? []).join(" ").toLowerCase();
  const text = `${trade.assetName} ${trade.ticker ?? ""} ${rawText(trade.rawData)}`.toLowerCase();
  const pairs: Array<[string, string[]]> = [
    ["armed services", ["defense", "aerospace", "lockheed", "northrop", "raytheon", "general dynamics"]],
    ["health", ["health", "pharma", "biotech", "medical"]],
    ["banking", ["bank", "financial", "insurance", "capital"]],
    ["energy", ["energy", "oil", "gas", "utility", "solar"]],
    ["commerce", ["semiconductor", "software", "internet", "telecom", "transport"]],
    ["intelligence", ["cyber", "defense", "data", "satellite"]]
  ];
  return pairs.some(([committee, terms]) => committees.includes(committee) && terms.some((term) => text.includes(term)));
}

function daysBetween(left: string, right: string) {
  const leftTime = new Date(`${left.slice(0, 10)}T00:00:00Z`).getTime();
  const rightTime = new Date(`${right.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((rightTime - leftTime) / 86_400_000);
}

function rawText(rawData: unknown) {
  if (rawData === null || rawData === undefined) return "";
  if (typeof rawData === "string") return rawData;
  try {
    return JSON.stringify(rawData);
  } catch {
    return "";
  }
}

function numberFromRaw(rawData: unknown, keys: string[]) {
  if (!rawData || typeof rawData !== "object") return null;
  const record = rawData as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function stringFromRaw(rawData: unknown, keys: string[]) {
  if (!rawData || typeof rawData !== "object") return null;
  const record = rawData as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
