**Actionable comments posted: 4**

<details>
<summary>♻️ Duplicate comments (1)</summary><blockquote>

<details>
<summary>scripts/test-migration.ts (1)</summary><blockquote>

`2-2`: _⚠️ Potential issue_ | _🟡 Minor_ | _⚡ Quick win_

**Use a fresh DB per run to avoid false-positive migration checks.**

Line 2 reuses a persistent file path, so reruns can validate against already-migrated state instead of a clean database.

  

<details>
<summary>Proposed fix</summary>

```diff
+import { mkdtempSync, rmSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
 import { openDatabase } from "../src/db/schema.js";
-const db = openDatabase("/tmp/stocktracker-test.db");
+const tempDir = mkdtempSync(join(tmpdir(), "stocktracker-migration-"));
+const dbPath = join(tempDir, "test.db");
+const db = openDatabase(dbPath);
 const cols = db.prepare("PRAGMA table_info(stock_positions)").all() as { name: string }[];
 console.log("stock_positions:", cols.map((c) => c.name).join(", "));
 const execCols = db.prepare("PRAGMA table_info(stock_executions)").all() as { name: string }[];
 console.log("stock_executions:", execCols.map((c) => c.name).join(", "));
 const snapCols = db.prepare("PRAGMA table_info(portfolio_snapshots)").all() as { name: string }[];
 console.log("portfolio_snapshots:", snapCols.map((c) => c.name).join(", "));
 const rebal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rebalance_runs'").get();
 console.log("rebalance_runs exists:", Boolean(rebal));
 db.close();
+rmSync(tempDir, { recursive: true, force: true });
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@scripts/test-migration.ts` at line 2, The test currently reuses a persistent
file at "/tmp/stocktracker-test.db" which causes stale/migrated state; change
the DB creation so each run gets a fresh database (e.g., generate a unique temp
filepath or use an in-memory DB) before calling openDatabase — replace the
hardcoded "/tmp/stocktracker-test.db" passed to openDatabase in the
scripts/test-migration.ts file (the const db assignment) with a unique temp
filename (timestamp/UUID/pid-based or OS temp utility) or ":memory:" as
supported so migrations always run against a clean DB.
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
In @.coderabbit.yaml:
- Line 18: Remove the exclusion rule that hides lockfiles by deleting or
disabling the pattern "!**/*.lock" in the ignore list so dependency lockfile
changes are included in review coverage; locate the "!**/*.lock" entry in the
.coderabbit.yaml ignore/coverage section and remove it (or replace it with a
documented comment if needed) so lockfiles are not excluded from scans.

In `@docs/superpowers/notes/2026-05-09-coderabbit-stock-review-4-inline.md`:
- Around line 182-190: The comment references reservation columns on
stock_executions that don't exist; update the review text for
markExecutionReconcileFailed to reflect the actual schema: explain that
pending_exit_qty is on stock_positions (not stock_executions) and that there is
no reserved_exit_qty column, so either adjust the suggested SQL to update
stock_positions (decrement pending_exit_qty using COALESCE/GREATEST) and clear
the actual reservation column(s) that exist in the schema, or mark this prompt
as obsolete/invalid; mention the function name markExecutionReconcileFailed and
the tables stock_executions and stock_positions so the next agent knows where to
apply the corrected guidance.
- Around line 119-127: The UPDATE in closeStockPosition currently adds
sliceFilledQty to realized_qty (recreating size) instead of decrementing
remaining shares to zero; change the quantity assignment in the same UPDATE to a
decrement-to-zero expression such as quantity = GREATEST(COALESCE(quantity, 0) -
COALESCE(?, 0), 0) (or equivalent) and update the SQL parameter placeholders and
the .run(...) call in closeStockPosition to pass sliceFilledQty at that new
placeholder while keeping the existing realized_qty, pnl and pnl_ratio
parameters where they are.

In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-7.md`:
- Around line 130-138: The CREATE TABLE for rebalance_runs must be updated to
match the new idempotentMigrations entries: add "status TEXT NOT NULL DEFAULT
'in_progress'," and "last_error TEXT" to the schema definition used for fresh
installs and also to the second inline CREATE TABLE copy, ensuring both the main
CREATE TABLE declaration and the copy in the idempotentMigrations array
reference the same columns; locate and edit the rebalance_runs CREATE TABLE
declarations and the idempotentMigrations array to keep them identical.

---

Duplicate comments:
In `@scripts/test-migration.ts`:
- Line 2: The test currently reuses a persistent file at
"/tmp/stocktracker-test.db" which causes stale/migrated state; change the DB
creation so each run gets a fresh database (e.g., generate a unique temp
filepath or use an in-memory DB) before calling openDatabase — replace the
hardcoded "/tmp/stocktracker-test.db" passed to openDatabase in the
scripts/test-migration.ts file (the const db assignment) with a unique temp
filename (timestamp/UUID/pid-based or OS temp utility) or ":memory:" as
supported so migrations always run against a clean DB.
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

**Run ID**: `acfc2d6e-fe64-4cac-8d42-87d23388d3e8`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between 80f071a6ddb588d38925e3e9bdc7231a64c13a05 and 585a4123c61b6deaa9cfa21433ce5a0792a9c7e1.

</details>

<details>
<summary>⛔ Files ignored due to path filters (3)</summary>

* `data/launchd-stderr.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/launchd-stdout.log` is excluded by `!**/*.log`, `!**/*.log`, `!data/**`
* `data/stock-tracker.sqlite` is excluded by `!data/**`

</details>

<details>
<summary>📒 Files selected for processing (49)</summary>

* `.coderabbit.yaml`
* `.env.example`
* `.gitignore`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-10-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-11-raw.md`
* `docs/superpowers/notes/2026-05-09-coderabbit-stock-review-12-raw.md`
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
* `docs/superpowers/plans/2026-05-09-coderabbit-stock-review-12.md`
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
* src/ingestion/senate-efd.ts
* package.json
* src/ranking/backtester.ts
* src/ingestion/unusual-whales.ts
* src/config.ts
* src/ingestion/capitol-trades.ts
* tests/parsing/form4-parser.test.ts
* src/tracking/portfolio-diff.ts
* src/parsing/form4-parser.ts
* scripts/backtest.ts
* src/parsing/ptr-parser.ts

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
