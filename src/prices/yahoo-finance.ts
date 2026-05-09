import { config } from "../config.js";
import type { PriceProvider } from "./price-cache.js";

export class YahooFinancePriceProvider implements PriceProvider {
  async getClose(ticker: string, date: string): Promise<number | null> {
    if (!config.YAHOO_FINANCE_ENABLED) return null;
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const end = start + 5 * 86400;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "stock-tracker/1.0" } });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const closes: number[] | undefined = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
    if (!closes?.length) return null;
    return closes.find((c: number | null) => c != null) ?? null;
  }
}
