import type Database from "better-sqlite3";

export type ClusterSignal = {
  ticker: string;
  politicianCount: number;
  tradeCount: number;
  firstTradeDate: string;
  lastTradeDate: string;
};

export function detectClusters(db: Database.Database, days = 30): ClusterSignal[] {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  return db
    .prepare(
      `SELECT ticker,
              count(DISTINCT politician_id) AS politicianCount,
              count(*) AS tradeCount,
              min(trade_date) AS firstTradeDate,
              max(trade_date) AS lastTradeDate
       FROM trades
       WHERE direction = 'buy' AND ticker IS NOT NULL AND trade_date >= ?
       GROUP BY ticker
       HAVING count(DISTINCT politician_id) >= 3
       ORDER BY politicianCount DESC, tradeCount DESC`
    )
    .all(start.toISOString().slice(0, 10)) as ClusterSignal[];
}
