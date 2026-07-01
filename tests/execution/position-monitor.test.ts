import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/schema.js";
import { findPositionById, insertStockPosition } from "../../src/db/queries.js";
import { PositionMonitor } from "../../src/execution/position-monitor.js";
import type { AlpacaClient, AlpacaOrder } from "../../src/execution/alpaca-client.js";
import type { AlertEngine } from "../../src/alerting/alert-engine.js";

interface FakeAlpacaConfig {
  marketOpen: boolean;
  currentPrice: string;
  orders?: Record<string, Partial<AlpacaOrder>>;
  positions?: Array<{ symbol: string; qty: string }>;
}

function fakeAlpaca(config: FakeAlpacaConfig) {
  const submitOrder = vi.fn(async (params: Record<string, unknown> & { qty?: string }) => ({
    id: `fill-${Math.random()}`,
    client_order_id: "client-x",
    status: "filled",
    filled_qty: params.qty ?? "0",
    filled_avg_price: config.currentPrice,
    filled_at: new Date().toISOString()
  }) as AlpacaOrder);
  const alpaca = {
    getClock: vi.fn(async () => ({ is_open: config.marketOpen })),
    getPosition: vi.fn(async () => ({ current_price: config.currentPrice })),
    getOrder: vi.fn(async (id: string) => ({ id, status: "new", filled_qty: "0", ...config.orders?.[id] }) as AlpacaOrder),
    getPositions: vi.fn(async () => config.positions ?? []),
    submitOrder,
    cancelOrder: vi.fn(async () => {})
  };
  return { alpaca: alpaca as unknown as AlpacaClient, submitOrder };
}

function makePosition(
  db: Database.Database,
  input: { quantity: number; stopLossPrice?: number; stopLossOrderId?: string; currentPrice?: number }
) {
  return insertStockPosition(db, {
    ticker: "TEST",
    sleeve: "senator",
    triggerType: "senator_trade",
    quantity: input.quantity,
    avgEntryPrice: 100,
    currentPrice: input.currentPrice ?? 100,
    stopLossPrice: input.stopLossPrice ?? null,
    stopLossOrderId: input.stopLossOrderId ?? null
  });
}

describe("PositionMonitor.checkPosition decision tree", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  it("defers the soft-stop while the market is closed (no churn orders)", async () => {
    const positionId = makePosition(db, { quantity: 10, stopLossPrice: 92, currentPrice: 91 });
    const { alpaca, submitOrder } = fakeAlpaca({ marketOpen: false, currentPrice: "90" });
    const monitor = new PositionMonitor(db, undefined, alpaca);

    await monitor.checkAll();
    await monitor.checkAll(); // second tick: still deferred, still no orders

    expect(submitOrder).not.toHaveBeenCalled();
    expect(findPositionById(db, positionId)!.status).toBe("open");
  });

  it("fires the soft-stop market exit once the market is open", async () => {
    const positionId = makePosition(db, { quantity: 10, stopLossPrice: 92, currentPrice: 91 });
    const { alpaca, submitOrder } = fakeAlpaca({ marketOpen: true, currentPrice: "90" });
    const monitor = new PositionMonitor(db, undefined, alpaca);

    await monitor.checkAll();

    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(submitOrder.mock.calls[0][0]).toMatchObject({ side: "sell", type: "market", qty: "10" });
    const position = findPositionById(db, positionId)!;
    expect(position.status).toBe("closed");
    expect(position.quantity).toBe(0);
  });

  it("closes the position and tracks the wash sale when the whole stop fills", async () => {
    const positionId = makePosition(db, { quantity: 5, stopLossPrice: 92, stopLossOrderId: "stop-1", currentPrice: 91 });
    const { alpaca, submitOrder } = fakeAlpaca({
      marketOpen: true,
      currentPrice: "91",
      orders: { "stop-1": { status: "filled", filled_qty: "5", filled_avg_price: "92" } }
    });
    const monitor = new PositionMonitor(db, undefined, alpaca);

    await monitor.checkAll();

    const position = findPositionById(db, positionId)!;
    expect(position.status).toBe("closed");
    expect(position.exitReason).toBe("stop_loss");
    expect(submitOrder).not.toHaveBeenCalled(); // no fractional tail to flush
    const washSales = db.prepare("SELECT ticker FROM wash_sale_tracker").all() as Array<{ ticker: string }>;
    expect(washSales).toEqual([{ ticker: "TEST" }]);
  });

  it("flushes the sub-share tail with a market exit after a whole-share stop fill", async () => {
    const positionId = makePosition(db, { quantity: 5.5, stopLossPrice: 92, stopLossOrderId: "stop-1", currentPrice: 91 });
    const { alpaca, submitOrder } = fakeAlpaca({
      marketOpen: true,
      currentPrice: "91",
      orders: { "stop-1": { status: "filled", filled_qty: "5", filled_avg_price: "92" } }
    });
    const monitor = new PositionMonitor(db, undefined, alpaca);

    await monitor.checkAll();

    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(submitOrder.mock.calls[0][0]).toMatchObject({ side: "sell", type: "market", qty: "0.5", time_in_force: "day" });
    const position = findPositionById(db, positionId)!;
    expect(position.status).toBe("closed");
    expect(position.quantity).toBe(0);
  });

  it("defers the fractional tail when the market is closed, keeping the remainder as partial", async () => {
    const positionId = makePosition(db, { quantity: 5.5, stopLossPrice: 92, stopLossOrderId: "stop-1", currentPrice: 91 });
    const { alpaca, submitOrder } = fakeAlpaca({
      marketOpen: false,
      currentPrice: "91",
      orders: { "stop-1": { status: "filled", filled_qty: "5", filled_avg_price: "92" } }
    });
    const monitor = new PositionMonitor(db, undefined, alpaca);

    await monitor.checkAll();

    expect(submitOrder).not.toHaveBeenCalled();
    const position = findPositionById(db, positionId)!;
    expect(position.status).toBe("partial");
    expect(position.quantity).toBeCloseTo(0.5, 9);
  });
});

