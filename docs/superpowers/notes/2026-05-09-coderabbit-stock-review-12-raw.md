**Actionable comments posted: 5**

<details>
<summary>♻️ Duplicate comments (1)</summary><blockquote>

<details>
<summary>src/execution/position-monitor.ts (1)</summary><blockquote>

`50-64`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Move the senator-exit branch behind the shared overlap guard.**

`hasSenatorExit()` still runs before `stopLossFilled()`, `softStopTriggered()`, and the `pendingExitQty` / resting-stop bailout. That means a senator sell can still queue a second market exit while shares are already reserved or a stop order is live, and it can also fire before a just-filled stop is reconciled.

<details>
<summary>Suggested fix</summary>

```diff
-    if (await this.hasSenatorExit(position)) {
-      await this.exit(position, "senator_exit");
-      return;
-    }
-
     if (await this.stopLossFilled(position)) return;
 
     if (await this.softStopTriggered(position, currentPrice)) return;
@@
     if ((position.pendingExitQty ?? 0) > 0) return;
     if (position.stopLossOrderId || position.trailingStopOrderId) return;
+
+    if (await this.hasSenatorExit(position)) {
+      await this.exit(position, "senator_exit");
+      return;
+    }
```
</details>

As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/execution/position-monitor.ts` around lines 50 - 64, Move the
senator-exit check so it runs after the shared overlap guard: ensure
hasSenatorExit(position) is invoked only after stopLossFilled(position),
softStopTriggered(position, currentPrice) and the two bailout checks for
(position.pendingExitQty ?? 0) > 0 and position.stopLossOrderId ||
position.trailingStopOrderId; if a senator exit is detected then call
exit(position, "senator_exit") as before. In short, reorder the branches so the
sequence is stopLossFilled -> softStopTriggered -> overlap guard (pendingExitQty
/ stopOrder checks) -> hasSenatorExit -> exit to prevent queuing a senator
market exit while shares are reserved or stops are live.
```

</details>

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`:
- Around line 172-188: The plan must not fall back to simply logging on
healthCheck failures — ensure updateHealth still writes an "unhealthy" record
via upsertSourceHealth even when source.healthCheck() throws; wrap the
per-source call in a try/catch inside updateHealth, call source.healthCheck() in
the try branch and pass its result to upsertSourceHealth, and in the catch
branch synthesize a SourceHealth/HealthCheckResult-shaped payload (use the
actual shape from upsertSourceHealth's signature in src/db/queries.ts and the
SourceHealth type) with safe defaults (e.g., status: "unhealthy", lastSuccessAt:
null, error message, source/name matching source.constructor.name) and pass that
to upsertSourceHealth so observability is preserved rather than skipping the DB
upsert.
- Around line 50-56: The DB update branch that clears trailing-stop fields
updates only the database and leaves the in-memory Position inconsistent; after
running the UPDATE in the branch that handles orderId ===
position.trailingStopOrderId, also set position.trailingStopOrderId = null and
position.trailingStopActive = false (mirror the same in-memory clears when the
other branch clears stop_loss_order_id) so the rest of the monitor tick uses the
updated state; locate the block that calls this.db.prepare(...
"trailing_stop_active = 0, trailing_stop_order_id = NULL ...").run(position.id)
and add the in-memory assignments for position.trailingStopOrderId and
position.trailingStopActive immediately after that call.

In `@src/api/server.ts`:
- Around line 16-23: The SSE payload can become invalid when
JSON.stringify(data) returns undefined, so update the serialization logic around
the serialized variable (used to build payload and sent to sseClients) to coerce
undefined to "null": in the try block assign serialized = JSON.stringify(data)
?? "null"; and in the catch ensure serialized = "null"; this guarantees the
payload creation (`const payload = \`event: ${event}\ndata:
${serialized}\n\n\``) always contains valid JSON.

In `@src/execution/order-manager.ts`:
- Around line 136-145: The current branch only calls createPositionIfNeeded for
status === "filled" and buy orders, which misses partially-filled buys that
later become "cancelled" or "expired"; update the logic in order-manager.ts (the
block around the createPositionIfNeeded call and any status checks for
execution.direction === "buy") to also treat status values "cancelled" and
"expired" as creating a position when the execution/order has a non-zero filled
quantity (check execution.filled_qty or order.filled_qty as available), and
invoke createPositionIfNeeded(execution.id, order, { sleeve: execution.sleeve,
triggerType: execution.triggerType, ticker: execution.ticker, senatorName:
execution.senatorName, senatorRank: execution.senatorRank, fundName:
execution.fundName, sector: null }) in those cases so partially-filled buys are
recorded.

In `@src/execution/position-monitor.ts`:
- Around line 106-116: The alert call after submitMarketExit is currently
allowed to throw and abort checkAll, potentially skipping later positions even
though submitMarketExit already queued the exit; wrap the
this.alert("stop_triggered", ...) call in a try/catch (inside the same block
after submitMarketExit) so any exception is caught, logged (use
logger.warn/error with positionId/ticker), and swallowed, preserving the
already-queued exit; keep submitMarketExit and pnl computation unchanged and do
not rethrow from the catch so monitoring continues for remaining positions.

---

Duplicate comments:
In `@src/execution/position-monitor.ts`:
- Around line 50-64: Move the senator-exit check so it runs after the shared
overlap guard: ensure hasSenatorExit(position) is invoked only after
stopLossFilled(position), softStopTriggered(position, currentPrice) and the two
bailout checks for (position.pendingExitQty ?? 0) > 0 and
position.stopLossOrderId || position.trailingStopOrderId; if a senator exit is
detected then call exit(position, "senator_exit") as before. In short, reorder
the branches so the sequence is stopLossFilled -> softStopTriggered -> overlap
guard (pendingExitQty / stopOrder checks) -> hasSenatorExit -> exit to prevent
queuing a senator market exit while shares are reserved or stops are live.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: Path: .coderabbit.yaml

**Review profile**: ASSERTIVE

**Plan**: Pro Plus

**Run ID**: `b20a97ef-211b-482f-9246-db86cb100561`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and 443bdc24c106f23507d0f8a03b604d4b0d807d9c.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (47)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-10-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-11-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-5-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-6-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.jsonl`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-8-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-8-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-9-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-10.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-11.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-6.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-7.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-8.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-9.md`
* `package.json`
* `scripts/backtest.ts`
* `scripts/test-migration.ts`
* `src/api/server.ts`
* `src/config.ts`
* `src/db/queries.ts`
* `src/db/schema.ts`
* `src/execution/order-manager.ts`
* `src/execution/position-monitor.ts`
* `src/execution/rebalancer.ts`
* `src/execution/risk-engine.ts`
* `src/index.ts`
* `src/ingestion/capitol-trades.ts`
* `src/ingestion/senate-efd.ts`
* `src/ingestion/unusual-whales.ts`
* `src/parsing/form4-parser.ts`
* `src/parsing/ptr-parser.ts`
* `src/ranking/backtester.ts`
* `src/tracking/portfolio-diff.ts`
* `src/types.ts`
* `tests/parsing/form4-parser.test.ts`

</details>

<details>
<summary>💤 Files with no reviewable changes (12)</summary>

* .env.example
* src/parsing/ptr-parser.ts
* scripts/backtest.ts
* tests/parsing/form4-parser.test.ts
* src/ingestion/capitol-trades.ts
* src/config.ts
* src/ingestion/unusual-whales.ts
* package.json
* src/ingestion/senate-efd.ts
* src/ranking/backtester.ts
* src/tracking/portfolio-diff.ts
* src/parsing/form4-parser.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
