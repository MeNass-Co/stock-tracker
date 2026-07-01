import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/schema.js";
import { insertWashSale, upsertPolitician } from "../../src/db/queries.js";
import { SignalFilter } from "../../src/execution/signal-filter.js";
import type { AlpacaClient } from "../../src/execution/alpaca-client.js";
import type { NormalizedTrade } from "../../src/types.js";

const COMPUTED_AT = "2026-06-30T00:00:00.000Z";

const goodAsset = { tradable: true, status: "active", fractionable: true };
const fakeAlpaca = { getAsset: async () => goodAsset } as unknown as AlpacaClient;

function seedRanked(db: Database.Database, name: string, chamber: "senate" | "house", rank: number, committees: string[] = []) {
  const politicianId = upsertPolitician(db, { name, chamber, committees });
  db.prepare(
    "INSERT INTO rankings (politician_id, computed_at, score, rank_position) VALUES (?, ?, 1.0, ?)"
  ).run(politicianId, COMPUTED_AT, rank);
}

function trade(overrides: Partial<NormalizedTrade & { id: number }> = {}): NormalizedTrade & { id?: number } {
  return {
    politician: { name: "Jane Doe", chamber: "senate", committees: [] },
    ticker: "AAPL",
    assetName: "Apple Inc",
    tradeDate: "2026-06-20",
    filingDate: "2026-06-25",
    detectedAt: "2026-06-26T00:00:00.000Z",
    direction: "buy",
    amountRange: null,
    amountMidpoint: 20_000,
    assetType: "stock",
    source: "test",
    ...overrides
  };
}

