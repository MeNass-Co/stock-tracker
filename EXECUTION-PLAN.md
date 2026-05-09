# Execution Layer — Stock Tracker (Senator + Buffett)

## Overview

Add auto-trading to the existing senator/13F detection system. Two-sleeve architecture: Sleeve A (senator trades, 60%), Sleeve B (13F replication, 30%), Cash reserve (10%). Execute via Alpaca API (paper trading first).

## Architecture

```
ingestion (existing) detects trade/13F
        ↓
execution/signal-filter.ts (NEW) — validates signal, checks all copy_if gates
        ↓
execution/position-sizer.ts (NEW) — calculates position size with multipliers + caps
        ↓
execution/alpaca-client.ts (NEW) — Alpaca REST API wrapper (orders, positions, account)
        ↓
execution/order-manager.ts (NEW) — bracket orders, fills monitoring, resubmission
        ↓
execution/position-monitor.ts (NEW) — stop/trailing/time-stop/exit logic
        ↓
execution/risk-engine.ts (NEW) — drawdown limits, circuit breakers, exposure checks
        ↓
execution/rebalancer.ts (NEW) — quarterly 13F rebalance logic
        ↓
db: stock_executions + stock_positions tables
```

## Files to Create

### 1. `src/db/execution-schema.ts`

Add to schema.ts or as separate migration. New tables:

```sql
CREATE TABLE IF NOT EXISTS stock_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('senator_trade', '13f_diff', 'stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'senator_exit', 'fund_exit', 'manual')),
  trigger_id INTEGER,
  sleeve TEXT NOT NULL CHECK(sleeve IN ('senator', '13f')),
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('buy', 'sell')),
  quantity REAL NOT NULL,
  limit_price REAL,
  filled_price REAL,
  filled_quantity REAL,
  amount_usd REAL,
  alpaca_order_id TEXT,
  alpaca_client_order_id TEXT,
  status TEXT CHECK(status IN ('pending', 'submitted', 'partial', 'filled', 'failed', 'cancelled', 'expired')) DEFAULT 'pending',
  senator_name TEXT,
  senator_rank INTEGER,
  fund_name TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  submitted_at TEXT,
  filled_at TEXT
);

CREATE TABLE IF NOT EXISTS stock_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker TEXT NOT NULL,
  sleeve TEXT NOT NULL CHECK(sleeve IN ('senator', '13f')),
  entry_execution_id INTEGER REFERENCES stock_executions(id),
  trigger_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  current_price REAL,
  stop_loss_price REAL,
  stop_loss_order_id TEXT,
  trailing_stop_active INTEGER DEFAULT 0,
  trailing_stop_pct REAL,
  trailing_stop_order_id TEXT,
  take_profit_price REAL,
  time_stop_at TEXT,
  day30_checked INTEGER DEFAULT 0,
  day60_exited_half INTEGER DEFAULT 0,
  senator_name TEXT,
  senator_rank INTEGER,
  fund_name TEXT,
  status TEXT CHECK(status IN ('open', 'partial', 'closed')) DEFAULT 'open',
  pnl_usd REAL,
  pnl_pct REAL,
  opened_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  exit_reason TEXT
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  total_value REAL NOT NULL,
  senator_sleeve_value REAL,
  thirteenf_sleeve_value REAL,
  cash_value REAL,
  daily_pnl REAL,
  daily_pnl_pct REAL,
  cumulative_pnl REAL,
  open_positions INTEGER,
  high_water_mark REAL,
  snapshot_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wash_sale_tracker (
  ticker TEXT NOT NULL,
  loss_sale_date TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  loss_amount REAL,
  PRIMARY KEY (ticker, loss_sale_date)
);

CREATE INDEX IF NOT EXISTS idx_stock_exec_status ON stock_executions(status);
CREATE INDEX IF NOT EXISTS idx_stock_exec_ticker ON stock_executions(ticker);
CREATE INDEX IF NOT EXISTS idx_stock_pos_status ON stock_positions(status);
CREATE INDEX IF NOT EXISTS idx_stock_pos_ticker ON stock_positions(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON portfolio_snapshots(snapshot_at);
```

### 2. `src/execution/alpaca-client.ts`

Alpaca REST API wrapper. Paper trading URL: `https://paper-api.alpaca.markets`.

