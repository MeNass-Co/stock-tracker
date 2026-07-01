import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/schema.js";
import {
  addPendingExit,
  findPositionById,
  insertStockExecution,
  insertStockPosition
} from "../../src/db/queries.js";
import { OrderManager, parseTimestamp } from "../../src/execution/order-manager.js";
import type { AlpacaClient, AlpacaOrder } from "../../src/execution/alpaca-client.js";

function makePosition(db: Database.Database, quantity: number, pendingExitQty = 0) {
  const id = insertStockPosition(db, {
    ticker: "TEST",
    sleeve: "senator",
    triggerType: "senator_trade",
    quantity,
    avgEntryPrice: 90
  });
  if (pendingExitQty > 0) addPendingExit(db, id, pendingExitQty);
  return id;
}

function makeSellExecution(db: Database.Database, positionId: number, quantity: number, orderId: string, createdAt?: string) {
  const id = insertStockExecution(db, {
    triggerType: "stop_loss",
    positionId,
    sleeve: "senator",
    ticker: "TEST",
    direction: "sell",
    quantity,
    alpacaOrderId: orderId,
    status: "submitted",
    notes: "test exit"
  });
  if (createdAt) db.prepare("UPDATE stock_executions SET created_at = ? WHERE id = ?").run(createdAt, id);
  return id;
}

function order(overrides: Partial<AlpacaOrder>): AlpacaOrder {
  return {
    id: "order-1",
    client_order_id: "client-1",
    status: "new",
    filled_qty: "0",
    filled_avg_price: null,
    ...overrides
  } as AlpacaOrder;
}

describe("OrderManager.monitorOrders sell reconciliation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function manager(orders: Record<string, AlpacaOrder>, cancelOrder = vi.fn(async () => {})) {
    const alpaca = {
      getOrder: vi.fn(async (id: string) => orders[id]),
      cancelOrder
    } as unknown as AlpacaClient;
    return { manager: new OrderManager(db, alpaca), cancelOrder };
  }

  it("applies partial fills and releases the unfilled reservation on cancel", async () => {
    const positionId = makePosition(db, 5, 5);
    makeSellExecution(db, positionId, 5, "ord-cancel");
    const { manager: om } = manager({
      "ord-cancel": order({ id: "ord-cancel", status: "canceled", filled_qty: "2", filled_avg_price: "100", side: "sell" })
    });

    await om.monitorOrders();

    const position = findPositionById(db, positionId)!;
    expect(position.quantity).toBe(3);
    expect(position.status).toBe("partial");
    expect(position.pendingExitQty).toBe(0); // 2 released by fill + 3 released as unfilled
    expect(position.realizedQty).toBe(2);
  });

  it("closes the position when a sell fill leaves only float dust", async () => {
    const positionId = makePosition(db, 5, 5);
    makeSellExecution(db, positionId, 5, "ord-dust");
    const { manager: om } = manager({
      "ord-dust": order({ id: "ord-dust", status: "filled", filled_qty: "4.999999999900", filled_avg_price: "100", side: "sell" })
    });

    await om.monitorOrders();

    const position = findPositionById(db, positionId)!;
    expect(position.status).toBe("closed");
    expect(position.quantity).toBe(0);
    expect(position.pendingExitQty).toBe(0);
  });

  describe("EOD cancel respects createdAt (churn-loop fix)", () => {
    // 2026-07-01 is EDT (UTC-4): 20:30Z = 16:30 ET, after the 15:45 cutoff.
    const AFTER_CUTOFF = new Date("2026-07-01T20:30:00Z");

    it("cancels unfilled sells created before today's 15:45 ET cutoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(AFTER_CUTOFF);
      const positionId = makePosition(db, 5, 5);
      const executionId = makeSellExecution(db, positionId, 5, "ord-old", "2026-07-01 15:00:00"); // 11:00 ET
      const { manager: om, cancelOrder } = manager({
        "ord-old": order({ id: "ord-old", status: "new", side: "sell" })
      });

      await om.monitorOrders();
      expect(cancelOrder).toHaveBeenCalledTimes(1);
      expect(cancelOrder).toHaveBeenCalledWith("ord-old");
      const notes = (db.prepare("SELECT notes FROM stock_executions WHERE id = ?").get(executionId) as { notes: string }).notes;
      expect(notes).toContain("cancel-requested");

      // Second tick must not re-request the cancel.
      await om.monitorOrders();
      expect(cancelOrder).toHaveBeenCalledTimes(1);
    });

    it("does NOT cancel orders created after the cutoff (after-hours resubmissions)", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(AFTER_CUTOFF);
      const positionId = makePosition(db, 5, 5);
      makeSellExecution(db, positionId, 5, "ord-fresh", "2026-07-01 20:05:00"); // 16:05 ET, post-cutoff
      const { manager: om, cancelOrder } = manager({
        "ord-fresh": order({ id: "ord-fresh", status: "new", side: "sell" })
      });

      await om.monitorOrders();
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it("does nothing before the cutoff regardless of age", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T17:00:00Z")); // 13:00 ET
      const positionId = makePosition(db, 5, 5);
      makeSellExecution(db, positionId, 5, "ord-mid", "2026-07-01 16:00:00");
      const { manager: om, cancelOrder } = manager({
        "ord-mid": order({ id: "ord-mid", status: "new", side: "sell" })
      });

      await om.monitorOrders();
      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });

  it("flags sell fills with no position for manual reconciliation", async () => {
    const executionId = insertStockExecution(db, {
      triggerType: "stop_loss",
      sleeve: "senator",
      ticker: "TEST",
      direction: "sell",
      quantity: 5,
      alpacaOrderId: "ord-orphan",
      status: "submitted"
    });
    const { manager: om } = manager({
      "ord-orphan": order({ id: "ord-orphan", status: "filled", filled_qty: "5", filled_avg_price: "100", side: "sell" })
    });

    await om.monitorOrders();

    const row = db.prepare("SELECT status, notes FROM stock_executions WHERE id = ?").get(executionId) as { status: string; notes: string };
    expect(row.status).toBe("failed");
    expect(row.notes).toContain("RECONCILE_FAILED");
  });
});

describe("parseTimestamp", () => {
  it("treats zone-less sqlite timestamps as UTC and passes through ISO strings", () => {
    expect(parseTimestamp("2026-07-01 15:00:00").toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(parseTimestamp("2026-07-01T15:00:00.000Z").toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(parseTimestamp("2026-07-01T11:00:00-04:00").toISOString()).toBe("2026-07-01T15:00:00.000Z");
  });
});
