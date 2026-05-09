import * as cheerio from "cheerio";
import type { NormalizedTrade } from "../types.js";
import { directionFromTransaction, midpointForRange, normalizeDate, normalizeName, normalizeTicker } from "./normalizer.js";

export function parseSenatePtrHtml(html: string, sourceId: string): NormalizedTrade[] {
  const $ = cheerio.load(html);
  const ownerName = normalizeName($("h1, .report-title").first().text() || "Unknown senator");
  const rows: NormalizedTrade[] = [];

  $("table tbody tr").each((index, row) => {
    const cells = $(row)
      .find("td")
      .map((_, cell) => $(cell).text().trim())
      .get();
    if (cells.length < 5) return;
    const [tradeDate, ticker, assetName, transactionType, amountRange] = cells;
    rows.push({
      politician: { name: ownerName, chamber: "senate" },
      ticker: normalizeTicker(ticker),
      assetName: assetName || ticker || "Unknown asset",
      tradeDate: normalizeDate(tradeDate),
      filingDate: normalizeDate(new Date()),
      detectedAt: new Date().toISOString(),
      direction: directionFromTransaction(transactionType),
      amountRange,
      amountMidpoint: midpointForRange(amountRange),
      assetType: "stock",
      source: "senate-efd",
      sourceId: `${sourceId}-${index}`,
      rawData: cells
    });
  });

  return rows;
}