```typescript
// Key functions:

// Account
getAccount(): Promise<AlpacaAccount>
// Returns: id, status, buying_power, portfolio_value, cash, equity, etc.

// Orders
submitOrder(params: OrderParams): Promise<AlpacaOrder>
// OrderParams: { symbol, qty OR notional, side, type, time_in_force, 
//                limit_price?, stop_price?, trail_percent?,
//                order_class?, take_profit?, stop_loss? }
// For bracket orders: order_class="bracket", take_profit={limit_price}, stop_loss={stop_price}
cancelOrder(orderId: string): Promise<void>
getOrder(orderId: string): Promise<AlpacaOrder>
listOrders(params: { status, symbols }): Promise<AlpacaOrder[]>
replaceOrder(orderId: string, params: Partial<OrderParams>): Promise<AlpacaOrder>

// Positions
getPositions(): Promise<AlpacaPosition[]>
getPosition(symbol: string): Promise<AlpacaPosition>
closePosition(symbol: string, qty?: number): Promise<AlpacaOrder>

// Assets
getAsset(symbol: string): Promise<AlpacaAsset>
// Check: tradable, fractionable, easy_to_borrow, status

// Market
getClock(): Promise<{ is_open, next_open, next_close }>
getCalendar(start, end): Promise<CalendarDay[]>

// Auth: headers APCA-API-KEY-ID + APCA-API-SECRET-KEY from config
// Base URL: config.ALPACA_PAPER ? paper-api.alpaca.markets : api.alpaca.markets
// Rate limit: 200 req/min — implement token bucket
// All amounts use notional (USD) not share count — enables fractional shares

// Paper trading simulation layer:
// Add artificial delay (1-5s random) and slippage (0.1% random) to paper fills
// to avoid overly optimistic backtesting
```

### 3. `src/execution/signal-filter.ts`

Validates whether a detected trade should be copied.

```typescript
interface SignalDecision {
  copy: boolean;
  reason: string;
  sleeve: 'senator' | '13f';
  priority: number; // 1-10, for daily trade limit queue
  boosts: string[]; // committee_aligned, repeat_buy, cluster
}

// SENATOR SIGNAL FILTERS (reject if ANY):
// - direction != 'buy' (exception: sells > $250K from Intel/Armed Services)
// - amount_midpoint < $50,000
// - filing delay > 45 days from trade_date
// - senator not in top 20 by composite score
// - senator marked as retiring or under investigation
// - ticker not tradable on Alpaca (check getAsset)
// - market cap < $1B (need price data or Alpaca asset info)
// - broad ETF (SPY, QQQ, VOO, VTI, IWM, DIA, etc. — maintain blocklist)
// - within 5 trading days of earnings (need earnings calendar)
// - ticker in wash_sale_tracker cooldown
// - spouse-only trade (if detectable from filing)
// - blind trust / managed account

// SIGNAL BOOSTS (increase priority and sizing multiplier):
// - committee_aligned: senator's committee matches stock's GICS sector
// - repeat_buy: same senator bought same ticker within 90 days
// - cluster: 3+ senators from same committee bought same sector within 14 days

// 13F SIGNAL FILTERS:
// - new_position (0 → any) → copy
// - significant_add (>= 25% increase in shares) → copy
// - exit_position → sell
// - significant_trim (>= 25% decrease) → sell
// - unchanged or small_trim (< 10%) → ignore
// - fund holds 500+ names → too diversified, ignore

// MAX 3 NEW TRADES PER DAY
// If more signals, queue by priority, execute highest priority first
```

### 4. `src/execution/position-sizer.ts`

Calculates position size based on signal, risk, and portfolio state.

```typescript
interface SizeResult {
  amountUsd: number;
  quantity: number; // for share-based orders
  notional: number; // for notional orders (preferred)
  sizePct: number;  // of total portfolio
}

// SENATOR SLEEVE:
// base = 2.5% of senator sleeve value ($60k * 0.025 = $1,500)
// 
// Multipliers (stack multiplicatively, cap at hard limit):
//   senator rank 1-5:   * 1.5
//   senator rank 6-10:  * 1.25
//   senator rank 11-20: * 1.0
//   committee_aligned:  * 1.3
//   repeat_buy:         * 1.3
//   cluster_signal:     * 1.5
//
// Hard caps (checked AFTER multipliers):
//   max single position: 5% of total portfolio ($5,000)
//   max sector (GICS L1): 25% of total portfolio
//   max single senator exposure: 15% of total portfolio
//   max same ticker aggregate: 5% regardless of signals
//   cash reserve never below 10%
//
// If adding this position would breach any cap → reduce size to fit, or reject

// 13F SLEEVE:
// new_position (1 fund): 2% of 13F sleeve
// new_position (2 funds): 3% of 13F sleeve
// new_position (3+ funds): 5% of 13F sleeve
// buffett new position: always 5% of 13F sleeve
// Same hard caps apply

// Use Alpaca notional orders (fractional shares enabled)
```

### 5. `src/execution/order-manager.ts`

Handles order lifecycle: submit, monitor, resubmit, cancel.

