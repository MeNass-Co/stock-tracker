# Full Code Audit Report — Two Automated Trading Systems

**Auditor:** Principal Software Engineer (Claude Opus 4.6)
**Date:** 2026-04-25
**Systems:** Solana Whale Watcher v1.0.0, US Stock Tracker v1.0.0

---

## SYSTEM 1: Solana Whale Watcher

### CRITICAL Findings (Could Lose Real Money or Corrupt Data)

**C1. `computeMvpScore()` returns hardcoded 50 — scoring is non-functional**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/scorer.ts`
- The convergence score stored in every convergence row is always `50`. The `computeMvpScore()` function at the bottom of scorer.ts is a stub. This means tier escalation logic that relies on score is inert — every convergence is `NOTABLE` with score `50`, regardless of whale quality, amount, or velocity. Any downstream logic gating on score thresholds is meaningless.
- **Impact:** The system cannot distinguish high-conviction convergences from noise. Every 2-wallet buy in the window triggers the same response.

**C2. Convergence tier is always hardcoded to `"NOTABLE"` — no `CRITICAL` tier ever fires**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/convergence.ts`, line: `const tier = "NOTABLE";`
- The tier is never computed dynamically. The `CRITICAL` tier exists in the schema and risk engine phase limits, but no code path ever assigns it. The risk engine allocates different sizes for CRITICAL vs NOTABLE (e.g., 2.0% vs 1.5% in validated phase), but CRITICAL positions will never be opened.
- **Impact:** The risk engine's tier-based sizing is partially dead code. The system under-sizes positions when it should be going heavier on high-conviction signals.

**C3. Convergence fires on trade execution and then detaches — fire-and-forget pattern**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/convergence.ts`
- `tradeExecutor.onConvergence(convergence, recentBuys).catch(...)` — the convergence is created in the DB, then trade execution is launched as a detached promise. If `onConvergence` throws, the convergence is already persisted as `PENDING` but no position will ever be opened. There is no retry mechanism. The convergence row will sit as `PENDING` indefinitely.
- **Impact:** Missed trades with no visibility. The system thinks it acted but never did.

**C4. Trade deduplication uses `(tx_signature, wallet_address)` but does NOT include `token_mint`**
- File: SQL migration, `UNIQUE(tx_signature, wallet_address)`
- A single Solana transaction can contain multiple token transfers (e.g., a multi-hop swap: SOL->USDC->Token). The transaction parser can emit multiple `ITradeEvent`s from one tx_signature for the same wallet but different tokens. Only the first will be inserted; subsequent ones will be silently dropped by `INSERT OR IGNORE`.
- **Impact:** Legitimate trades in multi-hop swaps are silently dropped, leading to undercounting whale activity and potentially missing convergences.

**C5. HMAC verification fallback to `JSON.stringify(request.body)` breaks signature integrity**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/api/middleware/hmac.ts`
- `const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});`
- If `rawBody` is not available (Fastify does not provide it by default — you need `addContentTypeParser` with raw body enabled), the code falls back to `JSON.stringify(request.body)`. JSON.stringify output is not guaranteed to match the original byte stream Helius sent, so the HMAC will either always fail (good, secure) or always succeed against the wrong digest (bad, insecure depending on the secret). More critically, in development mode with `HELIUS_WEBHOOK_SECRET = "dev-webhook-secret"`, HMAC verification still runs but against potentially wrong data.
- **Impact:** In production, if rawBody is not explicitly configured in Fastify, ALL webhooks could be rejected, or worse, the HMAC check becomes a rubber stamp.

**C6. Position manager `onWhaleSell` logic inverts behavioral sell thresholds**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/position-manager.ts`
- When `count >= 2` (two whales selling), it sells only 50% and sets a pending behavioral exit. When `count < 2` (one whale selling), it sells 100%. This is backwards — a single whale selling triggers a full exit, while two whales selling triggers only a partial exit.
- **Impact:** A single whale sell causes a full panic exit when it should be the weaker signal, while the stronger signal (multiple whales selling) triggers only a partial exit.

**C7. `estimateSellPct` can return >100% and does not account for sells**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/api/routes/webhooks.ts`
- `estimateSellPct` divides current sell amount by total buys, but doesn't subtract previous sells. If a whale has bought 100 tokens, sold 50, then sells 60 more, the function returns `60/100 = 60%` when the actual remaining position was only 50 tokens — the real sell is 100%. Conversely, the raw calculation could produce >100% if tokenAmount exceeds totalBought.
- **Impact:** Incorrect behavioral sell signals that either under-react or over-react to whale exits.

