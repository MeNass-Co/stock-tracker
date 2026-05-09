# CodeRabbit Stock Review #12 — Execution Plan (Iter 12)

**Source**: `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-12-raw.md`
**Base commit**: `443bdc2` (iter 11)
**Date**: 2026-05-09

## Triage

| # | Severity | File | Status |
|---|----------|------|--------|
| 1 | 🔴 Critical (DUPLICATE but unfixed) | `src/execution/position-monitor.ts` | NEW — must fix |
| 2 | 🟠 Major | `src/execution/order-manager.ts` | NEW — must fix |
| 3 | 🟠 Major | `src/execution/position-monitor.ts` | NEW — must fix |
| 4 | 🟡 Minor (quick win) | `src/api/server.ts` | NEW — easy fix |

Skipped: comments on plan-5 / plan-11 doc text — those describe earlier docs, not current code; current code already mirrors DB→memory and current `updateHealth` behavior is out of scope (no plan-5 code regression introduced).

---

## Task 1 — 🔴 Critical: move senator-exit behind shared overlap guard

**File**: `src/execution/position-monitor.ts`
**Function**: `checkPosition()`
**Lines**: ~50–84

**Problem**: `hasSenatorExit()` runs at line 50 BEFORE `stopLossFilled` (55), `softStopTriggered` (57), and the overlap guard (63–64). A senator sell can therefore queue a second `submitMarketExit` while shares are already reserved (`pendingExitQty > 0`) or while a stop order is already resting on Alpaca. It can also fire before a freshly-filled stop is reconciled.

**Fix** — reorder `checkPosition()` so the dispatch becomes:

```
flashCrash → stopLossFilled → softStopTriggered → overlap guard → senator-exit → per-sleeve branches
```

Concretely:

1. **Delete** the current senator-exit block at lines 50-53.
2. **Insert** the senator-exit block *immediately after* the overlap guard (after `if (position.stopLossOrderId || position.trailingStopOrderId) return;`), before the `if (position.sleeve === "senator")` branch:

```ts
if (await this.hasSenatorExit(position)) {
  await this.exit(position, "senator_exit");
  return;
}
```

Final order in `checkPosition()`:

```
1. updateStockPositionMarket
2. flashCrash check
3. stopLossFilled
4. softStopTriggered
5. overlap guard: pendingExitQty > 0 → return
6. overlap guard: stopLossOrderId || trailingStopOrderId → return
7. hasSenatorExit → exit("senator_exit")
8. sleeve dispatch (senator / 13f)
```

**Acceptance**:
- The two existing tests still pass.
- `npm run build` passes.
- `grep -n "hasSenatorExit\|exit(position, \"senator_exit\")" src/execution/position-monitor.ts` shows the call lives between the overlap guard and the sleeve branch.

---

## Task 2 — 🟠 Major: create position when partial buy is cancelled/expired with filled_qty > 0

**File**: `src/execution/order-manager.ts`
**Function**: `monitorOrders()`
**Lines**: ~136-145

**Problem**: The buy branch at line 136 only creates a position when `status === "filled" && direction === "buy"`. A buy that partially fills then gets cancelled or expires (status `cancelled` / `expired`, filled_qty > 0) leaves the broker holding shares while the DB has no `stock_positions` row — so subsequent stop-loss / monitoring logic can never see those shares.

**Fix** — extend the branch to also create a position for buys whose terminal status is `cancelled` or `expired` when `filled_qty > 0`. Use the order's filled quantity (not the original requested quantity) so the position quantity matches what the broker actually holds.

Replace the existing `if (status === "filled" && execution.direction === "buy")` block with:

```ts
if (execution.direction === "buy") {
  const buyFilledQty = money(order.filled_qty);
  const isTerminalWithFill =
    status === "filled" ||
    ((status === "cancelled" || status === "expired") && buyFilledQty > 0);
  if (isTerminalWithFill) {
    await this.createPositionIfNeeded(execution.id, order, {
      sleeve: execution.sleeve,
      triggerType: execution.triggerType,
      ticker: execution.ticker,
      senatorName: execution.senatorName,
      senatorRank: execution.senatorRank,
      fundName: execution.fundName,
      sector: null
    });
  }
}
```

