import { config } from "../config.js";
import type { NormalizedTrade } from "../types.js";
import { directionFromTransaction, midpointForRange, normalizeDate, normalizeName, normalizeTicker } from "../parsing/normalizer.js";
import { retry } from "../utils/retry.js";
import { BaseSource } from "./base-source.js";

export class QuiverSource extends BaseSource {
  readonly name = "quiver";
  private readonly endpoint = "https://api.quiverquant.com/beta/live/congresstrading";

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    if (!config.QUIVER_API_KEY) return [];
    const payload = await retry(async () => {
      const response = await fetch(this.endpoint, {
        headers: { Authorization: `Bearer ${config.QUIVER_API_KEY}` }
      });
      if (!response.ok) throw new Error(`Quiver request failed: ${response.status}`);
      return (await response.json()) as any[];
    }, 3, 2000);

    return payload.map((row, index) => {
      const name = row.Representative ?? row.Senator ?? row.Name ?? row.Politician ?? "Unknown politician";
      const chamber = String(row.House ?? row.Chamber ?? "").toLowerCase().includes("senate") ? "senate" : "house";
      const amountRange = row.Range ?? row.Amount ?? row.AmountRange ?? null;

      return {
        politician: {
          name: normalizeName(name),
          chamber,
          state: row.State ?? null,
          party: row.Party ?? null
        },
        ticker: normalizeTicker(row.Ticker),
        assetName: row.Asset ?? row.Company ?? row.Ticker ?? "Unknown asset",
        tradeDate: normalizeDate(row.TransactionDate ?? row.TradeDate),
        filingDate: normalizeDate(row.ReportDate ?? row.FilingDate),
        detectedAt: new Date().toISOString(),
        direction: directionFromTransaction(row.Transaction ?? row.TransactionType),
        amountRange,
        amountMidpoint: midpointForRange(amountRange),
        assetType: "stock",
        source: "quiver",
        sourceId: String(row.ID ?? row.ReportID ?? `${row.Ticker ?? "unknown"}-${index}`),
        rawData: row
      };
    });
  }
}