describe("PositionMonitor.reconcile", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  it("auto-closes dust rows absent at Alpaca, alerts on material divergences", async () => {
    const material = insertStockPosition(db, { ticker: "AAA", sleeve: "senator", triggerType: "senator_trade", quantity: 10, avgEntryPrice: 100 });
    const dust = insertStockPosition(db, { ticker: "BBB", sleeve: "senator", triggerType: "senator_trade", quantity: 1e-9, avgEntryPrice: 100 });
    insertStockPosition(db, { ticker: "CCC", sleeve: "senator", triggerType: "senator_trade", quantity: 10, avgEntryPrice: 100 });

    const { alpaca } = fakeAlpaca({
      marketOpen: true,
      currentPrice: "100",
      positions: [
        { symbol: "CCC", qty: "10.5" }, // qty mismatch vs local 10
        { symbol: "TSLA", qty: "3" } // Alpaca-only
      ]
    });
    const systemAlert = vi.fn(async (_alert: { body: string; severity: string }) => {});
    const monitor = new PositionMonitor(db, { systemAlert } as unknown as AlertEngine, alpaca);

    await monitor.reconcile();

    const dustRow = findPositionById(db, dust)!;
    expect(dustRow.status).toBe("closed");
    expect(dustRow.exitReason).toBe("reconcile_dust");
    expect(findPositionById(db, material)!.status).toBe("open"); // material divergence NOT auto-acted

    expect(systemAlert).toHaveBeenCalledTimes(1);
    const alert = systemAlert.mock.calls[0][0];
    expect(alert.severity).toBe("high");
    expect(alert.body).toContain("AAA");
    expect(alert.body).toContain("CCC");
    expect(alert.body).toContain("TSLA");
    expect(alert.body).not.toContain("BBB");
  });

  it("skips quietly when Alpaca positions are unavailable", async () => {
    insertStockPosition(db, { ticker: "AAA", sleeve: "senator", triggerType: "senator_trade", quantity: 10, avgEntryPrice: 100 });
    const alpaca = { getPositions: vi.fn(async () => { throw new Error("api down"); }) } as unknown as AlpacaClient;
    const systemAlert = vi.fn(async () => {});
    const monitor = new PositionMonitor(db, { systemAlert } as unknown as AlertEngine, alpaca);

    await expect(monitor.reconcile()).resolves.toBeUndefined();
    expect(systemAlert).not.toHaveBeenCalled();
  });
});