Keep the existing `else if (execution.direction === "sell" && …)` branch unchanged. The `else if` chain still works because the `if` block returns no value and the sell branch is mutually exclusive on direction.

**Important**: do NOT regress the iter 7+ pending_exit_qty release path — the sell-side cancelled/expired branch at lines 174-179 (`addPendingExit(-unfilled)`) must remain intact.

**Acceptance**:
- Existing `createPositionIfNeeded` invariants (idempotent, only inserts when no row exists for that execution) preserved — verify by reading `createPositionIfNeeded` to confirm it doesn't double-insert.
- `npm test && npm run build` green.

---

## Task 3 — 🟠 Major: don't let alert() exception abort `checkAll` after submitMarketExit

**File**: `src/execution/position-monitor.ts`
**Function**: `softStopTriggered()`
**Lines**: ~111-117

**Problem**: After `submitMarketExit` queues the exit, `await this.alert("stop_triggered", …)` runs. If the alerting subsystem (Slack, webhook, etc.) throws, the exception propagates up through `checkPosition` and aborts the `for` loop in `checkAll`, skipping all subsequent positions — even though the exit was already queued successfully.

**Fix** — wrap the `alert()` call in a try/catch inside `softStopTriggered`. Log the failure with `logger.warn` (or `error`) including `positionId` and `ticker`. Do not rethrow.

```ts
try {
  await this.alert("stop_triggered", position, { exitReason: "soft_stop", pnlUsd, pnlRatio });
} catch (error) {
  logger.warn(
    { error, positionId: position.id, ticker: position.ticker },
    "soft-stop alert failed; exit was already queued, continuing monitor loop"
  );
}
return true;
```

Scope strictly limited to `softStopTriggered` per the review comment. Do not modify the `alert()` calls in `exit()`, `sellHalf()`, `activateTrailingStop()`, `handleFlashCrash()`, or `stopLossFilled` for this iter — narrow change matches the review.

**Acceptance**:
- `npm test && npm run build` green.
- `grep -A 6 "soft-stop alert failed" src/execution/position-monitor.ts` matches the new catch.

---

## Task 4 — 🟡 Quick win: SSE serialize fallback when JSON.stringify returns undefined

**File**: `src/api/server.ts`
**Function**: `broadcastSSE()`
**Lines**: ~15-22

**Problem**: `JSON.stringify(data)` returns `undefined` when given a top-level `undefined` (or a value whose replacer returns undefined). The current code:

```ts
let serialized = "null";
try {
  serialized = JSON.stringify(data);
} catch { /* … */ }
```

…silently overwrites the `"null"` initial with `undefined`, producing a payload like `data: undefined\n\n` which is not valid JSON for SSE consumers.

**Fix** — coerce the result with `??`:

```ts
let serialized = "null";
try {
  serialized = JSON.stringify(data) ?? "null";
} catch {
  serialized = "null";
}
```

Both branches now guarantee `serialized` is a string containing valid JSON.

**Acceptance**:
- `npm run build` passes.

---

## Verification (final)

After all four tasks:

1. `npm test` — must remain 2/2 green.
2. `npm run build` — typecheck + emit, must pass.
3. **DO NOT commit, push, or restart services.** Report which files changed and final test count.

## Preserved decisions (must not regress)

- Iter 7: `markRebalanceRunFailed` UPDATE-not-DELETE, durable failure state.
- Iter 8: day-60 sellHalf bounded `60 ≤ ageDays < 90`.
- Iter 9: `idx_stock_exec_position_id` in both bootstrap schemaSql AND idempotentMigrations; SSE try/catch with "null" fallback (Task 4 only tightens the success path).
- Iter 10: `applyPartialFill` `releaseReservation: boolean = true` param; `markExecutionReconcileFailed` SELECT-then-min in transaction; `markRebalanceRun` UPSERT of failed→in_progress.
- Iter 11: `updateStockExecutionFill` in immediate-fill branch of `submitMarketExit`; clear stop ids + mirror in-memory after partial stop fill in `stopLossFilled`; consolidated overlap guard at lines 63-64 of `checkPosition`.
- Iter 12 (this iter): senator-exit MUST be **after** overlap guard, never before.
