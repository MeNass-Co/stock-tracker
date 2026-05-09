**Actionable comments posted: 4**

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json`:
- Around line 1-7: The file contains multiple top-level JSON objects (not a
single JSON document), which breaks parsers; fix by either wrapping all
top-level objects in a JSON array (add leading "[" and trailing "]" and
comma-separate each object) so the file becomes valid JSON, or convert the file
to newline-delimited JSON (NDJSON/JSONL) and rename it to use the .jsonl
extension so each object is its own JSON line; ensure the final file parses with
JSON.parse (for array form) or line-by-line parsing (for jsonl).

In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`:
- Line 133: The rollback using addPendingExit(..., -quantity) can underflow
pending_exit_qty in races or retry paths; modify the DB update logic that
computes pending_exit_qty (the COALESCE(pending_exit_qty, 0) + ?) to clamp the
result at zero (e.g., wrap with MAX(0, ...)) or otherwise compute and apply only
the remaining unfilled amount before subtracting; update the SQL/DB-side
expression where pending_exit_qty is adjusted (referencing pending_exit_qty and
addPendingExit) so the column never becomes negative.

In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`:
- Around line 125-131: The day-60 time-stop branch currently fires for any
ageDays >= 60, so when ageDays >= 90 and trailingStopActive is true the day-90
exit is skipped but the day-60 logic still runs; update the condition that
checks ageDays for the sellHalf call (the branch referencing
position.day60ExitedHalf, pnlRatio and sellHalf) to include an upper bound
(ageDays < 90) so it only runs for 60 <= ageDays < 90, and apply the same change
to the other spot mentioned; keep references to position, ageDays,
position.trailingStopActive, exit, sellHalf, position.day60ExitedHalf and
pnlRatio to locate the two places to change.

In `@src/index.ts`:
- Around line 92-103: The failure path uses source.constructor.name which can
differ from the canonical source id used by successful healthCheck() results and
will split health rows; change the code to use a stable source identifier (the
same key produced by healthCheck and accepted by upsertSourceHealth).
Specifically, update the catch block to read a stable id from the source object
(e.g., source.id or source.getId()) or, if that property/method doesn't exist,
add one to each source implementation so you can call the same identifier in the
catch and in the success path instead of source.constructor.name; ensure
upsertSourceHealth is passed that stable id so both success and failure paths
use the identical source id.
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

**Run ID**: `aecc50dd-e246-41ce-98c6-41219c1065c4`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and 4ab64d130e5a5e7121a30ee46a618194ef974718.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (38)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-2-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-3-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-5-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-6-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-raw.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-4.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-5.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-6.md`
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-7.md`
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
* src/ingestion/unusual-whales.ts
* src/ingestion/senate-efd.ts
* src/tracking/portfolio-diff.ts
* src/parsing/form4-parser.ts
* scripts/backtest.ts
* src/ranking/backtester.ts
* tests/parsing/form4-parser.test.ts
* src/config.ts
* package.json
* src/parsing/ptr-parser.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
