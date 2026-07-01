import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { canonicalizePoliticianName } from "../parsing/normalizer.js";

export const schemaSql = `
CREATE TABLE IF NOT EXISTS politicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  chamber TEXT NOT NULL CHECK (chamber IN ('senate', 'house')),
  state TEXT,
  party TEXT,
  committees TEXT,
  active INTEGER DEFAULT 1,
  cik TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(name, chamber)
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell', 'exchange')),
  amount_range TEXT,
  amount_midpoint REAL,
  asset_type TEXT DEFAULT 'stock',
  source TEXT NOT NULL,
  source_id TEXT,
  raw_data TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_dedup
ON trades(politician_id, COALESCE(ticker, ''), trade_date, direction, COALESCE(amount_range, ''));

CREATE TABLE IF NOT EXISTS fund_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_name TEXT NOT NULL,
  fund_cik TEXT NOT NULL,
  report_date TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  ticker TEXT,
  cusip TEXT NOT NULL,
  security_name TEXT NOT NULL,
  shares REAL NOT NULL,
  value_thousands REAL NOT NULL,
  change_type TEXT,
  change_shares REAL,
  change_pct REAL,
  UNIQUE(fund_cik, report_date, cusip)
);

CREATE TABLE IF NOT EXISTS rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER NOT NULL REFERENCES politicians(id),
  computed_at TEXT NOT NULL,
  score REAL NOT NULL,
  alpha REAL,
  win_rate REAL,
  sharpe REAL,
  profit_factor REAL,
  trade_count INTEGER,
  rank_position INTEGER
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  discord_sent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prices (
  ticker TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (ticker, date)
);

CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  ok INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  message TEXT,
  down_since TEXT
);

CREATE TABLE IF NOT EXISTS signal_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER,
  sleeve TEXT NOT NULL CHECK(sleeve IN ('senator', '13f')),
  ticker TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  fund_cik TEXT,
  report_date TEXT,
  decided_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS house_seen_docs (
  doc_id TEXT PRIMARY KEY,
  seen_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('senator_trade', '13f_diff', 'stop_loss', 'take_profit', 'trailing_stop', 'time_stop', 'senator_exit', 'fund_exit', 'manual')),
  trigger_id INTEGER,
  position_id INTEGER REFERENCES stock_positions(id),
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
  post_fill_action TEXT,
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
  sector TEXT,
  status TEXT CHECK(status IN ('open', 'partial', 'closed')) DEFAULT 'open',
  pnl_usd REAL,
  pnl_ratio REAL,
  realized_pnl_usd REAL DEFAULT 0,
  realized_qty REAL DEFAULT 0,
  pending_exit_qty REAL DEFAULT 0,
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
  daily_pnl_ratio REAL,
  cumulative_pnl REAL,
  drawdown_usd REAL,
  spy_equity REAL,
  open_positions INTEGER,
  high_water_mark REAL,
  snapshot_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rebalance_runs (
  fund_cik TEXT NOT NULL,
  report_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  completed_at TEXT,
  last_error TEXT,
  PRIMARY KEY (fund_cik, report_date)
);

CREATE TABLE IF NOT EXISTS wash_sale_tracker (
  ticker TEXT NOT NULL,
  loss_sale_date TEXT NOT NULL,
  cooldown_until TEXT NOT NULL,
  loss_amount REAL,
  PRIMARY KEY (ticker, loss_sale_date)
);

CREATE INDEX IF NOT EXISTS idx_trades_politician ON trades(politician_id);
CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
CREATE INDEX IF NOT EXISTS idx_trades_date ON trades(trade_date);
CREATE INDEX IF NOT EXISTS idx_trades_filing ON trades(filing_date);
CREATE INDEX IF NOT EXISTS idx_fund_cik ON fund_holdings(fund_cik);
CREATE INDEX IF NOT EXISTS idx_fund_date ON fund_holdings(report_date);
CREATE INDEX IF NOT EXISTS idx_rankings_politician ON rankings(politician_id);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_stock_exec_status ON stock_executions(status);
CREATE INDEX IF NOT EXISTS idx_stock_exec_ticker ON stock_executions(ticker);
CREATE INDEX IF NOT EXISTS idx_stock_exec_position_id ON stock_executions(position_id);
CREATE INDEX IF NOT EXISTS idx_stock_pos_status ON stock_positions(status);
CREATE INDEX IF NOT EXISTS idx_stock_pos_ticker ON stock_positions(ticker);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON portfolio_snapshots(snapshot_at);
`;

const idempotentMigrations: string[] = [
  "ALTER TABLE stock_executions ADD COLUMN position_id INTEGER REFERENCES stock_positions(id)",
  "ALTER TABLE stock_executions ADD COLUMN post_fill_action TEXT",
  "ALTER TABLE stock_positions ADD COLUMN pending_exit_qty REAL DEFAULT 0",
  "ALTER TABLE stock_positions ADD COLUMN realized_pnl_usd REAL DEFAULT 0",
  "ALTER TABLE stock_positions ADD COLUMN realized_qty REAL DEFAULT 0",
  "ALTER TABLE stock_positions RENAME COLUMN pnl_pct TO pnl_ratio",
  "ALTER TABLE portfolio_snapshots RENAME COLUMN daily_pnl_pct TO daily_pnl_ratio",
  `CREATE TABLE IF NOT EXISTS rebalance_runs (
    fund_cik TEXT NOT NULL,
    report_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    completed_at TEXT,
    last_error TEXT,
    PRIMARY KEY (fund_cik, report_date)
  )`,
  "ALTER TABLE rebalance_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'in_progress'",
  "ALTER TABLE rebalance_runs ADD COLUMN last_error TEXT",
  "CREATE INDEX IF NOT EXISTS idx_stock_exec_position_id ON stock_executions(position_id)",
  "ALTER TABLE source_health ADD COLUMN down_since TEXT",
  "ALTER TABLE portfolio_snapshots ADD COLUMN drawdown_usd REAL",
  "ALTER TABLE portfolio_snapshots ADD COLUMN spy_equity REAL",
  "CREATE INDEX IF NOT EXISTS idx_signal_decisions_trade ON signal_decisions(trade_id)",
  "CREATE INDEX IF NOT EXISTS idx_signal_decisions_fund ON signal_decisions(fund_cik, report_date)"
];

