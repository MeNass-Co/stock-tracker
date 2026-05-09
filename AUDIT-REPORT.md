# Infrastructure, Security & Reliability Audit Report
**Date:** 2026-04-25
**Systems:** Solana Whale Watcher + US Stock Tracker
**Auditor:** DevOps/Security Engineer (Claude Opus 4.6)
**Verdict:** NOT PRODUCTION-READY -- Critical secrets exposure, no backups, no log rotation

---

## 1. SECURITY AUDIT -- Grade: D

### 1.1 API Key Storage & Exposure -- CRITICAL

**Stock Tracker `.env`** (file: `/Users/nassimlecornet/Projects/stock-tracker/.env`):
- Contains LIVE Alpaca API credentials (`ALPACA_KEY_ID=PK4AY...`, `ALPACA_SECRET_KEY=Eeh3qeg...`) in plaintext
- Contains LIVE Quiver API key (`QUIVER_API_KEY=sk_live_XS25...`) in plaintext
- Contains Discord webhook URL with full token
- `.gitignore` correctly excludes `.env` -- but this is the sole protection layer
- **No encryption at rest, no keychain integration, no vault**

**Whale Watcher `.env`** (file: `/Users/nassimlecornet/Projects/solana-whale-watcher/.env`):
- Contains LIVE Helius API key (`HELIUS_API_KEY=e9c71111-...`)
- Contains Helius webhook ID
- HMAC secret is literal `dev-webhook-secret` -- **the default development value is running in "production"**
- `API_AUTH_TOKEN=change-me-random-64-char-token` -- **the placeholder default is the actual token in use**
- `.gitignore` correctly excludes `.env` and `data/`

**Severity:** If the MacBook is compromised, lost, or stolen:
- Attacker gets Alpaca brokerage API keys (paper mode, but keys may work on live)
- Attacker gets Quiver paid API access
- Attacker gets Helius webhook control
- Attacker gets Discord webhook (can impersonate alerts)
- No mechanism for secret rotation without manual `.env` editing

### 1.2 Webhook Authentication

**Whale Watcher (Helius):**
- HMAC verification exists (`src/api/middleware/hmac.ts`) using `crypto.timingSafeEqual` -- **good**
- But `HELIUS_WEBHOOK_SECRET=dev-webhook-secret` is the actual secret in use -- **anyone who reads the source code or `.env.example` can forge webhooks**
- The config only enforces real secrets when `NODE_ENV=production`, but both launchd plists set `NODE_ENV=development`

**Stock Tracker:**
- **No webhook authentication at all** -- the API server has zero auth middleware
- All routes are open: `/api/dashboard`, `/api/trades`, `/api/portfolio`, etc.
- Anyone on the local network can read all trade data via `http://0.0.0.0:3001`

### 1.3 SQL Injection

- Both systems use `better-sqlite3` with **parameterized queries** (`.prepare()` with `?` or `@named` params) -- **good, no SQL injection vectors found**
- All user-facing data passes through prepared statements

### 1.4 CORS & Rate Limiting

**Stock Tracker (`src/api/server.ts`):**
- CORS: `Access-Control-Allow-Origin: *` via `onSend` hook -- **wide open, any origin can call the API**
- No rate limiting on any endpoint
- API bound to `0.0.0.0` -- accessible from any network interface

**Whale Watcher (`src/api/server.ts`):**
- CORS: `@fastify/cors` registered with `origin: false` -- correctly disables CORS (no cross-origin allowed)
- Auth middleware (`requireAuth`) protects most routes
- Webhook route protected by HMAC
- API bound to `127.0.0.1` -- **localhost only, good**
- No rate limiting

### 1.5 Cloudflare Tunnel Exposure

- Quick tunnel (`cloudflared tunnel --url http://localhost:3000`) exposes the whale watcher API to the internet
- The tunnel URL is public and discoverable
- Only the `/api/webhooks/helius` endpoint needs external access, but the tunnel exposes ALL routes
- Protected routes require `API_AUTH_TOKEN`, but that token is the default placeholder

### 1.6 Tunnel Script Security

The `start-tunnel.sh` script (file: `/Users/nassimlecornet/Projects/solana-whale-watcher/scripts/start-tunnel.sh`):
- Sources the `.env` file by parsing it line-by-line and exporting values
- Passes `HELIUS_API_KEY` directly in a curl URL parameter: `?api-key=${HELIUS_API_KEY}`
- This API key appears in `tunnel.log` and process lists
- The script has `set -euo pipefail` -- good