describe("SignalFilter gate matrix", () => {
  let db: Database.Database;
  let filter: SignalFilter;

  beforeEach(() => {
    db = openDatabase(":memory:");
    seedRanked(db, "Jane Doe", "senate", 30);
    seedRanked(db, "Low Senator", "senate", 31);
    seedRanked(db, "Rich Rep", "house", 15);
    seedRanked(db, "Edge Rep", "house", 16);
    seedRanked(db, "Spy Senator", "senate", 3, ["Select Committee on Intelligence"]);
    filter = new SignalFilter(db, fakeAlpaca, null);
  });

  afterEach(() => { db.close(); });

  it("accepts a qualifying senate buy at the rank-30 cap", async () => {
    const decision = await filter.evaluateTrade(trade({ id: 1 }));
    expect(decision.copy).toBe(true);
    expect(decision.senatorRank).toBe(30);
    expect(decision.direction).toBe("buy");
  });

  it("rejects a senate rank below the top-30 cap", async () => {
    const decision = await filter.evaluateTrade(trade({ politician: { name: "Low Senator", chamber: "senate" } }));
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("top 30 for senate");
  });

  it("caps house at rank 15, not 30", async () => {
    const accepted = await filter.evaluateTrade(trade({ politician: { name: "Rich Rep", chamber: "house" } }));
    expect(accepted.copy).toBe(true);
    const rejected = await filter.evaluateTrade(trade({ politician: { name: "Edge Rep", chamber: "house" } }));
    expect(rejected.copy).toBe(false);
    expect(rejected.reason).toContain("top 15 for house");
  });

  it("rejects buys with midpoint below $15,000", async () => {
    const decision = await filter.evaluateTrade(trade({ amountMidpoint: 14_999 }));
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("below $15,000");
  });

  it("rejects filings delayed more than 15 days", async () => {
    const decision = await filter.evaluateTrade(trade({ tradeDate: "2026-06-01", filingDate: "2026-06-20" }));
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("15 days");
  });

  it("rejects broad ETFs", async () => {
    const decision = await filter.evaluateTrade(trade({ ticker: "SPY" }));
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("ETF");
  });

  it("rejects plain sells but accepts sensitive-committee large sells", async () => {
    const plainSell = await filter.evaluateTrade(trade({ direction: "sell", amountMidpoint: 500_000 }));
    expect(plainSell.copy).toBe(false);

    const committeeSell = await filter.evaluateTrade(
      trade({
        direction: "sell",
        amountMidpoint: 500_000,
        politician: { name: "Spy Senator", chamber: "senate", committees: ["Select Committee on Intelligence"] }
      })
    );
    expect(committeeSell.copy).toBe(true);
    expect(committeeSell.direction).toBe("sell");
  });

  it("rejects during an active wash-sale cooldown", async () => {
    insertWashSale(db, "AAPL", "2026-06-20", "2099-01-01", 100);
    const decision = await filter.evaluateTrade(trade());
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("wash sale");
  });

  it("rejects when the Alpaca asset is not tradable/fractionable", async () => {
    const brokenAlpaca = { getAsset: async () => ({ tradable: true, status: "active", fractionable: false }) } as unknown as AlpacaClient;
    const decision = await new SignalFilter(db, brokenAlpaca, null).evaluateTrade(trade());
    expect(decision.copy).toBe(false);
    expect(decision.reason).toContain("fractionable");
  });

  it("scopes spouse/managed veto to ownership fields, not asset descriptions", async () => {
    const vetoed = await filter.evaluateTrade(trade({ rawData: { owner: "Spouse" } }));
    expect(vetoed.copy).toBe(false);
    expect(vetoed.reason).toContain("spouse");

    const notVetoed = await filter.evaluateTrade(trade({ rawData: { asset_description: "Spouse Brands Inc blind trust unit" } }));
    expect(notVetoed.copy).toBe(true);
  });

  it("scopes retiring/investigation veto to status-like fields", async () => {
    const vetoed = await filter.evaluateTrade(trade({ rawData: { notes: "member is retiring" } }));
    expect(vetoed.copy).toBe(false);

    const notVetoed = await filter.evaluateTrade(trade({ rawData: { asset_description: "fund for retiring municipal debt" } }));
    expect(notVetoed.copy).toBe(true);
  });

  it("persists a signal_decisions row for accepts AND rejects", async () => {
    await filter.evaluateTrade(trade({ id: 42 }));
    await filter.evaluateTrade(trade({ id: 43, amountMidpoint: 100 }));
    const rows = db
      .prepare("SELECT trade_id, sleeve, ticker, decision FROM signal_decisions ORDER BY id")
      .all() as Array<{ trade_id: number; sleeve: string; ticker: string; decision: string }>;
    expect(rows).toEqual([
      { trade_id: 42, sleeve: "senator", ticker: "AAPL", decision: "accept" },
      { trade_id: 43, sleeve: "senator", ticker: "AAPL", decision: "reject" }
    ]);
  });

  it("evaluates 13F diffs and persists fund-scoped decisions", async () => {
    const holding = {
      fundName: "Fund X",
      fundCik: "0001",
      reportDate: "2026-03-31",
      filingDate: "2026-05-15",
      ticker: "NVDA",
      cusip: "67066G104",
      securityName: "NVIDIA",
      shares: 100,
      valueThousands: 5000,
      changeType: "new" as const
    };
    const accepted = await filter.evaluate13FDiff(holding);
    expect(accepted.copy).toBe(true);
    expect(accepted.direction).toBe("buy");

    const rejected = await filter.evaluate13FDiff({ ...holding, changeType: "increase", changePct: 0.1 });
    expect(rejected.copy).toBe(false);

    const rows = db
      .prepare("SELECT sleeve, fund_cik, report_date, decision FROM signal_decisions ORDER BY id")
      .all() as Array<{ sleeve: string; fund_cik: string; report_date: string; decision: string }>;
    expect(rows).toEqual([
      { sleeve: "13f", fund_cik: "0001", report_date: "2026-03-31", decision: "accept" },
      { sleeve: "13f", fund_cik: "0001", report_date: "2026-03-31", decision: "reject" }
    ]);
  });
});
