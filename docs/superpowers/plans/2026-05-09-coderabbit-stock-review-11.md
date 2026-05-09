# CodeRabbit review #11 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T21:34:04Z against `c7a3ebc`.
**Findings:** 3 inline NEW (treat as 🟠 Major — execution lifecycle correctness, double-processing risk, race conditions on reserved positions). 0 Duplicates.
**Stop conditions:** 0 Critical + 0 Major NEW. Honor preserved decisions from reviews #1–#10.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` (now UPSERT to reclaim failed runs, iter 10), `completeRebalanceRun`, `markRebalanceRunFailed` UPDATE-to-`failed` (durable state, iter 7).
- SSE broadcast helper with try/catch JSON.stringify fallback `"null"` (iter 9), named heartbeat event.
- `pendingExitQty` reservation discipline. `applyPartialFill` `releaseReservation` boolean (default `true`); stop-origin call passes `false` (iter 10).
- `addPendingExit` clamps at zero via `MAX(0, COALESCE(pending_exit_qty, 0) + ?)` (iter 8).
- `markExecutionReconcileFailed` releases only `min(execution.quantity, currentPending)` slice (iter 10).
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired clears stale ids via direct prepared statement + mirrors mutation onto `position`.
- `activateTrailingStop` returns on cancelOrder failure; clears `stop_loss_order_id` in single prepared UPDATE.
- Senator/13f branches: bail out of discretionary actions when `stopLossOrderId || trailingStopOrderId` is present.
- `stopLossFilled` filled branch: route through `applyPartialFill(…, false)` when `filledQty < position.quantity` (iter 10).
- `monitorOrders` EOD: cancelOrder request marks notes only, defers reconciliation.
- `handleFlashCrash` persists DB only after Alpaca confirms.
- `trackWashSaleIfNeeded` cooldown anchored to fill date in UTC.
- `updateHealth` try/catch per source + canonical kebab-case source IDs (iter 8).
- `checkSenatorTimeStops` day-60 branch bounded to `60 ≤ ageDays < 90` (iter 8).
- `idx_stock_exec_position_id` exists in schemaSql + idempotentMigrations (iter 9).

## Task 1 (🟠 Major) — `order-manager.ts:257-275` persist fill fields on immediate-fill branch

**Problem.** `submitMarketExit` calls `updateStockExecutionOrder({ alpacaOrderId, alpacaClientOrderId, status })` immediately after Alpaca returns. When `mapOrderStatus(order.status) === "filled"` (immediate fill — common for liquid market orders), the code then calls `closeStockPosition` / `applyPartialFill` / `applyPostFillAction`, but the `stock_executions` row is never updated with `filled_price`, `filled_quantity`, `filled_at`, or `amount_usd`. Those columns stay NULL for an execution that was actually filled. Two concrete consequences:

1. `pendingStockExecutions(db)` and `monitorOrders` rely on `status` to decide which executions still need polling. With status='filled' but null fill columns, downstream consumers (analytics, P&L attribution by execution row, audit trail) see an inconsistent partial record.
2. The `mapOrderStatus(order.status)` for the second `updateStockExecutionOrder` call already wrote `status='filled'`. If `monitorOrders` later re-fetches the broker order on the next poll (defensive), it will treat the row as already terminal and skip it — but if any reconciliation path runs the execution against fill bookkeeping, it can double-process because the fill data is missing on the row.

**Fix.** Use the existing `updateStockExecutionFill(db, id, { status, filledPrice, filledQuantity, amountUsd })` helper (queries.ts:300-314) inside the `if (mapOrderStatus(order.status) === "filled")` branch, *before* the close/partial-fill side effects. Swap the second `updateStockExecutionOrder` call sequence so the filled branch persists everything atomically and the non-filled branch keeps the lighter `updateStockExecutionOrder` write.