**C8. No slippage protection on exit swaps during rug emergencies**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/position-manager.ts`
- When `isRugEmergency` is true, the system calls `exit(position, "RUG_EMERGENCY", 100, true)` with `panicExit=true`. The trade executor then uses whatever slippage the jupiter client calculates from liquidity. During a rug pull, liquidity is being drained rapidly — the slippage calculation based on current pool TVL (which may have already crashed) could result in getting rekt on the exit swap itself.
- **Impact:** During the exact scenario the rug detector is designed to handle, the exit swap may suffer catastrophic slippage, compounding losses.

---

### HIGH Findings (Significant Bug or Design Flaw)

**H1. Wallet scorer runs once at startup + daily at 9:43 — but uses `setInterval` with minute-precision polling, not cron**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/index.ts`
- The scheduler checks `now.getHours() === 9 && now.getMinutes() === 43` every 60 seconds. This works, but the job fires every second of minute 43 (since the interval might hit 9:43 multiple times). There is no guard preventing the scorer from running concurrently with itself across multiple interval ticks.
- **Impact:** The scorer could run multiple times at 9:43, hammering the Helius API with duplicate requests.

**H2. `passesMvpFilters` is essentially a no-op — only checks blacklist**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/filters.ts`
- The function checks `isBlacklisted` and `buys.length > 0`. Since `buys` comes from `findByTokenInWindow` which already returned rows, `buys.length > 0` is always true at this point. The `config.convergence.minTradeUsd`, `minLiquidityUsd`, and `minTokenAgeHours` values are defined in config but never used in any filter.
- **Impact:** The system will fire convergences on tokens with $0 liquidity, 1-minute-old tokens, or $1 trades — essentially no quality filtering.

**H3. `Math.min(...recentBuys.map(...))` and `Math.max(...)` will throw `RangeError` on very large arrays**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/convergence.ts`
- `Math.min(...array)` and `Math.max(...array)` spread into the call stack. With thousands of trades in a window (possible for popular tokens), this will throw a `RangeError: Maximum call stack size exceeded`.
- **Impact:** Convergence detection crashes for popular tokens, silently swallowing the error.

**H4. Jupiter quote freshness check uses wall-clock difference but no staleness guard in paper mode**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/jupiter-client.ts`
- `QUOTE_MAX_AGE_MS = 3_000` is defined but the `freshQuote` method is only used in live mode. In paper mode, `executePaperSwap` gets a quote without freshness validation. If Jupiter API is slow, paper trades execute on stale prices.
- **Impact:** Paper P&L tracking can be inaccurate, giving false confidence before going live.

**H5. Risk engine reads from `execution_config` for token metadata (volatility, liquidity, age) but nothing populates these keys**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/risk-engine.ts`
- Keys like `token:{mint}:realized_vol_24h_pct`, `token:{mint}:top10_holders_pct`, `token:{mint}:age_hours`, `token:{mint}:first_whale_price_usd`, `token:{mint}:liquidity_drop_pct`, `token:{mint}:narrative` are read via `numberConfig()` / `stringConfig()` from the `execution_config` table. The `price-tracker.ts` job is a stub ("not active in Phase 1"). No other code populates these keys.
- **Impact:** Every risk check that depends on these values gets `null`, and the `null` check causes the guard to be skipped. This means: top-10 holder concentration is never checked; token age is never checked; first-whale-price adverse move is never checked; narrative limits are never enforced; liquidity drops are never detected. The risk engine has impressive-looking guards that are all disabled.

