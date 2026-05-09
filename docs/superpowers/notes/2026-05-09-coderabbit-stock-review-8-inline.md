===PATH=docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json LINE=7===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**This file is not valid JSON in its current `.json` form.**

Lines 1-7 contain multiple top-level objects, which triggers parse failures (matching the Biome errors). If this is meant to be JSON, wrap entries in an array; if it is JSONL/NDJSON, rename to `.jsonl` to avoid parser breakage.

<details>
<summary>🧰 Tools</summary>

<details>
<summary>🪛 Biome (2.4.14)</summary>

[error] 2-2: End of file expected

(parse)

---

[error] 3-3: End of file expected

(parse)

---

[error] 4-4: End of file expected

(parse)

---

[error] 5-5: End of file expected

(parse)

---

[error] 6-6: End of file expected

(parse)

---

[error] 7-7: End of file expected

(parse)

</details>

</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/notes/2026-05-09-coderabbit-stock-review-7-inline.json`
around lines 1 - 7, The file contains multiple top-level JSON objects (not a
single JSON document), which breaks parsers; fix by either wrapping all
top-level objects in a JSON array (add leading "[" and trailing "]" and
comma-separate each object) so the file becomes valid JSON, or convert the file
to newline-delimited JSON (NDJSON/JSONL) and rename it to use the .jsonl
extension so each object is its own JSON line; ensure the final file parses with
JSON.parse (for array form) or line-by-line parsing (for jsonl).
```

</details>

<!-- fingerprinting:phantom:poseidon:hawk -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

===PATH=docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md LINE=133===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Guard pending-exit rollback against underflow.**

The statement that clamping is unnecessary is unsafe in failure/reconcile edge paths; `addPendingExit(..., -quantity)` can drive `pending_exit_qty` below zero if prior decrements already happened or retries race. Keep rollback bounded at DB level (e.g., `MAX(0, ...)`) or release only computed unfilled remainder.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-2.md` at line 133,
The rollback using addPendingExit(..., -quantity) can underflow pending_exit_qty
in races or retry paths; modify the DB update logic that computes
pending_exit_qty (the COALESCE(pending_exit_qty, 0) + ?) to clamp the result at
zero (e.g., wrap with MAX(0, ...)) or otherwise compute and apply only the
remaining unfilled amount before subtracting; update the SQL/DB-side expression
where pending_exit_qty is adjusted (referencing pending_exit_qty and
addPendingExit) so the column never becomes negative.
```

</details>

<!-- fingerprinting:phantom:triton:hawk -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

===PATH=docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md LINE=131===
_⚠️ Potential issue_ | _🔴 Critical_ | _⚡ Quick win_

**Day-60 branch can still trigger after day 90.**

The proposed logic is not truly 60–90 bounded: when `ageDays >= 90` and `trailingStopActive` is true, the day-90 exit branch is skipped and the day-60 branch still runs (`ageDays >= 60`). Add an upper bound (`ageDays < 90`) to the day-60 condition to preserve intended time-stop sequencing.
 


Also applies to: 135-136

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@docs/superpowers/plans/2026-05-09-coderabbit-stock-review-3.md` around lines
125 - 131, The day-60 time-stop branch currently fires for any ageDays >= 60, so
when ageDays >= 90 and trailingStopActive is true the day-90 exit is skipped but
the day-60 logic still runs; update the condition that checks ageDays for the
sellHalf call (the branch referencing position.day60ExitedHalf, pnlRatio and
sellHalf) to include an upper bound (ageDays < 90) so it only runs for 60 <=
ageDays < 90, and apply the same change to the other spot mentioned; keep
references to position, ageDays, position.trailingStopActive, exit, sellHalf,
position.day60ExitedHalf and pnlRatio to locate the two places to change.
```

</details>

<!-- fingerprinting:phantom:triton:hawk -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

===PATH=src/index.ts LINE=103===
_⚠️ Potential issue_ | _🟠 Major_ | _⚡ Quick win_

**Use stable source IDs in the failure path, not `constructor.name`.**

On Line 98, `source.constructor.name` can differ from the canonical key used by successful `healthCheck()` payloads (for example kebab-case source IDs). That can split health rows and leave the real source status stale.

 

<details>
<summary>Suggested fix</summary>

```diff
 async function updateHealth() {
-  for (const source of [edgar, quiver, houseClerk]) {
+  for (const [sourceName, source] of [
+    ["edgar", edgar],
+    ["quiver", quiver],
+    ["house-clerk", houseClerk],
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
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@src/index.ts` around lines 92 - 103, The failure path uses
source.constructor.name which can differ from the canonical source id used by
successful healthCheck() results and will split health rows; change the code to
use a stable source identifier (the same key produced by healthCheck and
accepted by upsertSourceHealth). Specifically, update the catch block to read a
stable id from the source object (e.g., source.id or source.getId()) or, if that
property/method doesn't exist, add one to each source implementation so you can
call the same identifier in the catch and in the success path instead of
source.constructor.name; ensure upsertSourceHealth is passed that stable id so
both success and failure paths use the identical source id.
```

</details>

<!-- fingerprinting:phantom:poseidon:hawk -->

<!-- 4e71b3a2 -->

<!-- This is an auto-generated comment by CodeRabbit -->

