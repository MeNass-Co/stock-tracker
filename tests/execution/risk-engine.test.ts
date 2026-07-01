import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/schema.js";
import { getAppState, insertPortfolioSnapshot, insertStockPosition } from "../../src/db/queries.js";
import { RiskEngine } from "../../src/execution/risk-engine.js";
import type { AlpacaClient } from "../../src/execution/alpaca-client.js";
import type { PriceCache } from "../../src/prices/price-cache.js";
import type { SignalDecision } from "../../src/execution/signal-filter.js";

function fakeAlpaca(account: Partial<Record<string, string | boolean>> = {}) {
  return {
    getAccount: vi.fn(async () => ({
      portfolio_value: "100000",
      cash: "50000",
      equity: "100000",
      trading_blocked: false,
      account_blocked: false,
      ...account
    })),
    getPositions: vi.fn(async () => [])
  } as unknown as AlpacaClient;
}

function decision(overrides: Partial<SignalDecision> = {}): SignalDecision {
  return {
    copy: true,
    reason: "test",
    sleeve: "senator",
    priority: 5,
    boosts: [],
    direction: "buy",
    ticker: "AAPL",
    triggerType: "senator_trade",
    ...overrides
  };
}

function seedSnapshot(db: Database.Database, totalValue: number, highWaterMark = totalValue, snapshotAtModifier?: string) {
  insertPortfolioSnapshot(db, {
    totalValue,
    senatorSleeveValue: 0,
    thirteenfSleeveValue: 0,
    cashValue: totalValue,
    dailyPnl: 0,
    dailyPnlRatio: 0,
    cumulativePnl: totalValue - 100_000,
    openPositions: 0,
    highWaterMark
  });
  if (snapshotAtModifier) {
    db.prepare(
      "UPDATE portfolio_snapshots SET snapshot_at = datetime('now', ?) WHERE id = (SELECT max(id) FROM portfolio_snapshots)"
    ).run(snapshotAtModifier);
  }
}

describe("RiskEngine circuit breakers and pause logic", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  it("trips the daily drawdown breaker at -3% from start of day", async () => {
    seedSnapshot(db, 100_000);
    const engine = new RiskEngine(db, fakeAlpaca({ equity: "96000", portfolio_value: "96000" }));
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("daily drawdown");
  });

  it("trips the weekly drawdown breaker at -7% from the weekly start", async () => {
    seedSnapshot(db, 100_000, 100_000, "-3 days");
    const engine = new RiskEngine(db, fakeAlpaca({ equity: "92000", portfolio_value: "92000" }));
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("weekly drawdown");
  });

  it("pauses for 6 hours after 5 consecutive losses", async () => {
    for (let i = 0; i < 5; i++) {
      const id = insertStockPosition(db, { ticker: `L${i}`, sleeve: "senator", triggerType: "senator_trade", quantity: 1, avgEntryPrice: 100 });
      db.prepare("UPDATE stock_positions SET status = 'closed', pnl_usd = -10, closed_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    }
    const engine = new RiskEngine(db, fakeAlpaca());
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("5 consecutive losses");
  });

  it("does not pause when the losses are older than 6 hours", async () => {
    for (let i = 0; i < 5; i++) {
      const id = insertStockPosition(db, { ticker: `L${i}`, sleeve: "senator", triggerType: "senator_trade", quantity: 1, avgEntryPrice: 100 });
      db.prepare("UPDATE stock_positions SET status = 'closed', pnl_usd = -10, closed_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), id);
    }
    const engine = new RiskEngine(db, fakeAlpaca());
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(true);
  });

  it("caps the senator sleeve at 25 open positions", async () => {
    for (let i = 0; i < 25; i++) {
      insertStockPosition(db, { ticker: `S${i}`, sleeve: "senator", triggerType: "senator_trade", quantity: 1, avgEntryPrice: 1 });
    }
    const engine = new RiskEngine(db, fakeAlpaca());
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("max 25 senator positions");
  });

  it("blocks when the Alpaca account itself is blocked", async () => {
    const engine = new RiskEngine(db, fakeAlpaca({ trading_blocked: true }));
    const check = await engine.checkNewOrder(decision(), 1000);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("blocked");
  });

  it("allows a clean order and returns the adjusted size", async () => {
    const engine = new RiskEngine(db, fakeAlpaca());
    const check = await engine.checkNewOrder(decision(), 4000);
    expect(check.allowed).toBe(true);
    expect(check.adjustedSize).toBe(4000);
  });
});

describe("RiskEngine.snapshot", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  function lastSnapshot() {
    return db
      .prepare("SELECT * FROM portfolio_snapshots ORDER BY id DESC LIMIT 1")
      .get() as { cumulative_pnl: number; drawdown_usd: number; spy_equity: number | null; high_water_mark: number };
  }

  it("stores real cumulative P&L vs $100k and drawdown vs high-water mark separately", async () => {
    seedSnapshot(db, 110_000, 110_000, "-1 days");
    const engine = new RiskEngine(db, fakeAlpaca({ portfolio_value: "105000", equity: "105000", cash: "105000" }));
    await engine.snapshot();

    const row = lastSnapshot();
    expect(row.cumulative_pnl).toBe(5000); // 105k − 100k initial capital
    expect(row.drawdown_usd).toBe(-5000); // 105k − 110k high-water mark
    expect(row.high_water_mark).toBe(110_000);
    expect(row.spy_equity).toBeNull(); // no price provider wired
  });

  it("fixes the SPY benchmark share count once, then tracks buy-and-hold equity", async () => {
    let spyPrice = 500;
    const prices = { getLatestCloses: vi.fn(async () => ({ currentPrice: spyPrice, previousClose: null })) } as unknown as PriceCache;
    const engine = new RiskEngine(db, fakeAlpaca(), prices);

    await engine.snapshot();
    expect(lastSnapshot().spy_equity).toBe(100_000); // 200 shares × $500
    expect(Number(getAppState(db, "spy_benchmark_shares"))).toBeCloseTo(200, 9);

    spyPrice = 510;
    await engine.snapshot();
    expect(lastSnapshot().spy_equity).toBeCloseTo(102_000, 6); // same 200 shares × $510
  });
});