---

## 2. INFRASTRUCTURE RELIABILITY -- Grade: C-

### 2.1 launchd Configuration

Both plists (files: `/Users/nassimlecornet/Library/LaunchAgents/com.nassim.stock-tracker.plist`, `com.nassim.whale-watcher.plist`, `com.nassim.whale-tunnel.plist`):
- `RunAtLoad: true` -- starts on login, good
- `KeepAlive.SuccessfulExit: false` -- restarts on crashes only, not on clean exit; **correct behavior**
- `ThrottleInterval: 30` -- prevents crash loops from hammering CPU; good
- **No resource limits** (`SoftResourceLimits`/`HardResourceLimits`) -- a memory leak can consume all RAM
- **No `NetworkState` dependency** -- services start before network is available, causing initial failures
- `NODE_ENV=development` in both plists -- **the security checks in whale watcher config that enforce real secrets in "production" are completely bypassed**

### 2.2 Sleep/Reboot/Network Loss

- **Mac sleep:** launchd services are suspended; no heartbeat detection
- **Network loss:** Polling jobs will fail silently (caught by scheduler's try/catch, logged, retried next interval) -- acceptable degradation
- **Reboot:** `RunAtLoad` ensures restart -- but tunnel gets a new URL, which triggers Helius webhook update via `start-tunnel.sh` -- **self-healing mechanism exists and works**
- Stock tracker has **no tunnel dependency** -- purely outbound polling + local API

### 2.3 Database Backups

- **Zero backup strategy for either database**
- Stock tracker: 1.8MB main DB + 3.9MB WAL file, no scheduled copies
- Whale watcher: 4KB main DB + 1.3MB WAL file (very young)
- Both DBs live in the project's `data/` directory
- **A `rm -rf`, disk failure, or corruption event means total data loss**
- No Time Machine awareness documented

### 2.4 Log Rotation -- WILL FILL DISK

- launchd logs written to fixed paths with **no rotation mechanism**
- Current sizes are small (75KB, 34KB) because the systems are young
- At ~75KB/day for stock tracker, this reaches ~27MB/year -- manageable
- But pino in development mode (pino-pretty) is verbose; under load this grows faster
- **No logrotate, no newsyslog.d config, no periodic cleanup**
- The whale watcher `cleanup.ts` job is a stub: `logger.info("Cleanup job is not active in Phase 1")`

### 2.5 Tunnel URL Stability

- Cloudflare quick tunnels generate a **random URL on every restart**
- `start-tunnel.sh` correctly:
  1. Parses the URL from cloudflared stderr
  2. Updates `.env` with new `PUBLIC_WEBHOOK_URL`
  3. Calls Helius API to update the webhook URL
  4. Restarts the whale-watcher service via `launchctl kickstart -k`
- **Race condition:** There's a window between tunnel start and webhook update where Helius sends to the old URL -- events are lost
- No retry or verification that the Helius webhook update succeeded

---

## 3. DATA INTEGRITY -- Grade: B-

### 3.1 SQLite WAL Mode

Both databases use `journal_mode = WAL` -- good:
- Concurrent readers don't block writers
- Single-writer model of SQLite is respected (both are single-process)
- Whale watcher also enables `foreign_keys = ON` -- stock tracker does not explicitly enable foreign keys

### 3.2 Transaction Isolation

- Stock tracker `insertTrades` (in `db/queries.ts`) uses a transaction wrapper for batch inserts -- good
- Whale watcher convergence creation inserts the convergence row then link rows without an explicit transaction -- **partial write possible if crash occurs between INSERT and link rows**
- The `ConvergenceModel.create()` method does convergence INSERT + N convergence_trades INSERTs without wrapping in `db.transaction()`

### 3.3 Idempotency

**Stock Tracker:**
- Trades table has `UNIQUE(politician_id, COALESCE(ticker, ''), trade_date, direction, COALESCE(amount_range, ''))` -- prevents duplicate ingestion, good
- Fund holdings have `UNIQUE(fund_cik, report_date, cusip)` -- good

**Whale Watcher:**
- Trades table has `UNIQUE(tx_signature, wallet_address)` -- deduplication by blockchain signature, good
- `INSERT OR IGNORE` used in trade model -- silent skip on duplicates, good
- Convergence detection: `wasRecentlyAlerted()` prevents re-alerting within 30 minutes -- good
- **No idempotency on convergence creation itself** -- if the same token triggers convergence twice in quick succession (different trade events), two convergence rows are created

### 3.4 Database Schema Quality

**Stock Tracker:**
- Foreign keys declared in DDL but `PRAGMA foreign_keys` is NOT explicitly enabled -- **foreign keys are not enforced at runtime** (SQLite default is OFF)
- Good index coverage on trades, holdings, rankings
- CHECK constraints on enum-like columns (direction, severity, status)

**Whale Watcher:**
- `PRAGMA foreign_keys = ON` explicitly set -- good
- Good index coverage
- CHECK constraints on trade_type, wallet state, position status
- Migration-based schema (files in `src/storage/migrations/`) -- better than inline SQL

### 3.5 WAL File Growth

- Stock tracker WAL is 3.9MB vs 1.8MB main DB (2.2x ratio) -- **WAL is not being checkpointed**
- No `PRAGMA wal_checkpoint` calls found in either codebase
- WAL will grow indefinitely if the only reader/writer is the long-running process and no checkpoints are triggered
- SQLite auto-checkpoints at 1000 pages by default, but WAL-mode with a single long-running connection can delay this

---

## 4. ERROR HANDLING & RESILIENCE -- Grade: B

### 4.1 Scheduler Error Isolation

Stock tracker `scheduleEvery` wraps every job in try/catch (file: `src/utils/scheduler.ts`):
```typescript
async function runJob(name, job) {
  try { await job(); }
  catch (error) { logger.error({ job: name, err: ... }, "job failed"); }
}
```
**One failing source does NOT crash the process or block other jobs** -- good isolation.

### 4.2 Unhandled Promise Rejections

- Stock tracker: `main().catch(...)` catches top-level -- but no `process.on('unhandledRejection')` handler
- Whale watcher: Same pattern -- `main().catch(...)` without global rejection handler
- Node.js default since v15 is to crash on unhandled rejections -- **an uncaught async error in a callback or event handler will kill the process**
- launchd will restart it (KeepAlive), but state in progress is lost

### 4.3 Network Timeout Handling

**Stock Tracker:**
- SEC EDGAR: `AbortSignal.timeout(30_000)` on fetch + retry with exponential backoff -- good
- Quiver: retry wrapper (3 attempts, 2s base) -- good
- Yahoo Finance: relies on `yahoo-finance2` library defaults -- unverified

**Whale Watcher:**
- Jupiter: explicit timeout (`CONFIRM_TIMEOUT_MS = 60_000`) with retry loops -- good
- Helius: SDK-level handling -- acceptable
- Generic `retry()` utility with exponential backoff available

### 4.4 Rate Limit Handling

- SEC EDGAR: `RateLimiter(8)` = 8 req/s (SEC limit is 10/s) -- conservative, good
- Discord: Both systems handle 429 with retry-after header parsing -- good
- Quiver: No explicit rate limiter -- relies on polling interval (15 min) being low enough
- Helius: Webhook-push model, no client-side rate concern
- Jupiter: No explicit rate limiter, but quote staleness check (3s) provides natural throttling

### 4.5 Trade Safety

**Stock Tracker:**
- `EXECUTION_ENABLED` defaults to `false` -- must be explicitly enabled, good
- `EXECUTION_MODE` defaults to `paper` -- double safety
- `ALPACA_PAPER=true` in .env -- triple safety for paper trading
- `MAX_DAILY_TRADES=3` hard cap
- Signal filter has extensive gates: ETF blocklist, minimum amounts, rank thresholds, wash sale tracking, market cap floors

**Whale Watcher:**
- `EXECUTION_ENABLED` defaults to `false`, `EXECUTION_MODE` defaults to `paper` -- good
- RiskEngine with phase-based limits (cold_start/validated/mature), hard caps on position sizes, liquidity checks, circuit breakers
- Price impact limit (3%) on Jupiter swaps
- Paper mode simulates with real quotes but no on-chain execution
- **No kill switch** -- if execution is enabled, there's no way to emergency-halt without editing .env and restarting

---

## 5. MONITORING & OBSERVABILITY -- Grade: C

### 5.1 Silent Failure Detection

**Stock Tracker:**
- `source_health` table with periodic health checks (every 15 min) -- good
- `/health` endpoint returns uptime but no source status
- Discord alerts for new trades, rankings, executions
- **No alert for "source X hasn't returned data in Y hours"** -- staleness goes undetected

**Whale Watcher:**
- `/api/health` returns only `{ ok: true }` -- no dependency checks
- Discord alerts for convergences and executions
- **No staleness detection** -- if Helius stops sending webhooks, silence is indistinguishable from "no whale activity"

### 5.2 Error Classification

- Whale watcher logger has pino redaction paths for secrets -- good
- Stock tracker uses pino with structured logging -- good
- Neither system classifies errors by severity for alerting (only trade alerts reach Discord, not infrastructure errors)

### 5.3 Dashboard

- Stock tracker has a React frontend (`frontend/`) with SSE live updates -- good for visual monitoring
- Whale watcher has a Preact frontend with SSE -- good
- Neither has uptime/error-rate metrics

---

## 6. DEPLOYMENT & OPERATIONS -- Grade: C-

### 6.1 Build Process

- Both use TypeScript compiled to `dist/`
- Stock tracker: `tsc` compilation
- Whale watcher: `tsup` bundler + `vite build` for frontend
- launchd runs from `dist/` -- **a failed build means launchd restarts the old binary silently**
- No build verification step in the deployment process

### 6.2 Configuration Management

- All config via `.env` files with Zod validation -- good schema enforcement
- But Zod defaults mask missing keys: most fields have `.default("")` -- the app starts with empty API keys and silently produces no data
- Whale watcher config validates critical secrets only when `NODE_ENV=production` -- which is never true under launchd

### 6.3 Secret Rotation

- No automated rotation
- Rotating any key requires: edit `.env` -> restart service via `launchctl kickstart`
- No documentation of which keys need rotation or their expiry
- Alpaca keys, Quiver keys, Helius keys all have indefinite lifetime but no rotation plan

### 6.4 Machine Migration

- Both systems are **self-contained** within their project directories
- Migration requires: copy project dir + copy launchd plists + copy `.env` + install Node.js + `npm ci && npm run build`
- Database is a single SQLite file (plus WAL) -- portable
- No external infrastructure dependencies beyond API keys
- **Migration difficulty: Low** -- this is a strength

---

## SCORECARD

| Area | Grade | Critical Issues |
|------|-------|-----------------|
| 1. Security | **D** | Plaintext API keys, default HMAC secret in prod, no auth on stock tracker API, wide-open CORS, NODE_ENV=development bypasses all security checks |
| 2. Infrastructure Reliability | **C-** | No log rotation, no DB backups, no network-state dependency in launchd, tunnel URL race condition |
| 3. Data Integrity | **B-** | Good dedup/idempotency, but missing foreign key enforcement (stock tracker), missing transaction wrapper (whale convergence), WAL not checkpointing |
| 4. Error Handling & Resilience | **B** | Good job isolation, proper retry/backoff, but no unhandledRejection handler, no kill switch |
| 5. Monitoring & Observability | **C** | Health endpoints exist but shallow, no staleness alerts, no infrastructure error alerting |
| 6. Deployment & Operations | **C-** | Portable setup, but no backup strategy, no secret rotation, NODE_ENV misconfiguration |

## OVERALL VERDICT: NOT PRODUCTION-READY

**For paper trading / development:** Acceptable. The systems are well-architected with good separation of concerns, proper error isolation, and solid trade safety gates. The codebase quality is above average for a personal project.

**For real money:** Absolutely not. The security posture (plaintext keys, default secrets, no auth on stock tracker) and the complete absence of backup/recovery make this unsuitable for any scenario where financial loss or data loss matters.

## TOP 5 ACTIONS (priority order)

1. **Set `NODE_ENV=production` in both launchd plists** and generate real secrets for `HELIUS_WEBHOOK_SECRET` and `API_AUTH_TOKEN`. This single change activates all the security validation that already exists in the whale watcher config.

2. **Add authentication middleware to the stock tracker API**. Port the whale watcher's `requireAuth` pattern. Remove `Access-Control-Allow-Origin: *`.

3. **Implement database backups**: a daily cron copying the `.db` file (after `PRAGMA wal_checkpoint(TRUNCATE)`) to a second location. Even `cp` to an external drive or cloud sync folder.

4. **Add log rotation**: either `newsyslog.d` entries for the launchd log paths, or switch to pino file transport with rotation.

5. **Add `process.on('unhandledRejection')` handlers** to both entry points, logging the error and optionally sending a Discord alert before the process exits.
