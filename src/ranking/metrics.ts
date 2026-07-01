import type Database from "better-sqlite3";
import type { RankingMetrics } from "../types.js";
import type { PriceCache } from "../prices/price-cache.js";

type TradeRow = {
  id: number;
  politician_id: number;
  ticker: string;
  trade_date: string;
  direction: "buy" | "sell";
};

type RoundTrip = {
  ticker: string;
  buyDate: string;
  sellDate: string;
  holdDays: number;
};

const FALLBACK_HOLD_DAYS = 30;
const MIN_ROUND_TRIPS = 5;

export async function calculateMetrics(db: Database.Database, prices: PriceCache): Promise<RankingMetrics[]> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);

  const rows = db
    .prepare(
      `SELECT id, politician_id, ticker, trade_date, direction
       FROM trades
       WHERE ticker IS NOT NULL AND trade_date >= ? AND direction IN ('buy', 'sell')
       ORDER BY trade_date ASC`
    )
    .all(cutoff.toISOString().slice(0, 10)) as TradeRow[];

  const grouped = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = `${row.politician_id}|${row.ticker}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(row);
    grouped.set(key, bucket);
  }

  const tripsByPolitician = new Map<number, RoundTrip[]>();

  for (const [key, trades] of grouped) {
    const politicianId = Number(key.split("|")[0]);
    const ticker = key.split("|").slice(1).join("|");
    const buys = trades.filter((t) => t.direction === "buy");
    const sells = trades.filter((t) => t.direction === "sell");
    const usedSells = new Set<number>();

    for (const buy of buys) {
      const buyTime = new Date(`${buy.trade_date}T00:00:00Z`).getTime();
      const matchedSell = sells.find((s) => {
        if (usedSells.has(s.id)) return false;
        return new Date(`${s.trade_date}T00:00:00Z`).getTime() >= buyTime;
      });

      let sellDate: string;
      let holdDays: number;
      if (matchedSell) {
        usedSells.add(matchedSell.id);
        sellDate = matchedSell.trade_date;
        holdDays = Math.max(1, Math.round((new Date(`${sellDate}T00:00:00Z`).getTime() - buyTime) / 86_400_000));
      } else {
        sellDate = addDays(buy.trade_date, FALLBACK_HOLD_DAYS);
        holdDays = FALLBACK_HOLD_DAYS;
      }

      const trips = tripsByPolitician.get(politicianId) ?? [];
      trips.push({ ticker, buyDate: buy.trade_date, sellDate, holdDays });
      tripsByPolitician.set(politicianId, trips);
    }
  }

  const chamberRows = db.prepare("SELECT id, chamber FROM politicians").all() as Array<{ id: number; chamber: string | null }>;
  const chamberById = new Map(chamberRows.map((row) => [row.id, row.chamber]));

  const results: RankingMetrics[] = [];

  for (const [politicianId, trips] of tripsByPolitician) {
    if (trips.length < MIN_ROUND_TRIPS) continue;

    const alphas: number[] = [];
    const recencies: number[] = [];
    let totalHoldDays = 0;

    for (const trip of trips) {
      const [entry, exit, spyEntry, spyExit] = await Promise.all([
        prices.getClose(trip.ticker, trip.buyDate),
        prices.getClose(trip.ticker, trip.sellDate),
        prices.getClose("SPY", trip.buyDate),
        prices.getClose("SPY", trip.sellDate)
      ]);
      if (!entry || !exit || !spyEntry || !spyExit) continue;

      const stockReturn = exit / entry - 1;
      const spyReturn = spyExit / spyEntry - 1;
      alphas.push(stockReturn - spyReturn);
      totalHoldDays += trip.holdDays;

      const ageDays = (Date.now() - new Date(`${trip.buyDate}T00:00:00Z`).getTime()) / 86_400_000;
      recencies.push(Math.exp((-Math.log(2) * ageDays) / 182.5));
    }

    if (alphas.length < MIN_ROUND_TRIPS) continue;

    const gains = alphas.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const losses = Math.abs(alphas.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const rawAlpha = mean(alphas);
    const avgHold = totalHoldDays / alphas.length;
    const annualizedAlpha = rawAlpha * (365 / avgHold);
    const std = standardDeviation(alphas);

    results.push({
      politicianId,
      chamber: chamberById.get(politicianId) ?? null,
      alpha: annualizedAlpha,
      winRate: alphas.filter((v) => v > 0).length / alphas.length,
      sharpe: std === 0 ? 0 : rawAlpha / std,
      profitFactor: losses === 0 ? gains || 0 : gains / losses,
      tradeCount: alphas.length,
      recencyBonus: mean(recencies)
    });
  }

  return results;
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function mean(values: number[]) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function standardDeviation(values: number[]) {
  const avg = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length);
}
