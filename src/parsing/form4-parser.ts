import { XMLParser } from "fast-xml-parser";
import type { NormalizedTrade } from "../types.js";
import { asArray, directionFromTransaction, first, normalizeDate, normalizeName, normalizeTicker, toNumber } from "./normalizer.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true
});

type Form4ParseOptions = {
  sourceId?: string;
  filingDate?: string;
  detectedAt?: string;
};

export function parseForm4Xml(xml: string, options: Form4ParseOptions = {}): NormalizedTrade[] {
  const document = parser.parse(xml) as Record<string, any>;
  const ownership = document.ownershipDocument;
  if (!ownership) return [];

  const issuer = ownership.issuer ?? {};
  const owner = first(ownership.reportingOwner) ?? {};
  const ownerId = owner.reportingOwnerId ?? {};
  const ownerName = normalizeName(ownerId.rptOwnerName ?? "Unknown filer");
  const ownerCik = ownerId.rptOwnerCik ? String(ownerId.rptOwnerCik).padStart(10, "0") : null;
  const filingDate = normalizeDate(options.filingDate ?? ownership.periodOfReport?.value ?? new Date());
  const ticker = normalizeTicker(issuer.issuerTradingSymbol);
  const assetName = issuer.issuerName ?? ticker ?? "Unknown security";
  const detectedAt = options.detectedAt ?? new Date().toISOString();

  const nonDerivativeTransactions = asArray(ownership.nonDerivativeTable?.nonDerivativeTransaction);
  const derivativeTransactions = asArray(ownership.derivativeTable?.derivativeTransaction);

  return [...nonDerivativeTransactions, ...derivativeTransactions].map((transaction: any, index) => {
    const coding = transaction.transactionCoding ?? {};
    const shares =
      toNumber(transaction.transactionAmounts?.transactionShares?.value) ??
      toNumber(transaction.transactionAmounts?.transactionTotalValue?.value);
    const price = toNumber(transaction.transactionAmounts?.transactionPricePerShare?.value);
    const amountMidpoint = shares && price ? shares * price : null;
    const code = coding.transactionCode ?? coding.transactionFormType ?? "";

    return {
      politician: {
        name: ownerName,
        chamber: "house",
        cik: ownerCik
      },
      ticker,
      assetName,
      tradeDate: normalizeDate(transaction.transactionDate?.value ?? ownership.periodOfReport?.value),
      filingDate,
      detectedAt,
      direction: directionFromTransaction(code),
      amountRange: null,
      amountMidpoint,
      assetType: "stock",
      source: "edgar-form4",
      sourceId: `${options.sourceId ?? "form4"}-${index}`,
      rawData: transaction
    };
  });
}