**H6. Wallet scorer can demote a wallet that has open positions, but convergence signals already fired**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/jobs/wallet-scorer.ts`
- When a wallet gets demoted to `DORMANT` or `DEMOTED`, it is deactivated from monitoring but existing positions opened based on its convergence signals remain open. The position manager has no concept of "the whale that triggered this trade has been demoted." Worse, if the wallet is removed from Helius monitoring, sell signals from that wallet won't be detected, so `onWhaleSell` behavioral exits won't fire.
- **Impact:** The system loses visibility on whale exits for demoted wallets while still holding positions those wallets triggered.

**H7. `getThreshold` in thresholds.ts is defined but never called**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/config/thresholds.ts`
- The dynamic threshold function `Math.max(2, Math.floor(Math.log2(totalWallets) + 1))` is never used. The convergence engine uses `config.convergence.mvpThreshold` (hardcoded to 2). This means the threshold doesn't scale with the number of monitored wallets — monitoring 100 wallets still triggers on just 2 buying.
- **Impact:** As the wallet list grows, false positive rate increases linearly because the threshold stays fixed.

**H8. No graceful shutdown — positions could be left in inconsistent state**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/index.ts`
- The process has no SIGTERM/SIGINT handler. If the process is killed mid-execution (e.g., during a swap), the execution record could be stuck in `PENDING` status, the position could be recorded as `OPEN` with no corresponding on-chain position, or the paper balance could be out of sync.
- **Impact:** Data corruption after process restarts.

---

### MEDIUM Findings (Code Smell or Minor Logic Issue)

**M1. All dependencies use `"latest"` in package.json**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/package.json`
- 13 out of 20 dependencies use `"latest"` instead of pinned versions. A breaking change in `helius-sdk`, `@solana/web3.js`, or `better-sqlite3` will silently break the system on next install.
- **Impact:** Non-reproducible builds. A `npm install` could break production.

**M2. `buildPositions` in scorer.ts doesn't handle the same token being traded on multiple DEXes**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/engine/scorer.ts`
- The function processes both DB trades and Helius transactions. The Helius transaction loop processes SWAP transactions separately from DB trades, potentially double-counting the same trade that exists in both sources.
- **Impact:** Inflated or deflated wallet scores.

**M3. Position PnL calculation on partial exits is deferred to close**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/position-manager.ts`, `markExit` method
- `pnlUsd` and `pnlPct` are only computed when `remainingAmount === 0` (full close). Partial exits (e.g., take-profit at 25%) record `null` PnL. This means the portfolio value calculation in the risk engine doesn't account for realized gains/losses from partial exits.
- **Impact:** Risk engine's portfolio exposure calculation is slightly off during partial exit scenarios.

**M4. `type` casting throughout (`as TradeRow`, `as { count: number }`, etc.)**
- Multiple files across the codebase use `as` type assertions on SQLite query results rather than runtime validation.
- **Impact:** If the schema changes or a migration is missed, these will silently return incorrect types at runtime.

**M5. Position manager `checking` mutex is not concurrency-safe**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/position-manager.ts`
- `this.checking` is a boolean flag used to prevent concurrent `checkOpenPositions` calls. Since Node.js is single-threaded, this works for the `setInterval` case, but if `checkOpenPositions` is called from both the interval and an external trigger (e.g., a webhook handler), the flag provides adequate protection. However, there's no timeout on the check — if a Jupiter price call hangs, `checking` stays `true` forever, freezing position monitoring.
- **Impact:** A single hung price request permanently disables position monitoring until process restart.

**M6. Stop loss is set at a fixed -25% regardless of token volatility**
- File: `/Users/nassimlecornet/Projects/solana-whale-watcher/src/execution/position-manager.ts`
- `const stopLossPrice = input.entryPriceUsd * 0.75;` — a static 25% stop loss for all tokens. Solana meme coins can move 25% in minutes during normal trading. The ATR-based stop is read from `execution_config` but never populated (see H5).
- **Impact:** The stop loss is either too tight (triggers on normal volatility) or too loose (for more stable tokens), with no adaptive behavior.

---

### LOW Findings (Style/Consistency)

**L1.** `alerts/discord.ts` and `alerts/formatter.ts` — no rate limiting on Discord webhook sends beyond per-convergence dedup.

**L2.** `storage/cache.ts` exists in the file tree but was not found to be imported in the main flow.

**L3.** The `WATCH` tier is defined in the schema but the convergence engine never produces it.