```typescript
// ENTRY ORDER FLOW (Senator):
// 1. Check market clock — only execute 10:00-15:45 ET
// 2. Check if stock moved > 5% since filing → skip (alpha already priced)
// 3. Submit limit order: previous_close * 1.003 (0.3% above)
// 4. Monitor: if not filled after 2h → cancel, resubmit at current_mid * 1.005
// 5. If not filled by 15:45 → cancel. Re-evaluate next trading day
// 6. On fill: create stock_position, attach stop-loss order
//    - Default stop: -8% below entry (or ATR-adjusted)
//    - Use bracket order (order_class="bracket") if possible
//    - Otherwise: separate stop-limit order (stop=trigger, limit=trigger*0.98)

// ENTRY ORDER FLOW (13F):
// 1. Wait 3-5 days after 13F filing deadline
// 2. Spread entry over 5 days: 20% per day via limit orders
// 3. Entry limit: current_price * 0.98 (2% below)
// 4. If not filled after 5 days → buy at market
// 5. On fill: create stock_position with -12% stop

// EXIT ORDER FLOW:
// On stop trigger → market order (time_in_force="gtc")
// On take-profit → limit order
// On senator exit signal → market order within next execution window
// On time stop → market order at 10:00 ET

// ORDER MONITORING:
// Poll /v2/orders every 60 seconds during market hours
// Update stock_executions status on state changes
// Handle partial fills: update filled_quantity, recalculate position size
```

### 6. `src/execution/position-monitor.ts`

Runs during market hours. Monitors all open positions, triggers exits.

```typescript
// Runs every 5 minutes during market hours (via scheduler)

// For each open stock_position:
// 1. Fetch current price from Alpaca position or market data
// 2. Update current_price in DB
// 3. Check exits in priority order:

// SENATOR EXIT SIGNAL (highest priority):
// If same senator files a SALE for same ticker → immediate sell
// Query: any new trade with same politician_id, same ticker, direction='sell'

// STOP-LOSS CHECK:
// Alpaca manages the stop order — check if it was triggered
// If position.stop_loss_order filled → update status, calculate P&L

// TRAILING STOP ACTIVATION:
// Senator: if unrealized gain >= +15% AND trailing_stop_active = false:
//   Cancel existing stop order
//   Submit trailing stop order (trail_percent=5)
//   Set trailing_stop_active = true
// 13F: activation at +20%, trail_percent=8

// TAKE PROFIT:
// Senator: at +25% unrealized → sell 50%, let rest ride with trailing stop
// 13F: no fixed TP, rely on trailing stop and fund exit signals

// TIME STOPS (graduated):
// Senator positions:
//   Day 30: if PnL < -5% → Discord alert (flag only)
//   Day 60: if PnL between -5% and +5% (flat) → sell 50%
//   Day 90: sell remaining (unless trailing stop active, which means position is up)
// 13F positions:
//   No time stop for Buffett (hold until he sells or trailing stop)
//   For other funds: hold until next 13F. If fund exited → sell within 5 days

// FLASH CRASH PROTECTION:
// If position drops > 10% in < 5 minutes:
//   DO NOT auto-sell (likely to recover)
//   WIDEN stop by 5% temporarily
//   Alert Discord
//   Wait 30 minutes, then re-evaluate

// WASH SALE TRACKING:
// On loss sale: insert into wash_sale_tracker with cooldown_until = sale_date + 31 days
// signal-filter checks this before allowing new buy of same ticker
```

### 7. `src/execution/risk-engine.ts`

Portfolio-level risk management.

```typescript
interface RiskCheck {
  allowed: boolean;
  reason?: string;
  adjustedSize?: number;
}

// Called before every new order. Returns allow/deny + optional size adjustment.

// CHECKS (in order):
// 1. Circuit breakers active? (daily/weekly/monthly drawdown triggered)
// 2. Max 3 new trades today?
// 3. Cash reserve >= 10% after this trade?
// 4. Single position <= 5% of NAV?
// 5. Sector exposure <= 25% after this trade?
// 6. Single senator exposure <= 15%?
// 7. Same ticker aggregate <= 5%?
// 8. VIX > 30? → reject new entries
// 9. Correlation with existing positions < 0.7? (optional, Phase 3)

// DRAWDOWN TRACKING:
// Daily PnL tracking (compare current equity vs start-of-day equity)
//   daily_drawdown >= 3% → pause all new entries for 24h
//   weekly_drawdown >= 7% → pause 72h + Discord alert for manual review
//   monthly_drawdown >= 15% from high-water mark → reduce to 25% gross, full pause
// Track high-water mark in portfolio_snapshots

// CIRCUIT BREAKERS:
// 5 consecutive losing trades → pause 6h
// Margin utilization > 130% → refuse new entries
// Alpaca account trading_blocked or account_blocked → full stop + alert

// PORTFOLIO HEAT:
// sum(position_size_pct * stop_distance_pct) for all open positions
// If heat > 8% → reduce position sizes for new entries proportionally
```

