import type Database from "better-sqlite3";
import { detectClusters } from "../ranking/cluster-detector.js";
import type { AlertInput, FundHoldingInput, NormalizedTrade } from "../types.js";
import type { SignalDecision } from "../execution/signal-filter.js";
import { insertAlert, markAlertDiscordSent, sourcesDownSince } from "../db/queries.js";
import { DiscordAlerter } from "./discord.js";
import { formatSignalIntent } from "./formatters.js";
import { logger } from "../utils/logger.js";

export class AlertEngine {
  private readonly discord = new DiscordAlerter();

  constructor(private readonly db: Database.Database) {}

  async processTrades(trades: NormalizedTrade[]) {
    for (const trade of trades) {
      const alert = this.tradeAlert(trade);
      await this.persistAndSend(alert);
    }

    for (const cluster of detectClusters(this.db)) {
      const alreadyAlerted = this.db.prepare(
        `SELECT 1 FROM alerts WHERE type = 'cluster' AND title LIKE '%' || ? || '%' AND created_at > datetime('now', '-24 hours') LIMIT 1`
      ).get(cluster.ticker);
      if (alreadyAlerted) continue;
      await this.persistAndSend({
        type: "cluster",
        severity: "high",
        title: `Cluster buy detected: ${cluster.ticker}`,
        body: `${cluster.politicianCount} politicians bought ${cluster.ticker} across ${cluster.tradeCount} trades in the last 30 days.`,
        data: cluster
      });
    }
  }

  async process13FDiffs(diffs: FundHoldingInput[]) {
    for (const holding of diffs) {
      const changeType = holding.changeType;
      const changePct = holding.changePct ?? 0;
      let severity: AlertInput["severity"] = "low";
      if (changeType === "new" || changeType === "exit") severity = "high";
      else if (changeType === "increase" && changePct > 0.25) severity = "medium";

      await this.persistAndSend({
        type: "13f",
        severity,
        title: `${holding.fundName}: ${changeType ?? "updated"} ${holding.securityName}`,
        body: `${holding.fundName} ${changeType ?? "updated"} ${holding.securityName} (${holding.cusip}); shares=${holding.shares.toLocaleString()}.`,
        data: holding
      });
    }
  }