**L4.** `jobs/price-tracker.ts` is a stub with only a log line.

**L5.** `frontend/hooks/useSSE.ts` exists but the frontend is only built during `tsup && vite build` — no hot-reload integration for development.

---

## SYSTEM 2: US Stock Tracker

### CRITICAL Findings

**C1. Quiver `sourceId` fallback uses array index — not collision-free**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/ingestion/quiver.ts`
- `sourceId: String(row.ID ?? row.ReportID ?? \`${row.Ticker ?? "unknown"}-${index}\`)`
- If Quiver's response lacks `ID` and `ReportID` fields (which happens when their API changes — they've changed field names before as evidenced by the multiple fallback fields), the sourceId becomes `AAPL-0`, `AAPL-1`, etc. On the next poll, a completely different trade could get the same sourceId.
- **But note:** The `sourceId` is not actually used for deduplication in the DB. The `idx_trades_dedup` unique index uses `(politician_id, ticker, trade_date, direction, amount_range)`. So `sourceId` is stored but not relied upon for dedup.
- **Real risk:** The dedup index itself has a problem: two trades by the same politician, same ticker, same date, same direction, same amount range are considered duplicates. If a senator genuinely buys AAPL twice in one day for the same amount, the second trade is silently dropped.
- **Impact:** Legitimate duplicate trades are lost. Low probability but non-zero.

**C2. Trade dedup index uses `COALESCE(ticker, '')` — null tickers are all treated as the same ticker**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/db/schema.ts`
- `UNIQUE(politician_id, COALESCE(ticker, ''), trade_date, direction, COALESCE(amount_range, ''))`
- If a politician makes two different trades on the same day with null tickers (possible for non-stock assets like options or funds that don't have tickers), they collide. Since the `asset_name` is not part of the unique index, different assets with null tickers are treated as duplicates.
- **Impact:** Silent data loss for non-stock trades.

**C3. 13F data has a 45-day filing delay — the stock could have moved significantly**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/signal-filter.ts`
- The `evaluate13FDiff` function checks if the ticker is tradable on Alpaca but does NOT check how old the filing data is relative to the report date. A 13F-HR for Q4 2025 could be filed on Feb 14, 2026 (45 days after quarter end). The fund may have already sold by the time we act.
- The `isRebalanceWindow` in the rebalancer checks if filing is 3-5 days old, but this measures days since the *filing date*, not since the *report date*. The report date could be months old.
- **Impact:** Copy-trading 45+ day old positions. The fund may have already exited by the time we buy.

**C4. No order status verification loop after Alpaca submission**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/order-manager.ts`
- After `submitOrder`, the order status is mapped and stored, but the system relies on the next `monitorOrders()` call (every 5 minutes via position-monitor) to check if the order was filled. Between submission and the next monitor cycle, if the order is rejected by Alpaca's risk checks (e.g., PDT rule, insufficient buying power), the execution sits in `submitted` status for up to 5 minutes.
- **Impact:** The risk engine could approve a second trade during those 5 minutes, thinking the first trade's capital is still available. This could lead to over-exposure.

**C5. Stop loss order uses `stop_limit` type — can gap through the limit**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/order-manager.ts`, `submitStopLoss`
- `type: "stop_limit"` with `limit_price: (stopLossPrice * 0.98).toFixed(2)` — a 2% buffer below the stop price. If a stock gaps down more than 2% overnight (common during earnings), the stop-limit order will not fill because the market opens below the limit price. The position has no protection until someone manually intervenes.
- **Impact:** Stop losses fail to execute during the exact scenarios they're meant for — gap-downs.

**C6. `sellHalf` uses `position.quantity / 2` without rounding for fractional shares**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/position-monitor.ts`
- If the position has 1 share, `1 / 2 = 0.5`. Alpaca supports fractional shares for some assets but not all. If the asset doesn't support fractional shares, the order will be rejected.
- **Additionally:** The DB update `quantity = quantity - ?` with a floating-point half could introduce IEEE 754 rounding errors over time (e.g., 3 shares -> 1.5 -> 0.7500000000000001).
- **Impact:** Failed sell orders or positions with impossible quantities.

**C7. Flash crash protection widens the stop loss but doesn't cancel/replace the Alpaca stop order**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/position-monitor.ts`, `handleFlashCrash`
- `updateStockPositionStops(this.db, position.id, { stopLossPrice: widenedStop })` — this only updates the local DB. The stop-loss order on Alpaca's side still has the old, tighter stop price. The Alpaca stop could fill at the old price while the local DB thinks the stop was widened.
- **Impact:** The flash crash "protection" is illusory. Alpaca fills the old stop while the DB thinks it's been widened.

