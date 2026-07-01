import type Database from "better-sqlite3";
import { getCachedPrice, upsertPrice } from "../db/queries.js";

export interface LatestCloses {
  currentPrice: number;
  previousClose: number | null;
}

export interface PriceProvider {
  getClose(ticker: string, date: string): Promise<number | null>;
  /** Optional live quote support: latest price plus prior session close. */
  getLatestCloses?(ticker: string): Promise<LatestCloses | null>;
}

export class PriceCache {
  constructor(
    private readonly db: Database.Database,
    private readonly provider: PriceProvider
  ) {}

  async getClose(ticker: string, date: string) {
    const cached = getCachedPrice(this.db, ticker, date);
    if (cached) return cached.close;
    const close = await this.provider.getClose(ticker, date);
    if (close !== null) upsertPrice(this.db, ticker, date, close);
    return close;
  }

  /** Live quote — never cached (intraday values must not be persisted as closes). */
  async getLatestCloses(ticker: string): Promise<LatestCloses | null> {
    if (!this.provider.getLatestCloses) return null;
    return this.provider.getLatestCloses(ticker);
  }
}
