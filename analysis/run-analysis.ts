/**
 * Congressional copy-trading alpha study. Reads the live DB read-only and the
 * analysis price cache; writes analysis/results.json.
 *
 * Methodology (see REPORT.md):
 * - Entry = close of the FIRST trading day strictly AFTER filing_date
 *   (disclosure date) — the earliest a copier could act.
 * - Forward excess return vs SPY at +30/+90/+180 calendar days, exit at the
 *   first trading day on/after entry+N. Headline stats use FULL windows only
 *   (window end within price data); capped observations are counted but
 *   excluded from stats to avoid mixing horizons.
 * - Medians and 5/95-winsorized means, never raw means. Excess only.
 *
 * Usage: npx tsx analysis/run-analysis.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  CUSIP_TO_TICKER,
  ETF_CUSIPS,
  ROOT,
  Series,
  addDays,
  daysBetween,
  firstDateAfter,
  firstDateOnOrAfter,
  groupStats,
  loadSeries,
  openLiveDb,
  openPriceDb,
  round
} from "./lib.js";

const HORIZONS = [30, 90, 180] as const;
type Horizon = (typeof HORIZONS)[number];

const live = openLiveDb();
const priceDb = openPriceDb();

const spy = loadSeries(priceDb, "SPY");
if (!spy) throw new Error("SPY missing from price cache — run fetch-prices.ts first");
const DATA_END = spy.dates[spy.dates.length - 1];

const seriesCache = new Map<string, Series | null>();
function series(symbol: string): Series | null {
  if (!seriesCache.has(symbol)) seriesCache.set(symbol, loadSeries(priceDb, symbol));
  return seriesCache.get(symbol)!;
}

// ---------- load trades ----------

interface TradeRow {
  id: number;
  politician_id: number;
  name: string;
  chamber: string;
  party: string | null;
  ticker: string;
  trade_date: string;
  filing_date: string;
  direction: "buy" | "sell";
  amount_midpoint: number | null;
  amount_range: string | null;
}

const trades = live
  .prepare(
    `SELECT t.id, t.politician_id, p.name, p.chamber, p.party,
            upper(t.ticker) AS ticker, t.trade_date, t.filing_date, t.direction,
            t.amount_midpoint, t.amount_range
     FROM trades t JOIN politicians p ON p.id = t.politician_id
     WHERE t.ticker IS NOT NULL AND t.ticker != '' AND t.asset_type = 'stock'
       AND t.direction IN ('buy', 'sell')
     ORDER BY t.filing_date`
  )
  .all() as TradeRow[];

interface Observation extends TradeRow {
  entryDate: string;
  filingDelayDays: number;
  /** excess return vs SPY per horizon; undefined if window incomplete or prices missing */
  excess: Partial<Record<Horizon, number>>;
  cappedHorizons: Horizon[];
}

let noPriceData = 0;
let noEntry = 0;
const observations: Observation[] = [];

for (const trade of trades) {
  const sym = series(trade.ticker);
  if (!sym) {
    noPriceData++;
    continue;
  }
  const entryDate = firstDateAfter(sym, trade.filing_date);
  if (!entryDate || !spy.close.has(entryDate)) {
    noEntry++;
    continue;
  }
  const entryPx = sym.close.get(entryDate)!;
  const spyEntry = spy.close.get(entryDate)!;
  const obs: Observation = {
    ...trade,
    entryDate,
    filingDelayDays: daysBetween(trade.trade_date, trade.filing_date),
    excess: {},
    cappedHorizons: []
  };
  for (const h of HORIZONS) {
    const target = addDays(entryDate, h);
    if (target > DATA_END) {
      obs.cappedHorizons.push(h);
      continue; // incomplete window — excluded from stats
    }
    const exitDate = firstDateOnOrAfter(sym, target);
    if (!exitDate) {
      obs.cappedHorizons.push(h); // symbol series ended early (delisting/thin IEX data)
      continue;
    }
    const spyExit = spy.close.get(exitDate) ?? spy.close.get(firstDateOnOrAfter(spy, exitDate) ?? "");
    if (spyExit === undefined) {
      obs.cappedHorizons.push(h);
      continue;
    }
    const stockRet = sym.close.get(exitDate)! / entryPx - 1;
    const spyRet = spyExit / spyEntry - 1;
    obs.excess[h] = stockRet - spyRet;
  }
  observations.push(obs);
}

const buys = observations.filter((o) => o.direction === "buy");
const sells = observations.filter((o) => o.direction === "sell");

// ---------- aggregation helpers ----------

