# CodeRabbit review #6 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T20:09:09Z against `18f94a1`.
**Findings:** 3 🟠 Major + 1 🧹 Nitpick (config — skipped).
**Stop conditions:** 0 Critical + 0 Major NEW. Honor all preserved decisions from reviews #1–#5.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` claim, `clearRebalanceRun` on rebalance failure, `completeRebalanceRun` on success.
- SSE broadcast helper + named `heartbeat` event.
- `pendingExitQty` reservation, `closeStockPosition` reduces `quantity`, `applyPartialFill`, `applyPostFillAction`, `markExecutionReconcileFailed` releases reservation.
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired branch clears stale id at call site via direct prepared statement (avoids `coalesce()` null trap in `updateStockPositionStops`).
- `activateTrailingStop` returns on cancelOrder failure.
- `handleFlashCrash` persists `stopLossPrice` only after Alpaca `replaceOrder` succeeds; fall-through `else` persists when no `stopLossOrderId`.
- `trackWashSaleIfNeeded(ticker, pnlUsd, fillTimestamp)` cooldown anchored to broker fill date in UTC.
- `updateHealth` try/catch per source.

## Task 1 (🟠 Major) — `position-monitor.ts:165-169` clear stop_loss_order_id when trailing stop activates

**Problem.** `activateTrailingStop` calls `cancelOrder(stopLossOrderId)` then `updateStockPositionStops` with only trailing fields. The `stopLossOrderId` column stays populated, so if the trailing stop is later rejected/expired and `resubmitStopLoss` returns falsy, `softStopTriggered()` still sees a truthy `stopLossOrderId` and short-circuits the soft-stop fallback exit, leaving the position unprotected.

**Fix.** After `cancelOrder` success, clear `stopLossOrderId` in the same DB write. `updateStockPositionStops` uses `coalesce(?, ...)` for `stop_loss_order_id`, so a `null` parameter cannot clear it — emit a direct prepared statement at the call site to set both the trailing fields **and** clear `stop_loss_order_id` in one round-trip:

```diff
   private async activateTrailingStop(position: StockPosition, trailPercent: number) {
     if (position.stopLossOrderId) {
       try {
         await this.alpaca.cancelOrder(position.stopLossOrderId);
       } catch (error) {
         logger.warn({ error, positionId: position.id }, "failed to cancel stop loss before trailing stop activation");
         return;
       }
     }

     const wholeQty = Math.floor(position.quantity);
     if (wholeQty < 1) return;
     const order = await this.alpaca.submitOrder({
       symbol: position.ticker,
       qty: wholeQty.toString(),
       side: "sell",
       type: "trailing_stop",
       time_in_force: "gtc",
       trail_percent: trailPercent.toString(),
       client_order_id: `st-trail-${position.id}-${Date.now()}`
     });
-    updateStockPositionStops(this.db, position.id, {
-      trailingStopActive: true,
-      trailingStopPct: trailPercent,
-      trailingStopOrderId: order.id
-    });
+    this.db.prepare(
+      "UPDATE stock_positions SET trailing_stop_active = 1, trailing_stop_pct = ?, trailing_stop_order_id = ?, stop_loss_order_id = NULL WHERE id = ?"
+    ).run(trailPercent, order.id, position.id);
+    position.stopLossOrderId = null;
+    position.trailingStopActive = true;
+    position.trailingStopPct = trailPercent;
+    position.trailingStopOrderId = order.id;
     await this.alert("trailing_activated", position, { trailPercent });
   }
```

**Verify column names.** Open `src/db/schema.ts` and confirm: `trailing_stop_active`, `trailing_stop_pct`, `trailing_stop_order_id`, `stop_loss_order_id`. If the boolean column is `INTEGER` (SQLite), `1` is correct. If it's stored as text or named differently, match exactly. The `position.*` mutation mirrors the DB write so the in-memory object stays consistent for the rest of `checkPosition()`.

## Task 2 (🟠 Major) — `position-monitor.ts:117-126` sync in-memory state on rejected/expired stop and fall through if resubmit fails

**Problem.** When the Alpaca stop order is rejected/expired, the rejected/expired branch clears DB columns via direct prepared statement (correct), then calls `resubmitStopLoss(position)`:

