import type Database from "better-sqlite3";
import { detectClusters } from "../ranking/cluster-detector.js";
import type { AlertInput, FundHoldingInput, NormalizedTrade } from "../types.js";
import type { SignalDecision } from "../execution/signal-filter.js";
import { insertAlert, markAlertDiscordSent } from "../db/queries.js";
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

  async rankingChanged() {
    await this.persistAndSend({
      type: "ranking",
      severity: "low",
      title: "Politician rankings updated",
      body: "Composite ranking recalculated using alpha, win rate, Sharpe-like ratio, profit factor, frequency, and recency."
    });
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