  /**
   * Alert only when the ranked set actually changed: compares the top-30
   * senate / top-15 house lists (membership AND order) between the two most
   * recent ranking batches, and puts the diff in the body. The previous
   * unconditional daily alert carried no information.
   */
  async rankingChanged() {
    const batches = this.db
      .prepare("SELECT DISTINCT computed_at FROM rankings ORDER BY computed_at DESC LIMIT 2")
      .all() as Array<{ computed_at: string }>;
    if (batches.length === 0) return;

    const topFor = (computedAt: string) =>
      this.db
        .prepare(
          `SELECT p.name, p.chamber, r.rank_position
           FROM rankings r
           JOIN politicians p ON p.id = r.politician_id
           WHERE r.computed_at = ?
             AND ((p.chamber = 'senate' AND r.rank_position <= 30) OR (p.chamber = 'house' AND r.rank_position <= 15))
           ORDER BY p.chamber, r.rank_position`
        )
        .all(computedAt) as Array<{ name: string; chamber: string; rank_position: number }>;

    const current = topFor(batches[0]!.computed_at);
    const previous = batches.length > 1 ? topFor(batches[1]!.computed_at) : [];
    const key = (row: { name: string; chamber: string; rank_position: number }) => `${row.chamber}|${row.name}|${row.rank_position}`;
    const currentKeys = new Set(current.map(key));
    const previousKeys = new Set(previous.map(key));
    if (batches.length > 1 && current.length === previous.length && current.every((row) => previousKeys.has(key(row)))) {
      logger.info("ranking recomputed; ranked set unchanged, no alert");
      return;
    }

    const entered = current.filter((row) => !previous.some((p) => p.chamber === row.chamber && p.name === row.name));
    const left = previous.filter((row) => !current.some((c) => c.chamber === row.chamber && c.name === row.name));
    const moved = current.filter((row) => {
      const before = previous.find((p) => p.chamber === row.chamber && p.name === row.name);
      return before && before.rank_position !== row.rank_position;
    });
    const lines: string[] = [];
    if (previous.length === 0) lines.push(`First ranked batch: ${current.length} politicians in the copy set.`);
    if (entered.length) lines.push(`Entered: ${entered.map((r) => `${r.name} (${r.chamber} #${r.rank_position})`).join(", ")}.`);
    if (left.length) lines.push(`Left: ${left.map((r) => `${r.name} (${r.chamber})`).join(", ")}.`);
    if (moved.length) {
      lines.push(
        `Moved: ${moved
          .map((r) => {
            const before = previous.find((p) => p.chamber === r.chamber && p.name === r.name)!;
            return `${r.name} (${r.chamber} #${before.rank_position}→#${r.rank_position})`;
          })
          .join(", ")}.`
      );
    }

    await this.persistAndSend({
      type: "ranking",
      severity: "low",
      title: "Politician copy-set ranking changed",
      body: lines.join(" ") || "Ranked set changed.",
      data: { entered, left, moved }
    });
  }

  /** Discord alert when a source has been down/erroring for more than 24h (deduped to one alert per source per 24h). */
  async checkSourceHealthAlerts() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    for (const source of sourcesDownSince(this.db, cutoff)) {
      await this.dedupedSystemAlert({
        type: "source_down",
        severity: "high",
        title: `Source down: ${source.source}`,
        body: `${source.source} has been failing health checks since ${source.down_since} (UTC). Last error: ${source.message ?? "unknown"}.`,
        data: source
      });
    }
  }

  /** Discord alert when no congressional trade has been ingested for more than 7 days. */
  async checkIngestionStalled() {
    const row = this.db.prepare("SELECT max(detected_at) AS latest FROM trades").get() as { latest: string | null };
    if (!row.latest) return;
    const ageMs = Date.now() - new Date(row.latest.includes("Z") || row.latest.includes("+") ? row.latest : `${row.latest.replace(" ", "T")}Z`).getTime();
    if (ageMs <= 7 * 24 * 60 * 60 * 1000) return;
    await this.dedupedSystemAlert({
      type: "ingestion_stalled",
      severity: "high",
      title: "Congressional trade ingestion stalled",
      body: `No congressional trades ingested since ${row.latest} (UTC) — more than 7 days. Check Quiver/house-clerk sources.`,
      data: { latestDetectedAt: row.latest }
    });
  }

  /** Generic system alert used by reconciliation and rebalance instrumentation. */
  async systemAlert(alert: AlertInput) {
    await this.persistAndSend(alert);
  }

  private async dedupedSystemAlert(alert: AlertInput, windowHours = 24) {
    const already = this.db
      .prepare("SELECT 1 FROM alerts WHERE type = ? AND title = ? AND created_at > datetime('now', ?) LIMIT 1")
      .get(alert.type, alert.title, `-${windowHours} hours`);
    if (already) return;
    await this.persistAndSend(alert);
  }

  async signalIntent(decision: SignalDecision, sizing?: { notional: number; limitPrice: number | null }) {
    const { title, body } = formatSignalIntent(decision, sizing);
    await this.persistAndSend({
      type: "signal_intent",
      severity: decision.priority >= 7 ? "high" : decision.priority >= 4 ? "medium" : "low",
      title,
      body,
      data: { ticker: decision.ticker, direction: decision.direction, sleeve: decision.sleeve, boosts: decision.boosts }
    });
  }

  async executionNotification(input: {
    type: string;
    ticker: string;
    direction: "buy" | "sell";
    size: number;
    price?: number | null;
    pnlUsd?: number | null;
    reason: string;
    data?: unknown;
  }) {
    const severity: AlertInput["severity"] = input.type === "stop_triggered" || input.type === "senator_exit" ? "high" : "medium";
    const price = input.price ? ` @ $${input.price.toFixed(2)}` : "";
    const pnl = input.pnlUsd !== undefined && input.pnlUsd !== null ? `; P&L $${Math.round(input.pnlUsd).toLocaleString()}` : "";
    await this.persistAndSend({
      type: input.type,
      severity,
      title: `Execution ${input.type}: ${input.ticker}`,
      body: `${input.direction.toUpperCase()} ${input.size.toLocaleString()} ${input.ticker}${price}; reason=${input.reason}${pnl}.`,
      data: input.data ?? input
    });
  }

  private tradeAlert(trade: NormalizedTrade): AlertInput {
    const midpoint = trade.amountMidpoint ?? 0;
    const title = `${trade.politician.name} ${trade.direction} ${trade.ticker ?? trade.assetName}`;
    const rank = this.latestRankFor(trade.politician.name, trade.politician.chamber);
    if (trade.politician.chamber === "senate" && trade.direction === "buy" && midpoint > 100_000 && rank !== null && rank <= 5) {
      return {
        type: "trade",
        severity: "high",
        title,
        body: `${trade.politician.name} bought ${trade.ticker ?? trade.assetName} for ${trade.amountRange ?? `$${Math.round(midpoint).toLocaleString()}`}.`,
        data: trade
      };
    }
    if (trade.politician.chamber === "senate" && trade.direction === "buy" && midpoint > 50_000 && rank !== null && rank <= 20) {
      return {
        type: "trade",
        severity: "medium",
        title,
        body: `${trade.politician.name} bought ${trade.ticker ?? trade.assetName} for ${trade.amountRange ?? `$${Math.round(midpoint).toLocaleString()}`}.`,
        data: trade
      };
    }
    return {
      type: "trade",
      severity: "low",
      title,
      body: `${trade.politician.name} filed a ${trade.direction} disclosure for ${trade.ticker ?? trade.assetName}.`,
      data: trade
    };
  }

  private latestRankFor(name: string, chamber: string) {
    const row = this.db
      .prepare(
        `SELECT r.rank_position
         FROM rankings r
         JOIN politicians p ON p.id = r.politician_id
         WHERE p.name = ? AND p.chamber = ?
           AND r.computed_at = (SELECT max(computed_at) FROM rankings)
         ORDER BY r.rank_position ASC
         LIMIT 1`
      )
      .get(name, chamber) as { rank_position: number } | undefined;
    return row?.rank_position ?? null;
  }

  async processBatchNotification(alert: AlertInput) {
    await this.persistAndSend(alert);
  }

  private async persistAndSend(alert: AlertInput) {
    const alertId = insertAlert(this.db, alert);
    try {
      const sent = await this.discord.send(alert);
      if (sent) markAlertDiscordSent(this.db, alertId);
    } catch (error) {
      logger.error({ alertId, err: error instanceof Error ? error.message : String(error) }, "discord send failed");
    }
  }
}
