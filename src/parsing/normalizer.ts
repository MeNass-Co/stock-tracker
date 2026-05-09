import type { TradeDirection } from "../types.js";

export const AMOUNT_MIDPOINTS: Record<string, number> = {
  "$1,001 - $15,000": 8_000,
  "$15,001 - $50,000": 32_500,
  "$50,001 - $100,000": 75_000,
  "$100,001 - $250,000": 175_000,
  "$250,001 - $500,000": 375_000,
  "$500,001 - $1,000,000": 750_000,
  "$1,000,001 - $5,000,000": 3_000_000,
  "$5,000,001 - $25,000,000": 15_000_000,
  "$25,000,001 - $50,000,000": 37_500_000,
  "Over $50,000,000": 75_000_000
};

export function normalizeName(name: string) {
  return name.replace(/\s+/g, " ").trim();
}

export function normalizeTicker(ticker: string | null | undefined) {
  const clean = ticker?.trim().toUpperCase();
  return clean && clean !== "--" ? clean : null;
}

export function normalizeDate(date: string | Date | null | undefined) {
  if (!date) return new Date().toISOString().slice(0, 10);
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  const parsed = new Date(date);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return date.slice(0, 10);
}

export function midpointForRange(range: string | null | undefined) {
  if (!range) return null;
  const normalized = range.replace(/\s+/g, " ").trim();
  return AMOUNT_MIDPOINTS[normalized] ?? null;
}

export function directionFromTransaction(value: string | null | undefined): TradeDirection {
  const text = value?.trim().toLowerCase() ?? "";
  if (text === "p" || text === "a") return "buy";
  if (text === "s" || text === "d" || text === "f") return "sell";
  if (["purchase", "buy", "bought"].some((term) => text.includes(term))) return "buy";
  if (["sale", "sell", "sold", "dispose", "disposition"].some((term) => text.includes(term))) return "sell";
  return "exchange";
}

export function first<T>(value: T | T[] | undefined | null): T | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
