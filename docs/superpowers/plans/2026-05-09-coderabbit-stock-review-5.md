# CodeRabbit Stock-Tracker Review #5 — Cleanup Plan

**Source:** PR #1, review submitted 2026-05-09T19:54:01Z, run ID 8b9b1fac-02c5-4b02-b1a5-ed238fe25d59.
**Base commit reviewed:** e42d50b.
**Triage rule:** apply Critical + Major NEW. Skip Duplicates, Minor (optimization-only), Trivial, Nitpick.

## Triage summary

| # | Severity | File:line | Decision | Reason |
|---|----------|-----------|----------|--------|
| 1 | 🔴 Critical | position-monitor.ts:117-120 | APPLY | Rejected/expired trailing-stop order leaves trailing fields stale → repeated rearm of dead order |
| 2 | 🔴 Critical | position-monitor.ts:140-145 | APPLY | Failed stop-loss cancel before trailing activation → two resting sells, double-exit |
| 3 | 🟠 Major | position-monitor.ts:207-214 | APPLY | Flash-crash widens DB stop before Alpaca confirm; swallowed catch hides divergence |
| 4 | 🟠 Major | position-monitor.ts:220-225 | APPLY | Wash-sale uses `new Date()` instead of broker fill time → 31-day cooldown drifts |
| 5 | 🟠 Major | index.ts:91-95 | APPLY | One source healthCheck throw aborts the whole loop, starving other sources of health updates |
| — | 🟡 Minor | schema.ts:99 idx_executions_position_id | SKIP | Optimization, not correctness; defer |

**NEW count:** 2 Critical + 3 Major = 5 to apply.

## Task 1 (Critical) — `position-monitor.ts:117-120` clear stale trailing-stop state

**Problem.** When the rejected/expired order is `position.trailingStopOrderId`, the branch:
```typescript
const newStop = await this.orderManager.resubmitStopLoss(position);
if (newStop) updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
```
creates a fresh stop_loss order but leaves `trailingStopOrderId` and `trailingStopActive` set to the dead values. Next poll `stopLossFilled()` re-iterates over the still-present `trailingStopOrderId`, sees the same rejected/expired order again, and resubmits another stop. The position also still appears trailing-protected to time-stop logic.

**Fix.** Before resubmit, clear the stale trailing fields if `orderId === position.trailingStopOrderId`. Apply the diff inside the `rejected/expired` branch in `stopLossFilled()`:

```diff
       if (order.status === "rejected" || order.status === "expired") {
         logger.warn({ orderId, status: order.status, ticker: position.ticker }, "stop order rejected/expired — resubmitting");
+        if (orderId === position.trailingStopOrderId) {
+          updateStockPositionStops(this.db, position.id, {
+            trailingStopActive: false,
+            trailingStopOrderId: null
+          });
+        } else {
+          updateStockPositionStops(this.db, position.id, { stopLossOrderId: null });
+        }
         const newStop = await this.orderManager.resubmitStopLoss(position);
         if (newStop) updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
         continue;
       }
```

`updateStockPositionStops` already supports `trailingStopActive: false` (boolean coalesce path) and `trailingStopOrderId: null` (nullable). Verify by reading the function — it uses `coalesce(?, ...)`, which means passing `null` *preserves* the prior value. Same `coalesce` issue we hit in review #4 for pnl_ratio. **For this fix to actually clear, `updateStockPositionStops` may need the same property-existence semantics applied to `trailingStopOrderId`.** Check current implementation: lines ~400-420 of `queries.ts`. If still using `coalesce(?, trailing_stop_order_id)`, extend the property-presence pattern (review #4 task 7) to `trailingStopOrderId`. **If implementing this becomes a wider change, instead use a direct prepared statement at the call site:**

```diff
+        if (orderId === position.trailingStopOrderId) {
+          this.db.prepare("UPDATE stock_positions SET trailing_stop_active = 0, trailing_stop_order_id = NULL WHERE id = ?").run(position.id);
+        } else {
+          this.db.prepare("UPDATE stock_positions SET stop_loss_order_id = NULL WHERE id = ?").run(position.id);
+        }
```