**C8. `AlpacaClient` base URL logic has a logic error for live mode**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/alpaca-client.ts`
- `config.EXECUTION_MODE === "live" && !config.ALPACA_PAPER ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets"`
- This requires BOTH `EXECUTION_MODE === "live"` AND `ALPACA_PAPER === false` to use the live endpoint. But `ALPACA_PAPER` defaults to `true` (in config.ts). If someone sets `EXECUTION_MODE=live` but forgets to set `ALPACA_PAPER=false`, they'll be trading on paper while thinking they're live. This is actually a safety feature, but the mental model is confusing and the two config values can contradict each other.
- **Impact:** Confusing config that could lead to someone thinking they're live when they're not, or vice versa.

---

### HIGH Findings

**H1. Cluster detection runs on EVERY trade ingestion — N^2 alert spam**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/alerting/alert-engine.ts`, `processTrades`
- Every time trades are ingested, `detectClusters(this.db)` runs and fires alerts for ALL existing clusters, not just new ones. If AAPL has 5 politicians buying in the last 30 days, every ingestion cycle fires a cluster alert for AAPL, regardless of whether the cluster changed.
- **Impact:** Discord alert spam. Every 15 minutes (Quiver poll interval), every existing cluster generates a duplicate alert.

**H2. `metrics.ts` round-trip matching is first-match, not FIFO/LIFO — mispricing alpha**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/ranking/metrics.ts`
- The sell matching logic finds the first sell that's after the buy date: `sells.find(s => new Date(s.trade_date) >= buyTime)`. This is neither FIFO nor LIFO — it just matches each buy to the first available sell chronologically. If a politician has overlapping positions (buy 100 shares, buy 100 more, sell 100), the second buy could match to the same sell as the first buy.
- Worse: `usedSells` prevents double-matching sells, but a buy with no matching sell gets a FALLBACK_HOLD_DAYS = 30 assumption. This fabricated sell date means alpha is calculated against a price that may not represent reality.
- **Impact:** Politician alpha scores and rankings are noisy. The ranking that drives trade decisions is built on approximate matching.

**H3. Yahoo Finance URL is v8/chart which is an undocumented/unofficial endpoint**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/prices/yahoo-finance.ts`
- `https://query1.finance.yahoo.com/v8/finance/chart/` — this is the unofficial Yahoo Finance API. Yahoo has been known to rate-limit, block, or change this endpoint without notice. The `yahoo-finance2` package is in dependencies but this provider doesn't use it — it does raw HTTP.
- **Impact:** Price data could silently disappear, breaking ranking calculations.

**H4. `compositeRank` z-score normalization with 1 or 2 politicians**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/ranking/composite-score.ts`
- `zscores` divides by std, and handles `std === 0` by returning all zeros. But with 1 politician, std is always 0, so all z-scores are 0 and the ranking is meaningless. With 2 politicians, the z-scores are always +1 and -1, making the weights irrelevant.
- **Impact:** Rankings are unreliable until there are at least ~10 qualifying politicians.

**H5. No wash sale check on 13F-triggered buys**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/signal-filter.ts`
- The `evaluateTrade` (senator) path checks `activeWashSale(this.db, ticker)` but `evaluate13FDiff` does not. If a 13F position was closed at a loss and the system re-buys within 30 days based on a new 13F, it creates a wash sale with tax implications.
- **Impact:** Tax liability. Wash sales disallow the loss deduction.

