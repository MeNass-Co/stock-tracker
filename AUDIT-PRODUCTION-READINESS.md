# Production Readiness Audit Report
**Date:** 2026-04-25
**Auditor:** Senior Systematic Trading Operations Engineer
**Systems:** Stock Tracker (Equities) + Solana Whale Watcher (Crypto)

---

## PRODUCTION READINESS SCORE: 62/100

The systems are well-architected for paper trading. Significant gaps remain before live money deployment. Both systems have solid signal filtering, risk sizing, and circuit breakers. The critical deficiencies are in crash recovery, position reconciliation, monitoring, and operational procedures.

---

## BLOCKERS (Must fix before live trading)

### B1. CREDENTIALS COMMITTED TO GIT (Solana) [BLOCKER]
**File:** `/solana-whale-watcher/.env` is **git-tracked** (`git ls-files .env` returns TRACKED).
The `.env` contains:
- Helius API key
- Helius webhook secret
- Discord webhook URLs with tokens
- API auth token

**Impact:** All secrets are in the git history. Even adding `.gitignore` now won't purge them.
**Fix:** `git rm --cached .env`, add to `.gitignore`, rotate ALL exposed credentials, run `git filter-repo` or BFG to purge history.

### B2. NO POSITION RECONCILIATION ON STARTUP (Both systems) [BLOCKER]
**Stock Tracker:** On crash/restart, the system starts fresh polling cycles. If a crash happens between:
1. Order submitted to Alpaca but DB not updated (line 98-112, `order-manager.ts`)
2. Order filled at Alpaca but position not created in DB (`createPositionIfNeeded` never runs)
3. Stop-loss order filled but `closeStockPosition` never called

There is NO startup reconciliation that compares `alpaca.getPositions()` against `openStockPositions(db)`.

**Solana Whale Watcher:** Same pattern. If crash occurs between `executeSwap` success and `openPosition` DB write (`trade-executor.ts:100-124`), the position exists on-chain but not in the DB. No on-chain balance check at startup.