Pick the direct prepared-statement approach — surgical, no helper-API contract change.

## Task 2 (Critical) — `position-monitor.ts:140-145` abort trailing-stop on failed cancel

**Problem.** In `activateTrailingStop()`, the `cancelOrder` of the existing stop_loss is wrapped in `try/catch` that only logs the failure, then control flow continues to `submitOrder` for the trailing stop. Result: original stop-loss may still be live + new trailing stop placed → two resting sell orders → double-exit on next move.

**Fix.** Return early on cancel failure:

```diff
   private async activateTrailingStop(position: StockPosition, trailPercent: number) {
     if (position.stopLossOrderId) {
       try {
         await this.alpaca.cancelOrder(position.stopLossOrderId);
       } catch (error) {
         logger.warn({ error, positionId: position.id }, "failed to cancel stop loss before trailing stop activation");
+        return;
       }
     }
```

The trailing-stop activation will be retried on the next monitor pass when the cancel succeeds (or when the original stop-loss has terminated naturally and `position.stopLossOrderId` is cleared via the Task 1 path).

## Task 3 (Major) — `position-monitor.ts:207-214` flash-crash: persist DB stop only after Alpaca accepts

**Problem.** `handleFlashCrash` writes `widenedStop` to the DB *before* calling `replaceOrder`, and the `catch` block silently swallows errors. If Alpaca rejects the replace, the DB shows the stop moved while the live order didn't. Next poll relies on the DB value, leading to incorrect downstream stop logic.

**Fix.** Reorder: call `replaceOrder` first, only persist on success. If no Alpaca order to replace (`stopLossOrderId` is null), fall through to the DB write. On replace failure, log and return without persisting.

```diff
   private async handleFlashCrash(position: StockPosition, currentPrice: number) {
     const widenedStop = currentPrice * 0.95;
-    updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
     if (position.stopLossOrderId) {
       try {
         await this.alpaca.replaceOrder(position.stopLossOrderId, {
           stop_price: widenedStop.toFixed(2),
           limit_price: (widenedStop * 0.98).toFixed(2)
         });
-      } catch { /* order may already be filled/cancelled */ }
+        updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
+      } catch (error) {
+        logger.warn(
+          { error, positionId: position.id, stopLossOrderId: position.stopLossOrderId, widenedStop },
+          "flash-crash: failed to widen Alpaca stop; DB unchanged"
+        );
+        return;
+      }
+    } else {
+      updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
     }
     await this.alert("stop_triggered", position, { action: "flash_crash_hold", widenedStop });
     logger.warn({ ticker: position.ticker, currentPrice, widenedStop }, "flash crash protection widened stop and skipped auto-sell");
   }
```

**Note:** the `return` on Alpaca-failure also skips the alert and the trailing `logger.warn`, which is correct — we shouldn't claim flash-crash protection succeeded when it didn't.

## Task 4 (Major) — `position-monitor.ts:220-225` wash-sale uses broker fill timestamp

**Problem.** `trackWashSaleIfNeeded` uses `new Date()` for `loss_sale_date`. Wash-sale tracking books the sale at the moment monitoring code ran, not when the broker filled the order. After-hours fills, delayed reconciliation, or midnight crossings shift the 31-day cooldown by a day.

**Fix.** Add a `fillTimestamp` parameter to `trackWashSaleIfNeeded` and propagate from callers. The function already exists in:
- `position-monitor.ts:131` — `stopLossFilled()` — has `order` from Alpaca; pass `order.filled_at` (or fallback `new Date().toISOString()` if filled_at absent).
- `order-manager.ts` — multiple sites (`monitorOrders` sell branches): pass `order.filled_at` from the Alpaca order object.