function statsByHorizon(rows: Observation[]) {
  const out: Record<string, ReturnType<typeof groupStats>> = {};
  for (const h of HORIZONS) {
    out[`h${h}`] = groupStats(rows.map((o) => o.excess[h]).filter((v): v is number => v !== undefined));
  }
  return out;
}

function aggregateBy<K extends string>(rows: Observation[], key: (o: Observation) => K) {
  const groups = new Map<K, Observation[]>();
  for (const row of rows) {
    const k = key(row);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(row);
  }
  return Object.fromEntries([...groups.entries()].map(([k, v]) => [k, statsByHorizon(v)]));
}

const amountBucket = (o: Observation): string => {
  const amt = o.amount_midpoint ?? 0;
  if (amt < 15_000) return "<$15k";
  if (amt < 50_000) return "$15k-50k";
  if (amt < 100_000) return "$50k-100k";
  if (amt < 250_000) return "$100k-250k";
  return ">$250k";
};

const delayBucket = (o: Observation): string => {
  if (o.filingDelayDays <= 15) return "<=15d";
  if (o.filingDelayDays <= 30) return "15-30d";
  return ">30d";
};

// ---------- per-politician (buys, n >= 8) ----------

const byPolitician = new Map<number, Observation[]>();
for (const buy of buys) (byPolitician.get(buy.politician_id) ?? byPolitician.set(buy.politician_id, []).get(buy.politician_id)!).push(buy);

const politicianStats = [...byPolitician.entries()]
  .map(([id, rows]) => ({
    politicianId: id,
    name: rows[0].name,
    chamber: rows[0].chamber,
    party: rows[0].party,
    nBuys: rows.length,
    medianFilingDelayDays: round(
      rows.map((o) => o.filingDelayDays).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
      1
    ),
    ...statsByHorizon(rows)
  }))
  .sort((a, b) => (b.h90.medianExcess ?? -1) - (a.h90.medianExcess ?? -1));

// ---------- filter comparison (what should the live signal-filter gate on?) ----------

const filterComparison = {
  note: "Approximation of live SignalFilter gates on the historical buy sample (rank/committee/wash-sale gates not reproducible historically).",
  allBuys: statsByHorizon(buys),
  liveGates_amount15k_delay45: statsByHorizon(buys.filter((o) => (o.amount_midpoint ?? 0) >= 15_000 && o.filingDelayDays <= 45)),
  proposed_amount15k_delay15: statsByHorizon(buys.filter((o) => (o.amount_midpoint ?? 0) >= 15_000 && o.filingDelayDays <= 15)),
  proposed_amount15k_delay15_senateOnly: statsByHorizon(
    buys.filter((o) => (o.amount_midpoint ?? 0) >= 15_000 && o.filingDelayDays <= 15 && o.chamber === "senate")
  ),
  delay15_anyAmount: statsByHorizon(buys.filter((o) => o.filingDelayDays <= 15))
};

// ---------- ranking validation A: live ranking history ----------

interface RankRow {
  computed_at: string;
  politician_id: number;
  rank_position: number;
}
const rankRows = live
  .prepare("SELECT computed_at, politician_id, rank_position FROM rankings ORDER BY computed_at")
  .all() as RankRow[];
const runDates = [...new Set(rankRows.map((r) => r.computed_at))].sort();
const firstRunDate = runDates[0];
const runMembers = new Map<string, Set<number>>();
for (const row of rankRows) {
  if (row.rank_position > 15) continue;
  (runMembers.get(row.computed_at) ?? runMembers.set(row.computed_at, new Set()).get(row.computed_at)!).add(row.politician_id);
}
function latestRunBefore(filingDate: string): string | null {
  const cutoff = `${filingDate}T23:59:59Z`;
  let best: string | null = null;
  for (const d of runDates) {
    if (d <= cutoff) best = d;
    else break;
  }
  return best;
}
const postRankingBuys = buys.filter((o) => o.filing_date > firstRunDate.slice(0, 10));
const rankedBuys: Observation[] = [];
const unrankedBuys: Observation[] = [];
for (const buy of postRankingBuys) {
  const run = latestRunBefore(buy.filing_date);
  if (!run) continue;
  (runMembers.get(run)?.has(buy.politician_id) ? rankedBuys : unrankedBuys).push(buy);
}

// ---------- ranking validation B: split-sample ----------

