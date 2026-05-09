import { getDb } from "../src/db/queries.js";
import { PriceCache } from "../src/prices/price-cache.js";
import { YahooFinancePriceProvider } from "../src/prices/yahoo-finance.js";
import { runBacktest } from "../src/ranking/backtester.js";

const db = getDb();
const prices = new PriceCache(db, new YahooFinancePriceProvider());
const rankings = await runBacktest(db, prices);
console.log(JSON.stringify({ rankings: rankings.length, top: rankings.slice(0, 10) }, null, 2));
