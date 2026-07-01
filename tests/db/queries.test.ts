import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/db/schema.js";
import {
  DUST_EPSILON,
  addPendingExit,
  applyPartialFill,
  closeStockPosition,
  findPositionById,
  insertStockPosition,
  sourcesDownSince,
  upsertPolitician,
  upsertSourceHealth
} from "../../src/db/queries.js";

function makePosition(db: Database.Database, quantity: number, pendingExitQty = 0) {
  const id = insertStockPosition(db, {
    ticker: "TEST",
    sleeve: "senator",
    triggerType: "senator_trade",
    quantity,
    avgEntryPrice: 100
  });
  if (pendingExitQty > 0) addPendingExit(db, id, pendingExitQty);
  return id;
}

/** Deterministic PRNG so the property-style test is reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mimic Alpaca's string quantities: parse back through a decimal string. */
function alpacaQty(value: number) {
  return Number(value.toFixed(9));
}

describe("dust-epsilon position math", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  it("applyPartialFill closes outright when the remainder is float dust", () => {
    // Live bug reproduction: UBER remainder 1e-9, IBM remainder 5.55e-17.
    const id = makePosition(db, 3, 3);
    applyPartialFill(db, id, alpacaQty(2.999999999), -10);
    const position = findPositionById(db, id)!;
    expect(position.status).toBe("closed");
    expect(position.quantity).toBe(0);
    expect(position.pendingExitQty).toBe(0);
    expect(position.pnlUsd).toBe(-10);
  });

  it("applyPartialFill keeps genuinely material remainders open as partial", () => {
    const id = makePosition(db, 5, 5);
    applyPartialFill(db, id, 2, 20);
    const position = findPositionById(db, id)!;
    expect(position.status).toBe("partial");
    expect(position.quantity).toBe(3);
    expect(position.pendingExitQty).toBe(3);
    expect(position.realizedQty).toBe(2);
  });

  it("applyPartialFill with releaseReservation=false leaves the reservation untouched", () => {
    const id = makePosition(db, 5, 1);
    applyPartialFill(db, id, 2, null, false);
    const position = findPositionById(db, id)!;
    expect(position.quantity).toBe(3);
    expect(position.pendingExitQty).toBe(1);
  });

  it("closeStockPosition zeroes dust left by a slice fill", () => {
    const id = makePosition(db, 1, 1);
    closeStockPosition(db, id, "stop_loss", -5, alpacaQty(0.999999999995));
    const position = findPositionById(db, id)!;
    expect(position.status).toBe("closed");
    expect(position.quantity).toBe(0);
    expect(position.pendingExitQty).toBe(0);
  });

  it("addPendingExit clamps dust residues to zero but keeps material reservations", () => {
    const id = makePosition(db, 5);
    addPendingExit(db, id, 0.786343612);
    addPendingExit(db, id, -0.786343611999996); // leaves ~4e-15
    expect(findPositionById(db, id)!.pendingExitQty).toBe(0);

    addPendingExit(db, id, 5);
    addPendingExit(db, id, -2);
    expect(findPositionById(db, id)!.pendingExitQty).toBe(3);
  });

  it("property: any Alpaca-string fill sequence summing to the position closes it exactly", () => {
    const random = mulberry32(20260701);
    for (let run = 0; run < 100; run++) {
      const quantity = alpacaQty(0.1 + random() * 200);
      const id = makePosition(db, quantity, quantity);

      const sliceCount = 1 + Math.floor(random() * 4);
      let filledSoFar = 0;
      for (let slice = 0; slice < sliceCount - 1; slice++) {
        const fill = alpacaQty((quantity - filledSoFar) * random() * 0.8);
        if (fill <= 0) continue;
        applyPartialFill(db, id, fill, null);
        filledSoFar += fill;
      }
      // Final fill = remainder as Alpaca would report it, with float noise.
      const noise = (random() - 0.5) * 1e-9;
      const lastFill = alpacaQty(quantity - filledSoFar + noise);
      applyPartialFill(db, id, lastFill, null);

      const position = findPositionById(db, id)!;
      expect(position.status, `run ${run}: qty=${quantity}`).toBe("closed");
      expect(position.quantity, `run ${run}: qty=${quantity}`).toBe(0);
      expect(position.pendingExitQty, `run ${run}: qty=${quantity}`).toBe(0);
    }
  });

  it("exposes DUST_EPSILON at 1e-6", () => {
    expect(DUST_EPSILON).toBe(1e-6);
  });
});

describe("source_health down_since tracking", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  afterEach(() => { db.close(); });

  it("sets down_since on first failure, keeps it on repeat failures, clears on recovery", () => {
    const t1 = "2026-07-01T00:00:00.000Z";
    const t2 = "2026-07-01T06:00:00.000Z";
    upsertSourceHealth(db, { source: "quiver", ok: false, checkedAt: t1, message: "HTTP 500" });
    upsertSourceHealth(db, { source: "quiver", ok: false, checkedAt: t2, message: "HTTP 500" });

    const down = db.prepare("SELECT down_since FROM source_health WHERE source = 'quiver'").get() as { down_since: string };
    expect(down.down_since).toBe(t1);

    expect(sourcesDownSince(db, "2026-07-01T12:00:00.000Z").map((row) => row.source)).toEqual(["quiver"]);
    expect(sourcesDownSince(db, "2026-06-30T00:00:00.000Z")).toEqual([]);

    upsertSourceHealth(db, { source: "quiver", ok: true, checkedAt: "2026-07-01T07:00:00.000Z", message: null });
    const recovered = db.prepare("SELECT ok, down_since FROM source_health WHERE source = 'quiver'").get() as { ok: number; down_since: string | null };
    expect(recovered.ok).toBe(1);
    expect(recovered.down_since).toBeNull();
  });
});

describe("politician name canonicalization", () => {
  it("merges suffix variants onto one canonical row at insert time", () => {
    const db = openDatabase(":memory:");
    const a = upsertPolitician(db, { name: "August Lee Pfluger", chamber: "house" });
    const b = upsertPolitician(db, { name: "August Lee Pfluger Ii", chamber: "house" });
    const c = upsertPolitician(db, { name: "Thomas H. Kean Jr", chamber: "house" });
    const d = upsertPolitician(db, { name: "Thomas H. Kean", chamber: "house" });
    expect(b).toBe(a);
    expect(d).toBe(c);
    const names = db.prepare("SELECT name FROM politicians ORDER BY name").all() as Array<{ name: string }>;
    expect(names.map((row) => row.name)).toEqual(["August Lee Pfluger", "Thomas H. Kean"]);
    db.close();
  });
});
