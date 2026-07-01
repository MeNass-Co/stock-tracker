import { config } from "../config.js";
import type { LatestCloses, PriceProvider } from "./price-cache.js";

export class YahooFinancePriceProvider implements PriceProvider {
  async getClose(ticker: string, date: string): Promise<number | null> {
    if (!config.YAHOO_FINANCE_ENABLED) return null;
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const end = start + 5 * 86400;
    const closes = await this.fetchCloses(ticker, start, end);
    if (!closes?.length) return null;
    return closes.find((c: number | null) => c != null) ?? null;
  }

  /**
   * Latest available price and the prior session close, from one chart call.
   * The last data point is today's (possibly intraday) price when the market
   * is open, otherwise the most recent close.
   */
  async getLatestCloses(ticker: string): Promise<LatestCloses | null> {
    if (!config.YAHOO_FINANCE_ENABLED) return null;
    const end = Math.floor(Date.now() / 1000);
    const start = end - 10 * 86400;
    const closes = (await this.fetchCloses(ticker, start, end))?.filter((c): c is number => c != null);
    if (!closes || closes.length === 0) return null;
    return {
      currentPrice: closes[closes.length - 1]!,
      previousClose: closes.length >= 2 ? closes[closes.length - 2]! : null
    };
  }

  private async fetchCloses(ticker: string, period1: number, period2: number): Promise<Array<number | null> | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "stock-tracker/1.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    return json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? null;
  }
}