### 8. `src/execution/rebalancer.ts`

Quarterly 13F rebalance logic.

```typescript
// Triggered when new 13F diff is detected (existing alertEngine.process13FDiffs)

// REBALANCE PROTOCOL:
// 1. Wait 3-5 days after 13F filing deadline (filing herding fades)
// 2. Compare new holdings vs current 13F sleeve positions
// 3. Generate rebalance orders:
//    - fund exited position → sell entire position (market order at 10:00 ET)
//    - fund decreased > 25% → trim proportionally
//    - fund increased > 25% → add proportionally
//    - fund new position → buy (size per position-sizer rules)
//    - fund unchanged → hold
// 4. Execute sells FIRST, wait 10min, then execute buys
// 5. Spread buys over 5 days (20% per day via limit orders)
// 6. Cross-fund exit: if 2+ tracked funds exit same stock in same quarter → immediate sell

// QUARTERLY CALENDAR:
// Q1 deadline: Feb 14 → watch for filings Feb 14-20, execute Feb 17-22
// Q2 deadline: May 15 → watch May 15-21, execute May 18-23
// Q3 deadline: Aug 14 → watch Aug 14-20, execute Aug 17-22
// Q4 deadline: Nov 14 → watch Nov 14-20, execute Nov 17-22
```

### 9. Modify existing files

**`src/config.ts`** — Add to env schema:
```
ALPACA_KEY_ID (already in .env)
ALPACA_SECRET_KEY (already in .env)
ALPACA_PAPER (boolean, already in .env)
EXECUTION_ENABLED (boolean, default false)
EXECUTION_MODE (enum: paper | live, default paper)
MAX_DAILY_TRADES (number, default 3)
```

**`src/index.ts`** — After trade ingestion, pipe to signal-filter → execution:
```typescript
// In ingestTradeSource, after insertTrades:
// import { signalFilter } from "./execution/signal-filter.js";
// import { orderManager } from "./execution/order-manager.js";
// for (const trade of inserted) {
//   const decision = signalFilter.evaluate(trade);
//   if (decision.copy) await orderManager.submitEntry(trade, decision);
// }

// Add position monitor to scheduler:
// scheduleEvery("position-monitor", 5 * 60 * 1000, () => positionMonitor.checkAll());
// scheduleEvery("portfolio-snapshot", 60 * 60 * 1000, () => riskEngine.snapshot());

// Add 13F rebalance hook:
// In ingest13F, after alertEngine.process13FDiffs:
// if (isNewFiling) await rebalancer.onNewFiling(diffs);
```

**`src/alerting/alert-engine.ts`** — Add execution notifications to Discord:
```typescript
// New alert types: 'order_placed', 'order_filled', 'stop_triggered',
//   'trailing_activated', 'time_stop', 'senator_exit', 'rebalance'
// Format: embed with ticker, direction, size, price, P&L, reason
```

**`package.json`** — No new dependencies needed. Alpaca API is REST-only, use native fetch.

## Daily Review (Claude Code Cron)

Once per day at 21:00 UTC (after market close):
1. Query portfolio_snapshots for today's snapshot
2. Query all stock_executions from today
3. Query all open stock_positions with current P&L
4. Calculate: daily P&L, cumulative P&L, win rate, exposure by sleeve/sector
5. Log to memory system (finance brain)
6. Post Discord embed:
   - Portfolio value, daily P&L ($, %), weekly P&L
   - Trades executed today (entries + exits)
   - Top gainer / worst position
   - Exposure: senator sleeve %, 13F sleeve %, cash %
   - Risk status: any circuit breakers active?
   - Open positions count by sleeve

## Alpaca API Notes

- Paper URL: https://paper-api.alpaca.markets
- Live URL: https://api.alpaca.markets  
- Auth: APCA-API-KEY-ID + APCA-API-SECRET-KEY headers
- Rate limit: 200 req/min
- Bracket orders: order_class="bracket", side="buy", take_profit={limit_price}, stop_loss={stop_price}
- Trailing stops: type="trailing_stop", trail_percent=5
- Notional orders: notional=1500 (USD amount, enables fractional shares)
- Market hours: 9:30-16:00 ET, extended hours available but not recommended
- Paper fills are instant at mid — add simulated slippage
- WebSocket for trade updates: wss://paper-api.alpaca.markets/stream (optional, can poll instead)
- Check getClock() before submitting orders — reject if market closed
- Assets endpoint: /v2/assets/{symbol} — check tradable, fractionable before ordering
