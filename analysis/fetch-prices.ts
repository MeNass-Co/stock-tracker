/**
 * Resumable daily-bar fetcher (Alpaca Market Data, free/IEX feed) into
 * data/analysis-prices.sqlite. Safe to re-run: symbols already logged in
 * fetch_log are skipped. Throttled well under the free 200 req/min limit.
 *
 * Usage: npx tsx analysis/fetch-prices.ts [--retry-errors]
 */
import "dotenv/config";
import { CUSIP_TO_TICKER, openLiveDb, openPriceDb } from "./lib.js";

const KEY = process.env.ALPACA_KEY_ID;
const SECRET = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SECRET) {
  console.error("ALPACA_KEY_ID / ALPACA_SECRET_KEY missing from .env");
  process.exit(1);
}

const START = "2025-05-01";
const END = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); // yesterday: today's bar is partial
const THROTTLE_MS = 400; // ~150 req/min < 200 req/min free limit
const RETRY_ERRORS = process.argv.includes("--retry-errors");

interface Bar {
  t: string;
  c: number;
}

async function fetchBars(symbol: string): Promise<Bar[] | "empty" | "error"> {
  const bars: Bar[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < 10; page++) {
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", "iex");
    url.searchParams.set("start", START);
    url.searchParams.set("end", END);
    url.searchParams.set("limit", "10000");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": KEY!, "APCA-API-SECRET-KEY": SECRET! }
    });
    if (res.status === 429) {
      await sleep(30_000);
      page--;
      continue;
    }
    if (res.status === 404 || res.status === 422) return "empty"; // unknown/invalid symbol on this feed
    if (!res.ok) {
      console.error(`  ${symbol}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      return "error";
    }
    const body = (await res.json()) as { bars?: Bar[] | null; next_page_token?: string | null };
    if (body.bars) bars.push(...body.bars);
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
  }
  return bars.length === 0 ? "empty" : bars;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function neededSymbols(): string[] {
  const live = openLiveDb();
  const tradeTickers = (
    live
      .prepare(
        `SELECT DISTINCT upper(ticker) AS t FROM trades
         WHERE ticker IS NOT NULL AND ticker != '' AND asset_type = 'stock'`
      )
      .all() as Array<{ t: string }>
  ).map((r) => r.t);
  live.close();
  const symbols = new Set<string>(["SPY", ...tradeTickers, ...Object.values(CUSIP_TO_TICKER)]);
  return [...symbols].sort();
}

async function main() {
  const priceDb = openPriceDb();
  const symbols = neededSymbols();
  const doneRows = priceDb.prepare("SELECT symbol, status FROM fetch_log").all() as Array<{ symbol: string; status: string }>;
  const done = new Map(doneRows.map((r) => [r.symbol, r.status]));
  const todo = symbols.filter((s) => {
    const status = done.get(s);
    if (!status) return true;
    return RETRY_ERRORS && status === "error";
  });
  console.log(`symbols total=${symbols.length} already-fetched=${symbols.length - todo.length} todo=${todo.length} window=${START}..${END}`);

  const insertBar = priceDb.prepare("INSERT OR REPLACE INTO bars (symbol, date, close) VALUES (?, ?, ?)");
  const logFetch = priceDb.prepare(
    `INSERT OR REPLACE INTO fetch_log (symbol, status, bar_count, first_date, last_date, fetched_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  );
  const insertMany = priceDb.transaction((symbol: string, bars: Bar[]) => {
    for (const bar of bars) insertBar.run(symbol, bar.t.slice(0, 10), bar.c);
    logFetch.run(symbol, "ok", bars.length, bars[0].t.slice(0, 10), bars[bars.length - 1].t.slice(0, 10));
  });

  let i = 0;
  for (const symbol of todo) {
    i++;
    const result = await fetchBars(symbol);
    if (result === "empty" || result === "error") {
      logFetch.run(symbol, result, 0, null, null);
      console.log(`[${i}/${todo.length}] ${symbol}: ${result}`);
    } else {
      insertMany(symbol, result);
      if (i % 25 === 0 || symbol === "SPY") console.log(`[${i}/${todo.length}] ${symbol}: ${result.length} bars`);
    }
    await sleep(THROTTLE_MS);
  }

  const summary = priceDb.prepare("SELECT status, count(*) AS n FROM fetch_log GROUP BY status").all();
  console.log("fetch_log summary:", JSON.stringify(summary));
  priceDb.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