```diff
-    updateStockExecutionOrder(this.db, executionId, {
-      alpacaOrderId: order.id,
-      alpacaClientOrderId: order.client_order_id,
-      status: mapOrderStatus(order.status)
-    });
-
-    if (mapOrderStatus(order.status) === "filled") {
-      const filledPrice = money(order.filled_avg_price ?? undefined);
-      const filledQty = money(order.filled_qty) || quantity;
-      const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * filledQty : null;
-      if (slicePnlUsd !== null && slicePnlUsd < 0) {
-        this.trackWashSaleIfNeeded(ticker, slicePnlUsd, order.filled_at ?? new Date().toISOString());
-      }
-      if (closeOnFill) {
-        closeStockPosition(this.db, positionId, reason, slicePnlUsd, filledQty);
-      } else {
-        applyPartialFill(this.db, positionId, filledQty, slicePnlUsd);
-        applyPostFillAction(this.db, executionId);
-      }
-    }
+    const status = mapOrderStatus(order.status);
+    updateStockExecutionOrder(this.db, executionId, {
+      alpacaOrderId: order.id,
+      alpacaClientOrderId: order.client_order_id,
+      status
+    });
+
+    if (status === "filled") {
+      const filledPrice = money(order.filled_avg_price ?? undefined);
+      const filledQty = money(order.filled_qty) || quantity;
+      const amountUsd = filledPrice > 0 ? filledPrice * filledQty : null;
+      const slicePnlUsd = filledPrice > 0 ? (filledPrice - position.avgEntryPrice) * filledQty : null;
+
+      updateStockExecutionFill(this.db, executionId, {
+        status: "filled",
+        filledPrice: filledPrice > 0 ? filledPrice : null,
+        filledQuantity: filledQty,
+        amountUsd
+      });
+
+      if (slicePnlUsd !== null && slicePnlUsd < 0) {
+        this.trackWashSaleIfNeeded(ticker, slicePnlUsd, order.filled_at ?? new Date().toISOString());
+      }
+      if (closeOnFill) {
+        closeStockPosition(this.db, positionId, reason, slicePnlUsd, filledQty);
+      } else {
+        applyPartialFill(this.db, positionId, filledQty, slicePnlUsd);
+        applyPostFillAction(this.db, executionId);
+      }
+    }
```

**Imports.** Add `updateStockExecutionFill` to the existing `import { ... } from "../db/queries.js"` line at the top of `order-manager.ts` if not already imported. Grep first; many helpers from queries.ts are already imported in this file.

**Why this is correct under the existing helper.** `updateStockExecutionFill` uses `coalesce(?, filled_*)` so passing `null` for fields keeps prior values — but in this branch we always have either valid numbers or `null` for missing data. The CASE in `filled_at` writes `datetime('now')` when status='filled' is passed, which is what we want for an immediate fill (broker's `order.filled_at` is preferred but the helper doesn't accept it; falling back to wall-clock `'now'` is acceptable because immediate fill happens within seconds of submission). If a tighter timestamp is needed later, extend the helper.

## Task 2 (🟠 Major) — `position-monitor.ts:142-156` clear stop ids after partial stop fill

**Problem.** When the resting stop fills partially (`filledQty < position.quantity`), the code calls `applyPartialFill(this.db, position.id, filledQty, pnlUsd, false)` then `trackWashSaleIfNeeded` and `alert`. It returns `true` — but the `stop_loss_order_id` / `trailing_stop_order_id` on the position row is **not cleared**. The next poll iteration calls `stopLossFilled(position)` again; the same `orderId` is fetched from Alpaca, returns `status="filled"`, the partial-fill bookkeeping runs **again** for the same fill — duplicating realized P&L and double-decrementing `quantity`.

**Fix.** Before returning `true` in the partial-fill branch, clear the matching stop id (and its mirror trailing-active flag) from both the DB and the in-memory `position` object so subsequent polls don't reprocess. Use a direct prepared statement (the column-clearing pattern from `stopLossFilled`'s rejected/expired branch is canonical here — `updateStockPositionStops` uses `coalesce(?, ...)` and can't NULL out via parameter).

```diff
       if (filledQty < position.quantity) {
         applyPartialFill(this.db, position.id, filledQty, pnlUsd, false);
+        if (orderId === position.trailingStopOrderId) {
+          this.db.prepare(
+            "UPDATE stock_positions SET trailing_stop_active = 0, trailing_stop_order_id = NULL WHERE id = ?"
+          ).run(position.id);
+          position.trailingStopActive = false;
+          position.trailingStopOrderId = null;
+        } else {
+          this.db.prepare(
+            "UPDATE stock_positions SET stop_loss_order_id = NULL WHERE id = ?"
+          ).run(position.id);
+          position.stopLossOrderId = null;
+        }
       } else {
         closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
       }
```

