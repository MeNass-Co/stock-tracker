/**
 * Shared helpers for the alpha analysis. READ-ONLY on the live DB.
 */
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const LIVE_DB_PATH = path.join(ROOT, "data", "stocktracker.db");
export const PRICE_DB_PATH = path.join(ROOT, "data", "analysis-prices.sqlite");

/** Live DB, strictly read-only (the service runs against it). */
export function openLiveDb(): Database.Database {
  return new Database(LIVE_DB_PATH, { readonly: true, fileMustExist: true });
}

/** Price cache DB (ours, writable). */
export function openPriceDb(): Database.Database {
  const db = new Database(PRICE_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close REAL NOT NULL,
      PRIMARY KEY (symbol, date)
    );
    CREATE TABLE IF NOT EXISTS fetch_log (
      symbol TEXT PRIMARY KEY,
      status TEXT NOT NULL,          -- 'ok' | 'empty' | 'error'
      bar_count INTEGER NOT NULL DEFAULT 0,
      first_date TEXT,
      last_date TEXT,
      fetched_at TEXT NOT NULL
    );
  `);
  return db;
}

/** CUSIP -> ticker for the 13F conviction sleeve (top holdings only; ETFs intentionally omitted). */
export const CUSIP_TO_TICKER: Record<string, string> = {
  "01609W102": "BABA",
  "02079K107": "GOOGL",
  "02079K305": "GOOG",
  "023135106": "AMZN",
  "595112103": "MU",
  "30303M102": "META",
  "874039100": "TSM",
  "67066G104": "NVDA",
  "963320106": "WHR",
  "90353T100": "UBER",
  "92840M102": "VST",
  "76131D103": "QSR",
  G96629103: "WTW",
  "036752103": "ELV",
  "907818108": "UNP",
  "95082P105": "WCC",
  "31488V107": "FERG",
  "674599105": "OXY",
  H1467J104: "CB",
  "500754106": "KHC",
  "615369105": "MCO",
  "829933100": "SIRI",
  "92343E102": "VRSN",
  "21036P108": "STZ",
  "166764100": "CVX",
  "247361702": "DAL",
  "632307104": "NTRA",
  "457669307": "INSM",
  "881624209": "TEVA",
  "980745103": "WWD",
  "22266T109": "CPNG",
  "984245100": "YPF",
  G0896C103: "TBBB",
  "013872106": "AA",
  "11271J107": "BN",
  "44267T102": "HHH",
  "594918104": "MSFT",
  "812215200": "SEG"
};

/** Index-ETF CUSIP prefixes we exclude from the 13F conviction sleeve (mirrors live blocklist spirit). */
export const ETF_CUSIPS = new Set(["46137V357", "464286400", "464286772"]);

// ---------- stats ----------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/** Mean after clamping to the 5th/95th percentiles. */
export function winsorizedMean(values: number[], lo = 0.05, hi = 0.95): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const low = quantile(sorted, lo);
  const high = quantile(sorted, hi);
  const clamped = values.map((v) => Math.min(high, Math.max(low, v)));
  return clamped.reduce((s, v) => s + v, 0) / clamped.length;
}

/** Share of observations beating SPY (excess > 0). */
export function hitRate(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.filter((v) => v > 0).length / values.length;
}

export interface GroupStats {
  n: number;
  medianExcess: number | null;
  winsorizedMeanExcess: number | null;
  hitRate: number | null;
}

export function groupStats(values: number[]): GroupStats {
  return {
    n: values.length,
    medianExcess: round(median(values)),
    winsorizedMeanExcess: round(winsorizedMean(values)),
    hitRate: round(hitRate(values))
  };
}

export function round(v: number | null, digits = 4): number | null {
  return v === null ? null : Number(v.toFixed(digits));
}

// ---------- price series ----------

export interface Series {
  dates: string[]; // sorted ascending
  close: Map<string, number>;
}

export function loadSeries(priceDb: Database.Database, symbol: string): Series | null {
  const rows = priceDb.prepare("SELECT date, close FROM bars WHERE symbol = ? ORDER BY date").all(symbol) as Array<{
    date: string;
    close: number;
  }>;
  if (rows.length === 0) return null;
  return { dates: rows.map((r) => r.date), close: new Map(rows.map((r) => [r.date, r.close])) };
}

/** First trading date in the series strictly after `date` (ISO yyyy-mm-dd). */
export function firstDateAfter(series: Series, date: string): string | null {
  // binary search for first element > date
  let lo = 0;
  let hi = series.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] > date) hi = mid;
    else lo = mid + 1;
  }
  return lo < series.dates.length ? series.dates[lo] : null;
}

/** First trading date in the series on/after `date`. */
export function firstDateOnOrAfter(series: Series, date: string): string | null {
  let lo = 0;
  let hi = series.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] >= date) hi = mid;
    else lo = mid + 1;
  }
  return lo < series.dates.length ? series.dates[lo] : null;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(left: string, right: string): number {
  return Math.round((Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000);
}