const sortedFilings = buys.map((o) => o.filing_date).sort();
const splitDate = sortedFilings[Math.floor(sortedFilings.length / 2)];
const firstHalf = buys.filter((o) => o.filing_date < splitDate);
const secondHalf = buys.filter((o) => o.filing_date >= splitDate);
const firstHalfByPol = new Map<number, number[]>();
for (const buy of firstHalf) {
  const v = buy.excess[90];
  if (v === undefined) continue;
  (firstHalfByPol.get(buy.politician_id) ?? firstHalfByPol.set(buy.politician_id, []).get(buy.politician_id)!).push(v);
}
const eligible = [...firstHalfByPol.entries()].filter(([, v]) => v.length >= 5);
const rankedByMedian = eligible
  .map(([id, values]) => ({ id, med: values.sort((a, b) => a - b)[Math.floor(values.length / 2)] }))
  .sort((a, b) => b.med - a.med);
const topHalfIds = new Set(rankedByMedian.slice(0, Math.ceil(rankedByMedian.length / 2)).map((r) => r.id));
const bottomHalfIds = new Set(rankedByMedian.slice(Math.ceil(rankedByMedian.length / 2)).map((r) => r.id));
const secondHalfTop = secondHalf.filter((o) => topHalfIds.has(o.politician_id));
const secondHalfBottom = secondHalf.filter((o) => bottomHalfIds.has(o.politician_id));
const secondHalfOther = secondHalf.filter((o) => !topHalfIds.has(o.politician_id) && !bottomHalfIds.has(o.politician_id));

// ---------- 13F conviction sleeve backtest ----------

interface HoldingRow {
  fund_cik: string;
  fund_name: string;
  report_date: string;
  filing_date: string;
  cusip: string;
  value_thousands: number;
}
const holdings = live
  .prepare(
    `SELECT fund_cik, fund_name, report_date, max(filing_date) OVER (PARTITION BY report_date) AS filing_date,
            cusip, value_thousands
     FROM fund_holdings WHERE report_date >= '2025-12-31'`
  )
  .all() as HoldingRow[];

function convictionPortfolio(reportDate: string): { weights: Map<string, number>; tradeableFrom: string; unmappedTop: string[] } {
  const rows = holdings.filter((h) => h.report_date === reportDate);
  const filingDate = rows[0].filing_date;
  const byFund = new Map<string, HoldingRow[]>();
  for (const row of rows) (byFund.get(row.fund_cik) ?? byFund.set(row.fund_cik, []).get(row.fund_cik)!).push(row);
  const conviction = new Map<string, number>();
  const unmappedTop: string[] = [];
  for (const fundRows of byFund.values()) {
    const top = fundRows
      .filter((h) => !ETF_CUSIPS.has(h.cusip))
      .sort((a, b) => b.value_thousands - a.value_thousands)
      .slice(0, 5);
    for (const h of top) {
      const ticker = CUSIP_TO_TICKER[h.cusip];
      if (!ticker) {
        unmappedTop.push(`${h.cusip} (${h.fund_name})`);
        continue;
      }
      conviction.set(ticker, (conviction.get(ticker) ?? 0) + 1);
    }
  }
  const total = [...conviction.values()].reduce((s, v) => s + v, 0);
  const weights = new Map([...conviction.entries()].map(([t, c]) => [t, c / total]));
  return { weights, tradeableFrom: filingDate, unmappedTop };
}

function legReturn(weights: Map<string, number>, entryAfter: string, exitOn: string) {
  let portfolio = 0;
  let coveredWeight = 0;
  const legs: Array<{ ticker: string; weight: number; ret: number | null }> = [];
  for (const [ticker, weight] of weights) {
    const sym = series(ticker);
    const entryDate = sym ? firstDateAfter(sym, entryAfter) : null;
    const exitDate = sym ? [...sym.dates].reverse().find((d) => d <= exitOn) ?? null : null;
    if (!sym || !entryDate || !exitDate || exitDate <= entryDate) {
      legs.push({ ticker, weight: round(weight)!, ret: null });
      continue;
    }
    const ret = sym.close.get(exitDate)! / sym.close.get(entryDate)! - 1;
    portfolio += weight * ret;
    coveredWeight += weight;
    legs.push({ ticker, weight: round(weight)!, ret: round(ret)! });
  }
  const spyEntryDate = firstDateAfter(spy, entryAfter)!;
  const spyExitDate = [...spy.dates].reverse().find((d) => d <= exitOn)!;
  const spyRet = spy.close.get(spyExitDate)! / spy.close.get(spyEntryDate)! - 1;
  // renormalize to covered weight so missing symbols don't read as 0% return
  const portfolioRet = coveredWeight > 0 ? portfolio / coveredWeight : 0;
  return { portfolioRet, spyRet, coveredWeight, entryDate: spyEntryDate, exitDate: spyExitDate, legs };
}