/**
 * One-off data-cleanup migrations, tracked by name in schema_migrations so each
 * runs exactly once per database. Keep every entry idempotent anyway.
 */
const DUST_EPSILON_SQL = "1e-6";

const oneOffMigrations: Array<{ name: string; run: (db: Database.Database) => void }> = [
  {
    // Audit fix: immortal dust positions (float-math remainders like 5.55e-17)
    // kept status='partial' with pending_exit_qty reserved forever, blocking
    // soft-stops and causing endless Alpaca 404 polling.
    name: "002_close_dust_positions",
    run(db) {
      db.exec(`
        UPDATE stock_positions
        SET status = 'closed',
            closed_at = COALESCE(closed_at, datetime('now')),
            exit_reason = COALESCE(exit_reason, 'dust_cleanup'),
            quantity = 0,
            pending_exit_qty = 0
        WHERE status IN ('open', 'partial') AND quantity <= ${DUST_EPSILON_SQL};

        UPDATE stock_positions
        SET pending_exit_qty = 0
        WHERE pending_exit_qty > 0 AND pending_exit_qty <= ${DUST_EPSILON_SQL};
      `);
    }
  },
  {
    // Audit fix: duplicate politician rows differing only by name suffix
    // ("August Lee Pfluger" vs "August Lee Pfluger Ii"). Merge onto the
    // canonical (suffix-stripped) name, repoint trades/rankings, drop dupes.
    name: "003_merge_duplicate_politicians",
    run(db) {
      const rows = db.prepare("SELECT id, name, chamber FROM politicians").all() as Array<{ id: number; name: string; chamber: string }>;
      const groups = new Map<string, Array<{ id: number; name: string }>>();
      for (const row of rows) {
        const canonical = canonicalizePoliticianName(row.name);
        const key = `${canonical}|${row.chamber}`;
        groups.set(key, [...(groups.get(key) ?? []), { id: row.id, name: row.name }]);
      }

      const tx = db.transaction(() => {
        for (const [key, members] of groups) {
          const canonical = key.split("|")[0]!;
          const keeper = members.reduce((min, member) => (member.id < min.id ? member : min));
          for (const dup of members) {
            if (dup.id === keeper.id) continue;
            // Trades under the duplicate that collide with an identical trade
            // under the keeper (same dedup key) are true duplicates: repoint
            // any execution references to the keeper's trade, then delete.
            const collisions = db.prepare(
              `SELECT d.id AS dup_trade_id, k.id AS keeper_trade_id
               FROM trades d
               JOIN trades k ON k.politician_id = ?
                 AND ifnull(k.ticker, '') = ifnull(d.ticker, '')
                 AND k.trade_date = d.trade_date
                 AND k.direction = d.direction
                 AND ifnull(k.amount_range, '') = ifnull(d.amount_range, '')
               WHERE d.politician_id = ?`
            ).all(keeper.id, dup.id) as Array<{ dup_trade_id: number; keeper_trade_id: number }>;
            for (const collision of collisions) {
              db.prepare("UPDATE stock_executions SET trigger_id = ? WHERE trigger_id = ?")
                .run(collision.keeper_trade_id, collision.dup_trade_id);
              db.prepare("UPDATE signal_decisions SET trade_id = ? WHERE trade_id = ?")
                .run(collision.keeper_trade_id, collision.dup_trade_id);
              db.prepare("DELETE FROM trades WHERE id = ?").run(collision.dup_trade_id);
            }
            db.prepare("UPDATE trades SET politician_id = ? WHERE politician_id = ?").run(keeper.id, dup.id);
            db.prepare("UPDATE rankings SET politician_id = ? WHERE politician_id = ?").run(keeper.id, dup.id);
            db.prepare("DELETE FROM politicians WHERE id = ?").run(dup.id);
          }
          if (keeper.name !== canonical) {
            // Guard against a pre-existing row already holding the canonical name.
            const clash = db.prepare("SELECT id FROM politicians WHERE name = ? AND chamber = ? AND id != ?")
              .get(canonical, key.split("|")[1], keeper.id);
            if (!clash) db.prepare("UPDATE politicians SET name = ?, updated_at = datetime('now') WHERE id = ?").run(canonical, keeper.id);
          }
        }
      });
      tx();
    }
  }
];

function runOneOffMigrations(db: Database.Database) {
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((row) => row.name)
  );
  for (const migration of oneOffMigrations) {
    if (applied.has(migration.name)) continue;
    const tx = db.transaction(() => {
      migration.run(db);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration.name);
    });
    tx();
  }
}

function runIdempotentMigrations(db: Database.Database) {
  for (const stmt of idempotentMigrations) {
    try {
      db.exec(stmt);
    } catch (error) {
      const message = String((error as Error).message ?? error).toLowerCase();
      const benign = /duplicate column|already exists|no such column/.test(message);
      if (!benign) throw error;
    }
  }
}

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(schemaSql);
  runIdempotentMigrations(db);
  runOneOffMigrations(db);
  return db;
}