**Why partial-only.** The `else` branch (fully filled) calls `closeStockPosition` which marks the position closed; subsequent polls won't see it because `openStockPositions` filters on status. Only the partial branch leaves an open row that needs the stop ids cleared.

**Why both DB and in-memory.** Iter 6 / iter 7 / iter 8 established the pattern: every DB clear must be mirrored on the in-memory `position` object so subsequent code in the same `checkPosition()` call (e.g., `softStopTriggered`) sees consistent state.

## Task 3 (🟠 Major) — `position-monitor.ts:57-75` consolidate overlap guard at top of sleeve dispatch

**Problem.** `checkPosition()` calls `softStopTriggered` (which has its own guards), then dispatches to senator vs 13f branches. Both branches start with `if (!position.trailingStopActive) await this.activateTrailingStop(position, …)` — *before* checking `pendingExitQty` or resting-stop ids. So if a discretionary exit is in flight (`pendingExitQty > 0`) but no trailing stop is active yet, this iteration will arm a new trailing stop on top of the in-flight discretionary exit — racing two sell paths against each other. The senator-branch guard `(position.pendingExitQty ?? 0) === 0` exists on lines 63 & 67 but **doesn't cover the `activateTrailingStop` call on line 60**.

**Fix.** Add a single early guard immediately after `softStopTriggered`, *before* the sleeve dispatch, that returns when reservations or resting stops are present. This makes the invariant uniform across both sleeves and any future branches:

```diff
     if (await this.softStopTriggered(position, currentPrice)) return;
 
+    // Single overlap guard: if a discretionary exit is reserved or a stop is already
+    // resting, no per-sleeve discretionary action (trailing arm, take-profit, time stop)
+    // should fire this tick. softStopTriggered already returned if its preconditions
+    // matched; everything below is non-emergency.
+    if ((position.pendingExitQty ?? 0) > 0) return;
+    if (position.stopLossOrderId || position.trailingStopOrderId) return;
+
     if (position.sleeve === "senator") {
       if (pnlRatio !== null && pnlRatio >= 0.15 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
       const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
-      if (restingStop) return;
-      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open" && (position.pendingExitQty ?? 0) === 0) {
+      if (restingStop) return;  // belt-and-suspenders for activateTrailingStop side effect
+      if (pnlRatio !== null && pnlRatio >= 0.25 && position.status === "open") {
         await this.sellHalf(position, "take_profit");
         return;
       }
-      if (pnlRatio !== null && pnlRatio <= -0.15 && (position.pendingExitQty ?? 0) === 0) {
+      if (pnlRatio !== null && pnlRatio <= -0.15) {
         await this.exit(position, "time_stop");
         return;
       }
       if (pnlRatio !== null) await this.checkSenatorTimeStops(position, pnlRatio);
     } else {
       if (pnlRatio !== null && pnlRatio >= 0.2 && !position.trailingStopActive) await this.activateTrailingStop(position, 8);
       const restingStop = Boolean(position.stopLossOrderId || position.trailingStopOrderId);
       if (restingStop) return;
     }
```

**Why keep the per-sleeve `restingStop` checks.** `activateTrailingStop` cancels and replaces the existing stop, then writes new `trailing_stop_order_id` to both DB and `position` (iter 6 mutation mirror). After it runs, the in-memory `position.trailingStopOrderId` is truthy, so the per-sleeve `restingStop` re-check correctly halts further actions. The early guard stops us from arming when an exit is already reserved (the racing case); the per-sleeve check remains as belt-and-suspenders for the post-arm state on this same iteration.

**Why simplify the senator inline `pendingExitQty === 0` checks.** Once the early guard returns on `pendingExitQty > 0`, those inline checks are dead code — the guard already covers them. Remove them so the invariant has one source of truth (the early guard) instead of three.

**Why this matches `softStopTriggered` semantics.** `softStopTriggered` is the *emergency* path: price below stop_loss_price with no resting stop and no reservation. It's allowed to run before the early guard because its preconditions already include `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty` (line 96-98). The early guard fires only after `softStopTriggered` returns false — so the emergency path always runs first.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews — especially: `markRebalanceRunFailed` UPDATE-to-failed (no DELETE), `applyPartialFill` `releaseReservation=false` for stop-origin calls, MAX(0, …) clamps everywhere they exist.
- Files touched: `src/execution/order-manager.ts`, `src/execution/position-monitor.ts`.