**Impact:** Ghost positions (real money at risk with no tracking), phantom positions (DB thinks we hold something we don't), orphaned stop-loss orders.
**Fix:** Add a `reconcile()` function that runs before any trading resumes after startup. Compare broker/chain state against DB state, alert on divergence, freeze trading until resolved.

### B3. GRACEFUL SHUTDOWN DOES NOT AWAIT IN-FLIGHT OPERATIONS (Both systems) [BLOCKER]
**Stock Tracker** (`index.ts:41-42`):
```
process.on("SIGTERM", () => { logger.info("SIGTERM received"); db.close(); process.exit(0); });
```
If an order submission is in-flight (the `await this.alpaca.submitOrder()` call in `order-manager.ts:99`), SIGTERM kills the process immediately. The order may have been accepted by Alpaca but the DB never records the `alpacaOrderId`. On restart, the execution row has status "pending" with no order ID -- the `monitorOrders` loop skips it (`if (!execution.alpacaOrderId) continue;` at line 117).

**Solana:** Same -- SIGTERM does not even close the DB (`index.ts:27`).
**Fix:** Track in-flight operations, implement a drain period (e.g. 10s) before shutdown.

### B4. NO DEAD-MAN'S-SWITCH / EXTERNAL HEALTH MONITORING (Both systems) [BLOCKER]
Neither system has:
- External health check pings (healthchecks.io, Better Stack)
- Heartbeat alerts ("I'm still alive" every N minutes)
- Alert on "no webhook received in X hours" (Solana)
- Alert on "no poll completed in X hours" (Stock Tracker)

`launchd` will restart on crash, but silent failures (hung event loop, API returning errors, cloudflare tunnel down with no reconnect) go undetected.

**Impact:** System can be broken for days without operator awareness.
**Fix:** Add a heartbeat job that pings an external monitoring service. Alert if heartbeat is missed.

### B5. CLOUDFLARE QUICK TUNNEL URL IS EPHEMERAL (Solana) [BLOCKER]
The tunnel script uses `cloudflared tunnel --url http://localhost:3000` which generates random `*.trycloudflare.com` URLs. When tunnel restarts (laptop sleep, network change), the URL changes. The script does restart the whale-watcher to sync the new URL, but:
- If the webhook update to Helius fails, ALL incoming whale transactions are silently lost
- There is no alert when the tunnel URL changes
- There is no health check confirming webhooks are flowing

**Impact:** Complete blindness -- no whale trades detected, no convergence signals, no entries/exits triggered.
**Fix:** Use a named Cloudflare tunnel with a stable hostname, or add a webhook health check that alerts if no events received in 30 minutes.

---

## HIGH SEVERITY (Fix before live, acceptable for paper)

### H1. NO DATABASE BACKUP MECHANISM (Both systems) [HIGH]
Neither system has automated SQLite backups. Both run WAL checkpoints every 4 hours (good), but:
- No periodic `.backup()` calls to a separate file
- No backup rotation
- No offsite copy
- If the SQLite file corrupts (disk issue, hard power loss during WAL flush), all trade history and position state is lost

**Fix:** Add `db.backup()` to a timestamped file daily. Keep 7 days of rotated backups.

### H2. RATE LIMITER SERIALIZES ALL ALPACA REQUESTS (Stock Tracker) [HIGH]
`rate-limiter.ts` chains all requests sequentially at 4 req/s. During `monitorOrders()`, each pending execution calls `getOrder()` sequentially. With 8+ positions each needing order checks AND stop-loss order checks, this takes 4+ seconds minimum. During this time, no other Alpaca calls can run.

Alpaca's actual limit is 200 req/min. The current implementation is ~16x slower than necessary.

**Impact:** Stale data during position monitoring. In a fast-moving market, stop-loss checks are delayed.
**Fix:** Implement a proper token-bucket rate limiter allowing concurrency up to a configurable limit.

### H3. MARKET EXIT ASSUMES IMMEDIATE FILL (Stock Tracker) [HIGH]
`submitMarketExit()` in `order-manager.ts:158-190` submits a market sell and then immediately checks if status is "filled". Market orders on Alpaca may not fill instantly (especially after-hours, low-liquidity stocks). If the order is "accepted" but not yet "filled", the position is NOT closed in the DB. The `monitorOrders` loop will eventually catch it, but there's a window where the position is being closed but still appears open.

**Impact:** Double exits -- the position monitor may trigger another exit for the same position.
**Fix:** Don't close position on the initial submit. Let `monitorOrders` handle fill detection.

### H4. SOLANA PAPER SWAP USES REAL JUPITER QUOTES (Solana) [HIGH]
`executePaperSwap()` in `jupiter-client.ts:161-180` calls the real Jupiter quote API. If Jupiter is down, paper trading fails entirely. The fallback (`fallbackOutputAmount`) only triggers on quote failure, not on Jupiter outage.

More importantly, paper swap `outputAmount` uses the quote's `outAmount`, which may differ significantly from actual execution. Paper P&L could diverge substantially from reality.

**Fix:** Add a more robust paper mode that doesn't depend on live Jupiter API availability.

### H5. NO IDEMPOTENCY KEY FOR CONVERGENCE EXECUTION (Solana) [HIGH]
In `trade-executor.ts:46-49`, the dedup check queries by `convergence_id` and `direction = 'BUY'`. But the convergence engine's `retryPendingExecutions()` (`convergence.ts:65-68`) can re-trigger execution for failed attempts. If the swap succeeds on retry but the first attempt also eventually confirms (delayed Solana confirmation), two positions could be opened.

**Fix:** Use a unique execution nonce. Before any swap, check if a filled execution already exists. Add a DB constraint.

### H6. STOP-LOSS ORDERS NOT RECONCILED ON STARTUP (Stock Tracker) [HIGH]
When the system restarts, existing stop-loss orders at Alpaca remain active. But if the stop-loss was filled during downtime, the DB never learns about it. The `stopLossFilled()` check in `position-monitor.ts` eventually catches it, but only on the next 5-minute poll cycle.

Worse: if the stop-loss order was replaced or cancelled by Alpaca (e.g., corporate action), no new stop is placed until the next check.

**Fix:** On startup, immediately check all open positions' stop-loss order statuses before resuming normal operations.

### H7. DISCORD ALERTER THROWS ON FAILURE (Stock Tracker) [HIGH]
In `discord.ts` (Stock Tracker), the final retry iteration throws: `throw new Error("Discord webhook failed: ${response.status}")`. This exception propagates up to the ingestion loop. If Discord is down, new trade ingestion fails silently because the error might not be caught properly in all code paths.

The Solana version handles this correctly (returns false, logs error).

**Fix:** Return false instead of throwing. Discord failure should never block trading operations.

---

## MEDIUM SEVERITY (Fix within first month of live)

### M1. NO MARKET CALENDAR AWARENESS (Stock Tracker) [MEDIUM]
The execution window check (`isExecutionWindow()` in `order-manager.ts:395-397`) only checks current ET time (10:00-15:45). It does not check:
- Market holidays (Christmas, Thanksgiving, etc.)
- Half trading days (day after Thanksgiving closes at 13:00)
- The system will try to trade on holidays, fail, and log errors

`getClock()` is called but only for `is_open`. Alpaca returns correct holiday status, but half-days need separate calendar handling for the 15:45 EOD cancel logic.

**Fix:** Use `alpaca.getCalendar()` to check for holidays and early closes. Adjust EOD cancel time accordingly.

### M2. CORPORATE ACTIONS NOT HANDLED (Stock Tracker) [MEDIUM]
No handling for:
- Stock splits (position quantity becomes wrong, stop-loss prices invalid)
- Reverse splits (same)
- Ticker changes (GOOGL -> GOOG style, symbol not found)
- Delistings (position stuck open forever)
- Spinoffs (new ticker appears, old position value changes)

**Fix:** Subscribe to Alpaca's corporate actions API. On split/reverse-split, adjust position quantity and stop-loss prices.

### M3. FLASH CRASH HANDLER WIDENS STOPS INSTEAD OF EXITING (Stock Tracker) [MEDIUM]
`handleFlashCrash()` in `position-monitor.ts:174-187` detects a >10% drop and WIDENS the stop-loss instead of exiting. This means if the stock is genuinely crashing, the system holds longer and potentially loses more.

**Impact:** Increased losses in genuine crash scenarios.
**Fix:** Consider exiting on flash crash, or at minimum alert the operator immediately and wait for manual decision.

### M4. WEBHOOK PROCESSING IS SEQUENTIAL AND UNQUEUED (Solana) [MEDIUM]
The Helius webhook handler (`webhooks.ts`) processes all trades in a `for` loop within a single request. If processing one trade takes time (convergence check, position exit), Helius may timeout the webhook delivery and retry. This could cause:
- Duplicate trade processing (though `trades.insert()` likely deduplicates)
- Missed webhooks if Helius gives up after retries

**Fix:** Queue webhook payloads and process asynchronously. Return 200 immediately after validation and queuing.

### M5. PAPER BALANCE TRACKING IGNORES UNREALIZED LOSSES (Solana) [MEDIUM]
`portfolioValueUsd()` in `risk-engine.ts:156-168` uses `current_price_usd` which is only updated every 30 seconds by the position manager poll. During volatile moments, the portfolio value used for risk checks may be significantly stale.

### M6. `checking` FLAG IS NOT CRASH-SAFE (Solana) [MEDIUM]
`PositionManager.checking` boolean (`position-manager.ts:119`) prevents concurrent `checkOpenPositions()` calls. If `checkOpenPositions()` throws before `finally { this.checking = false }`, this is fine (it resets). But if the process crashes mid-check, the flag is irrelevant (in-memory). More importantly, there's no timeout -- a hung price check could block all position monitoring indefinitely.

**Fix:** Add a timeout to the entire `checkOpenPositions()` cycle.

### M7. REBALANCER WAITS 30 SECONDS BETWEEN SELLS AND BUYS (Stock Tracker) [MEDIUM]
`rebalancer.ts` has `await new Promise((resolve) => setTimeout(resolve, 30 * 1000))` between sell and buy phases. This is a fixed delay regardless of whether sells have actually filled. If sells haven't filled in 30s, the buys proceed with potentially insufficient cash.

**Fix:** Wait for sell fills (poll order status) before proceeding to buys, with a timeout.

### M8. NO LOG ROTATION (Both systems) [MEDIUM]
Both systems log to `data/launchd-stdout.log` and `data/launchd-stderr.log` via launchd. These files grow unbounded. On a Mac with limited SSD space, this could eventually cause disk full errors.

**Fix:** Add logrotate or use pino transport to rotate logs automatically.

---

## LOW SEVERITY (Nice to have)

### L1. SINGLE DISCORD WEBHOOK FOR BOTH SYSTEMS (Both systems) [LOW]
Both systems use the same Discord webhook URL. High-frequency whale trade alerts from Solana will drown out critical stock execution alerts.

**Fix:** Use separate Discord channels/webhooks per system, and per severity level.

### L2. NO BACKTEST VALIDATION OF LIVE PARAMETERS (Stock Tracker) [LOW]
There's a `backtest.ts` script, but no automated verification that the parameters in production match the backtested configuration.

### L3. WAL CHECKPOINT ERROR SILENTLY SWALLOWED (Both systems) [LOW]
Both systems have `try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}`. If checkpointing consistently fails, the WAL file grows unbounded, which degrades read performance and increases corruption risk.

**Fix:** Log checkpoint failures. Alert if WAL size exceeds a threshold.

### L4. YAHOO FINANCE PROVIDER NOT USED FOR LIVE PRICING (Stock Tracker) [LOW]
`yahoo-finance.ts` is imported but prices for position monitoring come from `alpaca.getPosition()`. If Alpaca's price feed lags or has issues, there's no fallback price source.

### L5. `unhandledRejection` CAUSES HARD EXIT (Both systems) [LOW]
Both systems call `process.exit(1)` on unhandled rejections. While launchd will restart them, any in-flight operations are lost. A single uncaught promise rejection in a non-critical path (e.g., Discord notification) kills the entire system.

**Fix:** Log the error but don't exit for non-critical unhandled rejections. Consider a counter -- exit after N unhandled rejections in M minutes.

---

## GO-LIVE CHECKLIST

### Before Paper Trading (Do Now)
- [ ] **B1**: Remove `.env` from git tracking in solana-whale-watcher, rotate all secrets
- [ ] **B4**: Set up external health monitoring (healthchecks.io or equivalent)
- [ ] **B5**: Stabilize Cloudflare tunnel URL or add webhook flow health check
- [ ] **H7**: Fix Discord alerter throwing on failure (Stock Tracker)

### Before Live Trading (After Paper Validation)
- [ ] **B2**: Implement startup reconciliation for both systems
- [ ] **B3**: Implement graceful shutdown with operation drain
- [ ] **H1**: Implement automated database backups
- [ ] **H2**: Upgrade rate limiter to proper token bucket
- [ ] **H3**: Fix market exit immediate-fill assumption
- [ ] **H5**: Add idempotency to convergence execution
- [ ] **H6**: Reconcile stop-loss orders on startup
- [ ] **M1**: Add market calendar awareness
- [ ] **M2**: Handle corporate actions (splits, delistings)
- [ ] **M4**: Queue webhook processing (Solana)

### Configuration Changes for Live
- [ ] Change `EXECUTION_MODE` from `paper` to `live`
- [ ] Change `ALPACA_PAPER` from `true` to `false`
- [ ] Set real Alpaca API keys (production, not paper)
- [ ] Set Solana wallet keys for live execution
- [ ] Reduce `MAX_DAILY_TRADES` initially (start with 1-2)
- [ ] Ensure `DEGEN_MODE=false` on Solana
- [ ] Verify all circuit breaker thresholds match risk tolerance
- [ ] Set up separate Discord channels for live vs paper alerts

### Operational Procedures Needed
- [ ] Position reconciliation runbook (manual steps when DB diverges from broker)
- [ ] Emergency stop procedure (kill switch that cancels all open orders AND positions)
- [ ] Post-crash recovery checklist
- [ ] Weekly P&L verification against broker statements
- [ ] Database backup verification (can we restore from backup?)
- [ ] Incident response for each external dependency failure

### Paper Trading Validation Criteria (2 weeks)
- [ ] Verify all 8 queued positions open correctly on Monday
- [ ] Confirm stop-loss orders appear at Alpaca for all positions
- [ ] Verify at least one position exit (stop-loss, take-profit, or time-stop) works end-to-end
- [ ] Confirm Discord alerts arrive for entries, exits, and system events
- [ ] Simulate a system restart mid-day and verify no state corruption
- [ ] Verify Solana convergence detection, entry, and exit for at least one token
- [ ] Verify circuit breakers trigger correctly (manually create conditions)
- [ ] Run for 5 consecutive days without manual intervention required

---

## ARCHITECTURE OBSERVATIONS

### What's Done Well
1. **Zod config validation** -- both systems validate all env vars at startup with clear schemas
2. **Risk engine layering** -- comprehensive circuit breakers (daily/weekly/monthly drawdown, loss streaks, VIX, TPS)
3. **Signal filtering** -- thorough qualification gates (ranking, committee alignment, wash sales, market cap, filing delay)
4. **Position sizing** -- proper Kelly-criterion-style sizing with hard caps (5% per position, 15% per senator, 25% per sector)
5. **SQLite WAL mode** -- correct for this use case, with periodic checkpoints
6. **Webhook HMAC verification** -- Solana properly verifies Helius signatures with timing-safe comparison
7. **Paper slippage simulation** -- Stock Tracker adds realistic slippage to paper fills
8. **Behavioral stops** -- Solana system exits when the whales that triggered convergence start selling
9. **Trade deduplication** -- Both systems have unique indexes preventing duplicate trade records

### Structural Risks
1. **Single-process architecture** -- both systems run everything in one Node.js process. A memory leak or hung API call affects all subsystems.
2. **MacBook-hosted production** -- laptop sleep, OS updates, network changes all affect uptime. Consider migrating to a VPS or dedicated server before live.
3. **Same DB for state and analytics** -- if a heavy analytics query runs during trading, it could delay time-sensitive operations due to SQLite's writer-locks-all behavior.