Signature update:
```diff
-  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number) {
+  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number, fillTimestamp: string) {
     if (pnlUsd >= 0) return;
-    const saleDate = new Date().toISOString().slice(0, 10);
-    const cooldown = new Date();
+    const saleDate = fillTimestamp.slice(0, 10);
+    const cooldown = new Date(`${saleDate}T00:00:00.000Z`);
     cooldown.setUTCDate(cooldown.getUTCDate() + 31);
     insertWashSale(this.db, ticker, saleDate, cooldown.toISOString().slice(0, 10), Math.abs(pnlUsd));
   }
```

Caller in `position-monitor.ts:131`:
```diff
-      this.trackWashSaleIfNeeded(position.ticker, pnlUsd);
+      this.trackWashSaleIfNeeded(position.ticker, pnlUsd, order.filled_at ?? new Date().toISOString());
```

In `order-manager.ts`, `trackWashSaleIfNeeded` is also a method (look up the class — likely OrderManager has its own). Update the same way: signature change + pass `order.filled_at ?? new Date().toISOString()` from each call site. **Verify by grepping `trackWashSaleIfNeeded` across `src/` and updating every call site.**

If `order.filled_at` field doesn't exist on the Alpaca order type used (check `src/execution/alpaca-client.ts`), check Alpaca's field names — it's typically `filled_at` (snake_case). If the type is unspecified `any`, the cast works directly. If the type definition omits `filled_at`, widen it to include `filled_at?: string | null`.

## Task 5 (Major) — `index.ts:91-95` isolate health-check failures per source

**Problem.** `updateHealth()` iterates `[edgar, quiver, houseClerk]` and calls `await source.healthCheck()` directly. A throw from any source aborts the loop, so subsequent sources never get their `upsertSourceHealth` row updated. Result: a single transient error in (e.g.) edgar starves quiver and houseClerk health visibility.

**Fix.** Wrap each iteration in try/catch, persist failure as an unhealthy record on error:

```diff
 async function updateHealth() {
   for (const source of [edgar, quiver, houseClerk]) {
-    upsertSourceHealth(db, await source.healthCheck());
+    try {
+      upsertSourceHealth(db, await source.healthCheck());
+    } catch (error) {
+      logger.warn({ error, source: source.constructor.name }, "source healthCheck failed; recording unhealthy");
+      upsertSourceHealth(db, {
+        name: source.constructor.name,
+        status: "unhealthy",
+        message: error instanceof Error ? error.message : String(error),
+        lastCheckedAt: new Date().toISOString()
+      });
+    }
   }
 }
```

**Caveat:** the exact shape of the `upsertSourceHealth` payload (the synthesized unhealthy record) must match what the function expects. Read `upsertSourceHealth`'s signature in `src/db/queries.ts` (or wherever defined) and the `SourceHealth` type. Adjust field names accordingly. If the function expects a different shape (e.g. uses a `source` field instead of `name`, or requires additional fields like `lastSuccessAt`), match that shape — fall back to safe defaults (e.g. `lastSuccessAt: null`). If the function expects the full `HealthCheckResult` type and there's no clean way to synthesize unhealthy without breaking invariants, the minimal acceptable fix is just to log and continue (no upsert on failure):

```diff
 async function updateHealth() {
   for (const source of [edgar, quiver, houseClerk]) {
-    upsertSourceHealth(db, await source.healthCheck());
+    try {
+      upsertSourceHealth(db, await source.healthCheck());
+    } catch (error) {
+      logger.warn({ error, source: source.constructor.name }, "source healthCheck failed");
+    }
   }
 }
```

This still satisfies the finding (loop no longer aborts on first throw), even if it doesn't write an unhealthy record. Pick the simpler form if `upsertSourceHealth`'s contract is strict; pick the synthesized-unhealthy form if it's a thin wrapper that accepts free-form payloads.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions from prior reviews (atomic markRebalanceRun, completion stamp split, SSE broadcast path, reconcile-failed reservation release, closeStockPosition quantity reduction, pnl_ratio null-clear, pendingExitQty gates).
- Skipped findings:
  - 🟡 Minor `schema.ts:99` index `idx_executions_position_id` — optimization, not correctness; defer.