const q4 = convictionPortfolio("2025-12-31");
const q1 = convictionPortfolio("2026-03-31");
const leg1 = legReturn(q4.weights, q4.tradeableFrom, q1.tradeableFrom);
const leg2 = legReturn(q1.weights, q1.tradeableFrom, DATA_END);
const allTickers = new Set([...q4.weights.keys(), ...q1.weights.keys()]);
let turnover = 0;
for (const t of allTickers) turnover += Math.abs((q1.weights.get(t) ?? 0) - (q4.weights.get(t) ?? 0));
turnover /= 2;
const sleeveCum = (1 + leg1.portfolioRet) * (1 + leg2.portfolioRet) - 1;
const spyCum = (1 + leg1.spyRet) * (1 + leg2.spyRet) - 1;

// ---------- assemble ----------

const results = {
  meta: {
    generatedAt: new Date().toISOString(),
    dataEnd: DATA_END,
    tradesConsidered: trades.length,
    observationsWithEntry: observations.length,
    droppedNoPriceData: noPriceData,
    droppedNoEntryDate: noEntry,
    horizonsCalendarDays: HORIZONS,
    entryRule: "close of first trading day strictly after filing_date",
    benchmark: "SPY (IEX feed, adjusted)",
    statsRule: "full windows only; median + 5/95 winsorized mean; excess vs SPY"
  },
  overall: {
    buys: statsByHorizon(buys),
    sells: statsByHorizon(sells)
  },
  byChamber: {
    buys: aggregateBy(buys, (o) => o.chamber),
    sells: aggregateBy(sells, (o) => o.chamber)
  },
  byAmountBucket: aggregateBy(buys, amountBucket),
  byFilingDelayBucket: aggregateBy(buys, delayBucket),
  filterComparison,
  bySector: "not available — trades table has no sector column and raw_data carries no sector field",
  perPolitician: {
    minN: 8,
    all: politicianStats,
    shown: politicianStats.filter((p) => p.nBuys >= 8)
  },
  rankingValidation: {
    liveRankingTest: {
      note:
        "Rankings history starts " +
        firstRunDate +
        "; only buys FILED after that date qualify, and only the +30d horizon has complete windows. Thin — treat as directional only.",
      firstRunDate,
      nPostRankingBuys: postRankingBuys.length,
      rankedTop15: statsByHorizon(rankedBuys),
      notRanked: statsByHorizon(unrankedBuys)
    },
    splitSampleTest: {
      note: "Politicians ranked on first-half median +90d excess (min 5 obs); performance measured on second-half buys.",
      splitDate,
      nEligiblePoliticians: rankedByMedian.length,
      topHalf: { politicians: rankedByMedian.slice(0, Math.ceil(rankedByMedian.length / 2)).length, ...statsByHorizon(secondHalfTop) },
      bottomHalf: { politicians: bottomHalfIds.size, ...statsByHorizon(secondHalfBottom) },
      notEligible: statsByHorizon(secondHalfOther)
    }
  },
  thirteenF: {
    snapshots: ["2025-12-31 (filed 2026-02-17)", "2026-03-31 (filed 2026-05-15)"],
    excluded: "Greenlight Capital (single stale 2023-12-31 snapshot); index ETFs",
    unmappedTopPositions: { q4: q4.unmappedTop, q1: q1.unmappedTop },
    policy: "top-5 non-ETF positions per fund by weight, conviction-weighted (weight ∝ number of funds), rebalance first trading day after each 13F filing",
    q4Portfolio: Object.fromEntries([...q4.weights.entries()].map(([t, w]) => [t, round(w)])),
    q1Portfolio: Object.fromEntries([...q1.weights.entries()].map(([t, w]) => [t, round(w)])),
    leg1: { window: `${leg1.entryDate}..${leg1.exitDate}`, sleeve: round(leg1.portfolioRet), spy: round(leg1.spyRet), coveredWeight: round(leg1.coveredWeight), legs: leg1.legs },
    leg2: { window: `${leg2.entryDate}..${leg2.exitDate}`, sleeve: round(leg2.portfolioRet), spy: round(leg2.spyRet), coveredWeight: round(leg2.coveredWeight), legs: leg2.legs },
    cumulative: { sleeve: round(sleeveCum), spy: round(spyCum), excess: round(sleeveCum - spyCum) },
    turnoverAtRebalance: round(turnover)
  }
};

const outPath = path.join(ROOT, "analysis", "results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`wrote ${outPath}`);
console.log(JSON.stringify(results.overall, null, 2));
console.log(JSON.stringify(results.rankingValidation, null, 2));
console.log(JSON.stringify(results.thirteenF.cumulative, null, 2));

live.close();
priceDb.close();
