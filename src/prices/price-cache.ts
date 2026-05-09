import type Database from "better-sqlite3";
import { getCachedPrice, upsertPrice } from "../db/queries.js";

export interface PriceProvider {
  getClose(ticker: string, date: string): Promise<number | null>;
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
}
