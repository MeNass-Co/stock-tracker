# CodeRabbit review #8 — execution plan

**PR:** MeNass89/stock-tracker#1 — review submitted 2026-05-09T20:45:29Z against `4ab64d1`.
**Findings:** 1 🔴 Critical + 3 🟠 Major.
**Stop conditions:** 0 Critical + 0 Major NEW. Honor preserved decisions from reviews #1–#7.

## Preserved decisions (do not regress)

- Atomic `markRebalanceRun` claim, `completeRebalanceRun`, `markRebalanceRunFailed` (durable failed state).
- SSE broadcast helper + named `heartbeat` event with try/catch + clearInterval + sseClients delete on write failure.
- `pendingExitQty` reservation, `applyPartialFill` (now refreshes pnl_usd/pnl_ratio on close), `applyPostFillAction`, `markExecutionReconcileFailed` releases reservation.
- `softStopTriggered` gates: `!stopLossOrderId && !trailingStopOrderId && !pendingExitQty`.
- `stopLossFilled` rejected/expired clears stale ids via direct prepared statement + mirrors mutation onto `position`.
- `activateTrailingStop` returns on cancelOrder failure; clears `stop_loss_order_id` in single prepared UPDATE alongside trailing fields.
- Senator/13f branches: bail out of discretionary actions when `stopLossOrderId || trailingStopOrderId` is present.
- `stopLossFilled` filled branch: route through `applyPartialFill` when `filledQty < position.quantity`.
- `monitorOrders` EOD: cancelOrder request marks notes only, leaves status untouched, defers reconciliation to next tick when broker confirms terminal state.
- `handleFlashCrash` persists DB only after Alpaca confirms.
- `trackWashSaleIfNeeded(ticker, pnlUsd, fillTimestamp)` cooldown anchored to fill date in UTC.
- `updateHealth` try/catch per source.

## Task 1 (🔴 Critical) — `position-monitor.ts:186-198` cap day-60 sellHalf at `ageDays < 90`

**Problem.** `checkSenatorTimeStops` runs day-90 exit only when `!position.trailingStopActive`. When a senator position is past day 90 with an active trailing stop, the day-90 branch is skipped — but the day-60 branch immediately below still fires for any `ageDays >= 60`. Result: a 95-day-old position with trailing stop active and `pnlRatio` in the −5% to +5% band queues a `sellHalf("time_stop")` that doesn't belong to the day-60 stage. This stacks a discretionary half-sell on top of the live trailing stop.

**Fix.** Bound the day-60 branch to `60 ≤ ageDays < 90` so the day-90 branch is the sole time-stop path past 90 days:

```diff
   private async checkSenatorTimeStops(position: StockPosition, pnlRatio: number) {
     const ageDays = Math.floor((Date.now() - new Date(position.openedAt).getTime()) / 86_400_000);
     if (ageDays >= 30 && !position.day30Checked && pnlRatio < -0.05) {
       markStockPositionTimeCheck(this.db, position.id, "day30_checked");
       await this.alert("time_stop", position, { action: "day30_flag", pnlRatio });
     }

     // Skip time-stop actions while any sell is already pending for this position.
     if ((position.pendingExitQty ?? 0) > 0) return;

     if (ageDays >= 90 && !position.trailingStopActive) {
       await this.exit(position, "time_stop");
       return;
     }
-    if (ageDays >= 60 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
+    if (ageDays >= 60 && ageDays < 90 && !position.day60ExitedHalf && pnlRatio >= -0.05 && pnlRatio <= 0.05) {
       await this.sellHalf(position, "time_stop");
     }
   }
```

**Why the iter-7 senator-branch guard isn't sufficient.** Iter 7 added `if (restingStop) return;` *before* `checkSenatorTimeStops`. That blocks day-60 / day-90 actions when a stop is resting, but `checkSenatorTimeStops` still fires when no stop is resting yet — and a position past day 90 with `trailingStopActive=true` (in-memory) but no live order id (e.g., trailing stop canceled by broker, not yet rearmed) could squeeze through. The boundary fix is the canonical guarantee that day-60 doesn't fire after day 90 regardless of stop state.

## Task 2 (🟠 Major) — `queries.ts:471-472` clamp `addPendingExit` at zero