- The in-memory `position` object still holds the old `trailingStopOrderId` / `stopLossOrderId` / `trailingStopActive`. If `resubmitStopLoss` returns falsy and the loop `continue`s past the next stop iteration, the rest of `checkPosition()` still sees stale truthy ids — `softStopTriggered()` short-circuits because `position.stopLossOrderId || position.trailingStopOrderId` is truthy, and the unprotected position skips the soft-stop fallback exit until the next poll.
- Even when `resubmitStopLoss` succeeds and writes the new stop id, `position.stopLossOrderId` remains stale until the next poll.

**Fix.** Mutate `position` to mirror every DB clear, and explicitly clear `position.stopLossOrderId = null` if `resubmitStopLoss` returns falsy so `softStopTriggered()` can fire on the same poll:

```diff
       if (order.status === "rejected" || order.status === "expired") {
         logger.warn({ orderId, status: order.status, ticker: position.ticker }, "stop order rejected/expired — resubmitting");
         if (orderId === position.trailingStopOrderId) {
           this.db.prepare("UPDATE stock_positions SET trailing_stop_active = 0, trailing_stop_order_id = NULL WHERE id = ?").run(position.id);
+          position.trailingStopActive = false;
+          position.trailingStopOrderId = null;
         } else {
           this.db.prepare("UPDATE stock_positions SET stop_loss_order_id = NULL WHERE id = ?").run(position.id);
+          position.stopLossOrderId = null;
         }
         const newStop = await this.orderManager.resubmitStopLoss(position);
-        if (newStop) updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
+        if (newStop) {
+          updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
+          position.stopLossOrderId = newStop;
+        } else {
+          position.stopLossOrderId = null;
+        }
         continue;
       }
```

**Why no fallthrough to `softStopTriggered` here.** `checkPosition()` already calls `softStopTriggered(position, currentPrice)` after `stopLossFilled(position)` returns. Once `position.stopLossOrderId`/`trailingStopOrderId` are correctly nulled in-memory, that subsequent call observes the cleared state and triggers the market exit if `currentPrice ≤ stopLossPrice`. Do not duplicate the soft-stop logic inside `stopLossFilled`.

## Task 3 (🟠 Major) — `position-monitor.ts:131-136` use broker-filled quantity for P&L and close

**Problem.** When the resting stop fills, the close path uses `position.quantity` for `pnlUsd` and `closeStockPosition`. For partial fills or fractional shares the broker-actual quantity may diverge — booking pnl on the *requested* quantity instead of the *filled* quantity mis-attributes P&L and (combined with `closeStockPosition`'s quantity reducer from review #4) can leave the position in an inconsistent quantity state.

**Fix.** Read `order.filled_qty` (string, present on `AlpacaOrder` per `src/execution/alpaca-client.ts:46`), parse to number, fall back to `position.quantity` if missing/non-finite. Use that filled quantity throughout:

```diff
       if (order.status !== "filled") continue;

       const filledPrice = money(order.filled_avg_price ?? undefined) || position.stopLossPrice || position.currentPrice || position.avgEntryPrice;
-      const pnlUsd = (filledPrice - position.avgEntryPrice) * position.quantity;
+      const filledQty = money(order.filled_qty) || position.quantity;
+      const pnlUsd = (filledPrice - position.avgEntryPrice) * filledQty;
       const pnlRatio = position.avgEntryPrice > 0 ? (filledPrice - position.avgEntryPrice) / position.avgEntryPrice : null;
       const exitReason = orderId === position.trailingStopOrderId ? "trailing_stop" : "stop_loss";
-      closeStockPosition(this.db, position.id, exitReason, pnlUsd, position.quantity);
+      closeStockPosition(this.db, position.id, exitReason, pnlUsd, filledQty);
       this.trackWashSaleIfNeeded(position.ticker, pnlUsd, order.filled_at ?? new Date().toISOString());
```

**`money()` semantics.** Existing helper at the bottom of the file accepts `string | number | undefined` and returns `0` for non-finite. `money(order.filled_qty) || position.quantity` returns `position.quantity` when broker reports `0` or missing — this is a safe fallback because a stop fill claiming zero quantity shouldn't book a close, but consumers downstream of `closeStockPosition` already handle quantity reduction safely.

**Don't propagate `filledQty` to `trackWashSaleIfNeeded` arguments.** The wash-sale function uses `pnlUsd` (already corrected via `filledQty`) and `fillTimestamp`; quantity is not part of its signature.

## Skipped finding

- 🧹 **Nitpick** — `.coderabbit.yaml:5-27` add `reviews.pre_merge_checks` and docstring coverage. Configuration enhancement, not correctness; not Critical/Major. Defer.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews.
- Single file touched: `src/execution/position-monitor.ts`.