**H6. Position monitor calls `checkAll` sequentially — one slow Alpaca call blocks everything**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/position-monitor.ts`
- `for (const position of positions) { await this.checkPosition(position); }` — each position check involves an Alpaca API call (`getPosition`). With 10+ positions, this could take 30+ seconds, during which no other positions are monitored for stop losses filling.
- **Impact:** Delayed stop loss detection. A fast-moving stock could gap further during the serial check.

**H7. `rebalancer.ts` `mapHolding` function uses `any` and the function is incomplete**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/rebalancer.ts`
- `function mapHolding(row: any): FundHoldingInput` — the function body was truncated in the file but uses untyped `any` for database rows.
- **Impact:** Any schema change silently breaks the mapping.

**H8. No market hours check for 13F rebalance sells**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/execution/rebalancer.ts`
- `rebalanceSell` calls `orderManager.submitMarketExit` without checking if the market is open. Market orders submitted outside trading hours will either fail or queue for next open at a potentially different price.
- **Impact:** Unexpected fill prices on 13F sell orders.

---

### MEDIUM Findings

**M1. Senate EFD source `sourceId` can collide**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/ingestion/senate-efd.ts`
- `sourceId: \`efd-${report.name.replace(/\\s/g, "-")}-${normalizedTicker ?? "none"}-${txDate}\``
- If a senator makes two trades on the same date for the same ticker (e.g., buy and sell), the direction is not part of the sourceId, causing collision. However, this source is currently disabled.
- **Impact:** Low (source disabled), but if re-enabled, data loss.

**M2. `midpointForRange` returns `null` for unrecognized ranges**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/parsing/normalizer.ts`
- The `AMOUNT_MIDPOINTS` lookup table requires exact string matches. If Quiver sends `"$1,001 - $15,000 "` (trailing space) or `"$1001 - $15000"` (no commas), the midpoint returns `null`. The normalizer does `.replace(/\s+/g, " ").trim()` but does not normalize comma formatting.
- **Impact:** Trades with unrecognized amount ranges get `amountMidpoint: null`, which causes them to be filtered out by the signal filter's `amount < 50_000` check (since `null ?? 0 < 50_000`).

**M3. `directionFromTransaction` maps "exchange" as a third type but the signal filter only handles "buy" and "sell"**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/parsing/normalizer.ts`
- Exchange-type transactions (e.g., stock splits, conversions) are classified as "exchange" but the signal filter and execution layer only process "buy" and "sell". Exchange transactions are silently ignored.
- **Impact:** Options exercises classified as "exchange" are missed even if they represent significant directional bets.

**M4. `annualizedAlpha` calculation can explode for short hold periods**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/ranking/metrics.ts`
- `const annualizedAlpha = rawAlpha * (365 / avgHold)` — if avgHold is 1 day and rawAlpha is 2%, annualized alpha is 730%. This massively over-weights short-term trades.
- **Impact:** Day-trading politicians get inflated scores.

**M5. `13f-parser.ts` does not handle the `putCall` field**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/parsing/13f-parser.ts`
- 13F filings include `putCall` to indicate if the holding is puts, calls, or shares. The parser ignores this field, treating options positions the same as equity positions.
- **Impact:** A fund holding puts (bearish bet) is interpreted the same as holding shares (bullish bet). The system could buy a stock because a fund has puts on it.

**M6. `previousQuarterHoldings` uses `max(report_date)` with string comparison**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/tracking/portfolio-diff.ts`
- `SELECT max(report_date) ... WHERE report_date < ?` — this works correctly for ISO date strings (YYYY-MM-DD) because they sort lexicographically. But if any non-standard date format is inserted, the comparison breaks silently.
- **Impact:** Incorrect diff calculations if date formats are inconsistent.

**M7. `calculateHhi` doesn't filter zero-value holdings**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/tracking/portfolio-diff.ts`
- Holdings with `valueThousands: 0` (exited positions) contribute `0^2 = 0` to HHI, which is mathematically correct, but the total includes their zero values, potentially diluting the concentration metric.
- **Impact:** Minor — HHI is slightly underestimated.