**Problem.** `addPendingExit(positionId, quantity)` writes `pending_exit_qty = COALESCE(pending_exit_qty, 0) + ?`. The function is also used as a *rollback* with negative quantity — `addPendingExit(execution.positionId, -unfilled)` in `monitorOrders`'s cancelled/expired branch. Race / retry paths can drive `pending_exit_qty` below zero (e.g., `applyPartialFill` already decremented before reconcile-failed releases the same quantity again). Negative `pending_exit_qty` corrupts the reservation invariant relied on by `submitMarketExit`'s availability check (`Math.max(0, position.quantity - (position.pendingExitQty ?? 0))`), masking actual capacity.

**Fix.** Clamp at zero in the SQL:

```diff
 export function addPendingExit(db: Database.Database, positionId: number, quantity: number) {
-  db.prepare("UPDATE stock_positions SET pending_exit_qty = COALESCE(pending_exit_qty, 0) + ? WHERE id = ?").run(quantity, positionId);
+  db.prepare(
+    "UPDATE stock_positions SET pending_exit_qty = MAX(0, COALESCE(pending_exit_qty, 0) + ?) WHERE id = ?"
+  ).run(quantity, positionId);
 }
```

**Why this is safe for the additive path.** Normal reservation paths call `addPendingExit(positionId, +quantity)` with positive values. `MAX(0, n + positive)` ≡ `n + positive` whenever `n ≥ 0`, which is the intended invariant. Only the rollback path passes negative values, and there `MAX(0, ...)` enforces the floor.

## Task 3 (🟠 Major) — `index.ts:91-105` use stable kebab-case source IDs not `constructor.name`

**Problem.** `source.healthCheck()` returns a `SourceHealth` row keyed by a canonical kebab-case source name (e.g., `"edgar"`, `"quiver"`, `"house-clerk"`). The iter-5 failure path logs and inserts using `source.constructor.name` — which becomes the runtime class name (e.g., `"EdgarClient"`, `"QuiverClient"`, `"HouseClerkClient"`). Result: the success path writes one row keyed by canonical id; the failure path writes a *different* row keyed by class name. Health views read the canonical id and never see the failure rows; the canonical row stays stale at the last success.

**Fix.** Iterate with explicit canonical name tuples:

```diff
 async function updateHealth() {
-  for (const source of [edgar, quiver, houseClerk]) {
+  for (const [sourceName, source] of [
+    ["edgar", edgar],
+    ["quiver", quiver],
+    ["house-clerk", houseClerk]
+  ] as const) {
     try {
       upsertSourceHealth(db, await source.healthCheck());
     } catch (error) {
-      logger.warn({ error, source: source.constructor.name }, "source healthCheck failed; recording unhealthy");
+      logger.warn({ error, source: sourceName }, "source healthCheck failed; recording unhealthy");
       upsertSourceHealth(db, {
-        source: source.constructor.name,
+        source: sourceName,
         ok: false,
         checkedAt: new Date().toISOString(),
         message: error instanceof Error ? error.message : String(error)
       });
     }
   }
 }
```

**Verify canonical names.** Open each source class (`edgar`, `quiver`, `houseClerk` — likely in `src/ingestion/`) and confirm the `name` field returned by their `healthCheck()` payloads. Adjust the tuple keys to match exactly (e.g., maybe `"house_clerk"` with underscore, not kebab — match what the success path actually writes). Grep `upsertSourceHealth` and the source classes for the canonical key to confirm before editing.

## Task 4 (🟠 Major) — rename NDJSON file from `.json` to `.jsonl`

**Problem.** `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json` contains multiple top-level objects (one per line — newline-delimited JSON), but the `.json` extension promises a single JSON value. Biome / any JSON parser fails on lines 2+. CodeRabbit flags as 🟠 Major.

**Fix.** Rename to `.jsonl`. The rename has already been staged in the working tree via `git mv`. Codex must verify the rename is in place and not regress it; no content edit needed.

```bash
# Already done before plan execution:
git mv docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json \
       docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.jsonl
```

If Codex sees the file still under the old name, it should perform the rename. Otherwise leave it.

## Verification

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Stop conditions

- Any test failure unexplained by these tasks → stop and report.
- Honor preserved decisions across all prior reviews.
- Files touched: `src/execution/position-monitor.ts`, `src/db/queries.ts`, `src/index.ts` (+ rename of one notes file).
