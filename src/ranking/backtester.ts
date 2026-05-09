import type Database from "better-sqlite3";
import { insertRankingRun } from "../db/queries.js";
import { PriceCache } from "../prices/price-cache.js";
import { compositeRank } from "./composite-score.js";
import { calculateMetrics } from "./metrics.js";

export async function runBacktest(db: Database.Database, prices: PriceCache) {
  const metrics = await calculateMetrics(db, prices);
  const rankings = compositeRank(metrics);
  insertRankingRun(db, rankings);
  return rankings;
}