**M8. `DiscordAlerter.send` throws on non-429 HTTP errors — could crash the ingestion loop**
- File: `/Users/nassimlecornet/Projects/stock-tracker/src/alerting/discord.ts`
- `throw new Error(\`Discord webhook failed: ${response.status}\`)` — if Discord returns a 500, this throws, and the error propagates up to `persistAndSend`, which is called from `processTrades`. If `processTrades` doesn't catch this, the entire ingestion cycle fails.
- The caller (`alertEngine.processTrades`) does NOT have try/catch around Discord sends.
- **Impact:** A temporary Discord outage could block trade ingestion and execution.

---

### LOW Findings

**L1.** `capitol-trades.ts` and `unusual-whales.ts` are empty stubs returning `[]`.

**L2.** `buffett-tracker.ts` only exports a constant — no active tracking logic.

**L3.** `form4-parser.ts` and `ptr-parser.ts` exist in the file tree but were not imported in the main flow.

**L4.** The `senate-efd.ts` source is disabled due to Akamai bot protection — code is dead.

**L5.** `singleton` pattern in `db/queries.ts` (`let singleton: Database | null = null`) prevents multiple DB connections but makes testing difficult.

**L6.** No TypeScript strict mode verification — `any` types in `quiver.ts` response parsing, `rebalancer.ts` `mapHolding`, and all database query results.

**L7.** `SEC_USER_AGENT` in config defaults to the developer's actual email address.

---

## Cross-System Findings

**X1. Both systems use SQLite with WAL mode but neither implements connection pooling or handles SQLITE_BUSY errors.**
- SQLite WAL allows concurrent reads but only one writer. If the webhook handler and the scorer job both try to write simultaneously, one will get SQLITE_BUSY. `better-sqlite3` throws synchronously on this. Neither system catches this error.

**X2. Both systems have no automated tests for the execution layer.**
- The test commands (`vitest run`) exist but there are no test files in the source trees for the critical execution, risk, or position management code.

**X3. Neither system has a kill switch that can be triggered remotely.**
- The only way to stop trading is to kill the process or set `EXECUTION_ENABLED=false` in the env file and restart.

---

## Quality Grades

### Solana Whale Watcher: C-

**Strengths:**
- Well-structured codebase with clear separation of concerns (engine, execution, blockchain, storage)
- Thoughtful risk engine design with phased limits, circuit breakers, portfolio heat
- Good trade deduplication via `INSERT OR IGNORE` on tx_signature
- Proper HMAC verification (with the rawBody caveat)
- Zod schema validation for environment variables

**Weaknesses:**
- Critical scoring and tier systems are stubs/hardcoded (C1, C2)
- Risk engine guards are elaborate but data-starved — most checks return null and get skipped (H5)
- Filter system is a no-op (H2)
- Fire-and-forget execution pattern (C3)
- Behavioral sell logic is inverted (C6)
- No graceful shutdown (H8)

**Verdict:** The architecture is solid, but the system is running in an MVP state where critical subsystems (scoring, filtering, risk metadata) are stubs. If you went live with this, the risk engine's impressive guard rails would be mostly inactive. The system would blindly copy any 2+ whale convergence above the blacklist check.

---

### US Stock Tracker: B-

**Strengths:**
- Comprehensive signal filter with multiple gates (rank, amount, filing delay, wash sales, ETF blocklist)
- Proper position lifecycle management (time stops at 30/60/90 days, trailing stops, take profits)
- Well-designed composite ranking with z-score normalization
- Flash crash detection
- Wash sale tracking for tax compliance
- Circuit breakers at daily (3%), weekly (7%), and high-water-mark (15%) levels
- Good multi-source ingestion architecture

**Weaknesses:**
- 13F filing delay problem means copying potentially stale positions (C3)
- Stop-limit orders can gap through (C5)
- Flash crash protection doesn't update Alpaca orders (C7)
- Cluster alert spam (H1)
- Approximate round-trip matching in metrics (H2)
- No wash sale check on 13F sleeve (H5)
- 13F parser ignores put/call (M5 — could buy a stock a fund is bearish on)
- Discord errors can crash ingestion (M8)

**Verdict:** A significantly more mature system with thoughtful execution controls. The senator sleeve is production-quality with proper risk gates. The 13F sleeve has fundamental design challenges (45-day lag, put/call blindness) that no amount of code quality can fix — these are inherent to the data source. The main code issues are around order management edge cases and alert deduplication.

---

*End of audit report.*
