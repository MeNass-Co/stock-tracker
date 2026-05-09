**Actionable comments posted: 2**

> [!CAUTION]
> Some comments are outside the diff and can’t be posted inline due to platform limitations.
> 
> 
> 
> <details>
> <summary>⚠️ Outside diff range comments (4)</summary><blockquote>
> 
> <details>
> <summary>src/execution/position-monitor.ts (4)</summary><blockquote>
> 
> `207-214`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Do not mutate local stop state before Alpaca accepts the replace.**
> 
> `stopLossPrice` is widened in SQLite before `replaceOrder()` succeeds, and the catch swallows every failure. If Alpaca rejects the replace or the call flakes, the DB says the stop moved while the live order did not.
> 
>  
> 
> <details>
> <summary>Possible fix</summary>
> 
> ```diff
>    private async handleFlashCrash(position: StockPosition, currentPrice: number) {
>      const widenedStop = currentPrice * 0.95;
> -    updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
>      if (position.stopLossOrderId) {
>        try {
>          await this.alpaca.replaceOrder(position.stopLossOrderId, {
>            stop_price: widenedStop.toFixed(2),
>            limit_price: (widenedStop * 0.98).toFixed(2)
>          });
> -      } catch { /* order may already be filled/cancelled */ }
> +        updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
> +      } catch (error) {
> +        logger.warn({ error, positionId: position.id, stopLossOrderId: position.stopLossOrderId }, "failed to widen flash-crash stop");
> +        return;
> +      }
> +    } else {
> +      updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
>      }
> ```
> </details>
> 
> As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-monitor.ts` around lines 207 - 214, Do not persist the
> widened stop to the DB until Alpaca confirms the replace: call
> this.alpaca.replaceOrder(position.stopLossOrderId, {...}) first, await its
> successful response, and only then call updateStockPositionStops(this.db,
> position.id, { stopLossPrice: widenedStop }); also replace the empty catch with
> proper error handling—log the error (include replaceOrder request/response
> context and position.id/stopLossOrderId) and avoid swallowing failures so you
> can decide rollback or retry; ensure any thrown error prevents the DB write when
> replaceOrder fails.
> ```
> 
> </details>
> 
> ---
> 
> `117-120`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
> 
> **Clear stale trailing-stop state before rearming a stop.**
> 
> If the rejected/expired order is `position.trailingStopOrderId`, this branch creates a new `stopLossOrderId` but leaves `trailingStopOrderId`/`trailingStopActive` intact. The next poll will hit the same dead trailing order again and resubmit another stop, and the position still looks trailing-protected for later time-stop checks.
> 
>  
> 
> <details>
> <summary>Possible fix</summary>
> 
> ```diff
>        if (order.status === "rejected" || order.status === "expired") {
>          logger.warn({ orderId, status: order.status, ticker: position.ticker }, "stop order rejected/expired — resubmitting");
> +        if (orderId === position.trailingStopOrderId) {
> +          updateStockPositionStops(this.db, position.id, {
> +            trailingStopActive: false,
> +            trailingStopOrderId: null
> +          });
> +        } else {
> +          updateStockPositionStops(this.db, position.id, { stopLossOrderId: null });
> +        }
>          const newStop = await this.orderManager.resubmitStopLoss(position);
>          if (newStop) updateStockPositionStops(this.db, position.id, { stopLossOrderId: newStop });
>          continue;
>        }
> ```
> </details>
> 
> As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-monitor.ts` around lines 117 - 120, The branch
> handling rejected/expired stop orders only writes a new stopLossOrderId via
> updateStockPositionStops after calling this.orderManager.resubmitStopLoss, but
> it fails to clear trailing-stop state when the dead order was
> position.trailingStopOrderId; update the logic in the order.status ===
> "rejected" || "expired" block to detect if order.id ===
> position.trailingStopOrderId and, when true, clear trailingStopOrderId and set
> trailingStopActive to false (in the same updateStockPositionStops call that
> writes stopLossOrderId/newStop), so the trailing-stop fields are not left stale
> and the position won't repeatedly rearm the dead trailing order (refer to
> order.status check, position.trailingStopOrderId, trailingStopActive,
> resubmitStopLoss, newStop, and updateStockPositionStops).
> ```
> 
> </details>
> 
> ---
> 
> `220-225`: _⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_
> 
> **Use the actual fill timestamp for wash-sale rows.**
> 
> `trackWashSaleIfNeeded()` stamps `loss_sale_date` with `new Date()` instead of the broker fill time. If reconciliation runs after midnight or is delayed, the 31-day cooldown shifts and wash-sale matching becomes off by a day.
> 
>  
> 
> <details>
> <summary>Possible fix</summary>
> 
> ```diff
> -  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number) {
> +  private trackWashSaleIfNeeded(ticker: string, pnlUsd: number, saleTimestamp: string) {
>      if (pnlUsd >= 0) return;
> -    const saleDate = new Date().toISOString().slice(0, 10);
> -    const cooldown = new Date();
> +    const saleDate = saleTimestamp.slice(0, 10);
> +    const cooldown = new Date(`${saleDate}T00:00:00.000Z`);
>      cooldown.setUTCDate(cooldown.getUTCDate() + 31);
>      insertWashSale(this.db, ticker, saleDate, cooldown.toISOString().slice(0, 10), Math.abs(pnlUsd));
>    }
> ```
> </details>
> 
> Then pass the order fill timestamp from `stopLossFilled()`.
> 
> As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-monitor.ts` around lines 220 - 225,
> trackWashSaleIfNeeded currently uses new Date() for loss_sale_date which can
> shift the 31-day cooldown; change it to accept a fill timestamp and use that
> instead. Update the signature of trackWashSaleIfNeeded(ticker: string, pnlUsd:
> number) to include a fillTimestamp (e.g., trackWashSaleIfNeeded(ticker: string,
> pnlUsd: number, fillTimestamp: string|Date)), replace the new Date() usage with
> the provided fillTimestamp when computing saleDate and computing the 31-day
> cooldown, and pass that same fillTimestamp into insertWashSale(this.db, ticker,
> saleDate, cooldownDate, Math.abs(pnlUsd)). Then propagate the call-site change
> from stopLossFilled() so stopLossFilled() passes the actual broker/order fill
> time into trackWashSaleIfNeeded. Ensure any other callers are updated
> accordingly.
> ```
> 
> </details>
> 
> ---
> 
> `140-145`: _⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_
> 
> **Do not place a trailing stop after a failed stop-loss cancel.**
> 
> This `catch` only logs, then the method continues into `submitOrder()`. If the original stop-loss is still live, the position ends up with two resting sell orders and can over-exit on the next move.
> 
>  
> 
> <details>
> <summary>Possible fix</summary>
> 
> ```diff
>      if (position.stopLossOrderId) {
>        try {
>          await this.alpaca.cancelOrder(position.stopLossOrderId);
>        } catch (error) {
>          logger.warn({ error, positionId: position.id }, "failed to cancel stop loss before trailing stop activation");
> +        return;
>        }
>      }
> ```
> </details>
> 
> As per coding guidelines, `src/execution/**`: "This handles real money (paper trading but live execution path). Flag any logic that could corrupt P&L tracking, double-execute orders, or mis-attribute fills to wrong positions. Position lifecycle invariants are critical."
> 
> <details>
> <summary>🤖 Prompt for AI Agents</summary>
> 
> ```
> Verify each finding against current code. Fix only still-valid issues, skip the
> rest with a brief reason, keep changes minimal, and validate.
> 
> In `@src/execution/position-monitor.ts` around lines 140 - 145, The code attempts
> to cancel an existing stop-loss (position.stopLossOrderId via
> this.alpaca.cancelOrder) but only logs failures and then continues to call
> submitOrder, which can create a duplicate resting sell; change the control flow
> so that if this.alpaca.cancelOrder throws you do not proceed to submitOrder —
> either rethrow the error or return/abort the trailing-stop activation path (and
> keep the logger.warn) so a failed cancel prevents placing the trailing stop;
> reference position.stopLossOrderId, this.alpaca.cancelOrder, logger.warn and
> submitOrder to locate and update the logic.
> ```
> 
> </details>
> 
> </blockquote></details>
> 
> </blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@src/db/schema.ts`:
- Line 99: Add a DB index on the position_id foreign key to avoid table scans:
create a migration (and update the schema) that adds an index on the column that
defines position_id (the executions table row where position_id INTEGER
REFERENCES stock_positions(id))—name it clearly (e.g.,
idx_executions_position_id), create it CONCURRENTLY or using the project's
safe-index pattern, and ensure the migration is idempotent/uses IF NOT EXISTS so
findPositionById and execution→position joins benefit from the index.

In `@src/index.ts`:
- Around line 92-94: The loop over sources currently calls await
source.healthCheck() directly so a thrown error aborts the loop; update the loop
that iterates over edgar, quiver, houseClerk to try/catch each
source.healthCheck() invocation, call upsertSourceHealth(db, ...) on success
with the returned health result, and on failure call upsertSourceHealth(db,
{status: "unhealthy", error: err}) or similar to record the failure and then
continue to the next source; reference the source objects (edgar, quiver,
houseClerk), the async method healthCheck(), and the upsertSourceHealth function
when making the change.

---

Outside diff comments:
In `@src/execution/position-monitor.ts`:
- Around line 207-214: Do not persist the widened stop to the DB until Alpaca
confirms the replace: call this.alpaca.replaceOrder(position.stopLossOrderId,
{...}) first, await its successful response, and only then call
updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop });
also replace the empty catch with proper error handling—log the error (include
replaceOrder request/response context and position.id/stopLossOrderId) and avoid
swallowing failures so you can decide rollback or retry; ensure any thrown error
prevents the DB write when replaceOrder fails.
- Around line 117-120: The branch handling rejected/expired stop orders only
writes a new stopLossOrderId via updateStockPositionStops after calling
this.orderManager.resubmitStopLoss, but it fails to clear trailing-stop state
when the dead order was position.trailingStopOrderId; update the logic in the
order.status === "rejected" || "expired" block to detect if order.id ===
position.trailingStopOrderId and, when true, clear trailingStopOrderId and set
trailingStopActive to false (in the same updateStockPositionStops call that
writes stopLossOrderId/newStop), so the trailing-stop fields are not left stale
and the position won't repeatedly rearm the dead trailing order (refer to
order.status check, position.trailingStopOrderId, trailingStopActive,
resubmitStopLoss, newStop, and updateStockPositionStops).
- Around line 220-225: trackWashSaleIfNeeded currently uses new Date() for
loss_sale_date which can shift the 31-day cooldown; change it to accept a fill
timestamp and use that instead. Update the signature of
trackWashSaleIfNeeded(ticker: string, pnlUsd: number) to include a fillTimestamp
(e.g., trackWashSaleIfNeeded(ticker: string, pnlUsd: number, fillTimestamp:
string|Date)), replace the new Date() usage with the provided fillTimestamp when
computing saleDate and computing the 31-day cooldown, and pass that same
fillTimestamp into insertWashSale(this.db, ticker, saleDate, cooldownDate,
Math.abs(pnlUsd)). Then propagate the call-site change from stopLossFilled() so
stopLossFilled() passes the actual broker/order fill time into
trackWashSaleIfNeeded. Ensure any other callers are updated accordingly.
- Around line 140-145: The code attempts to cancel an existing stop-loss
(position.stopLossOrderId via this.alpaca.cancelOrder) but only logs failures
and then continues to call submitOrder, which can create a duplicate resting
sell; change the control flow so that if this.alpaca.cancelOrder throws you do
not proceed to submitOrder — either rethrow the error or return/abort the
trailing-stop activation path (and keep the logger.warn) so a failed cancel
prevents placing the trailing stop; reference position.stopLossOrderId,
this.alpaca.cancelOrder, logger.warn and submitOrder to locate and update the
logic.
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

**Run ID**: `8b9b1fac-02c5-4b02-b1a5-ed238fe25d59`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and e42d50b5ce9788b856f33ad63d4462cb7cac5bdc.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (31)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
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
* src/ingestion/capitol-trades.ts
* scripts/backtest.ts
* src/ingestion/senate-efd.ts
* src/parsing/ptr-parser.ts
* src/ingestion/unusual-whales.ts
* src/tracking/portfolio-diff.ts
* src/ranking/backtester.ts
* tests/parsing/form4-parser.test.ts
* src/config.ts
* package.json
* src/parsing/form4-parser.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
