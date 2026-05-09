import type { AlertInput } from "../types.js";
import type { SignalDecision } from "../execution/signal-filter.js";

export function formatDiscordAlert(alert: AlertInput) {
  const emoji = alert.severity === "high" ? ":rotating_light:" : alert.severity === "medium" ? ":warning:" : ":information_source:";
  const mention = alert.severity === "high" ? "@everyone\n" : "";
  return {
    content: `${mention}${emoji} **${alert.title}**\n${alert.body}`,
    allowed_mentions: alert.severity === "high" ? { parse: ["everyone"] } : { parse: [] }
  };
}

export function formatSignalIntent(decision: SignalDecision, sizing?: { notional: number; limitPrice: number | null }): { title: string; body: string } {
  const dir = decision.direction.toUpperCase();
  const ticker = decision.ticker;
  const lines: string[] = [];

  if (decision.sleeve === "senator") {
    const who = decision.senatorName ?? "Unknown senator";
    const rank = decision.senatorRank ? ` (rank #${decision.senatorRank})` : "";
    const amount = typeof decision.metadata?.amountMidpoint === "number"
      ? ` — $${Math.round(decision.metadata.amountMidpoint as number).toLocaleString()}`
      : "";
    lines.push(`${who}${rank} filed ${decision.direction}${amount}`);
  } else if (decision.fundName) {
    lines.push(`${decision.fundName} 13F position change`);
  }

  if (decision.boosts.length > 0) lines.push(`Boosts: ${decision.boosts.join(", ")}`);
  lines.push(`Priority: ${decision.priority}/10`);

  if (sizing) {
    const price = sizing.limitPrice ? `limit $${sizing.limitPrice.toFixed(2)}` : "market";
    lines.push(`Sizing: $${Math.round(sizing.notional).toLocaleString()} @ ${price}`);
  }

  lines.push(`Reason: ${decision.reason}`);

  return {
    title: `${dir === "BUY" ? "\u{1F3AF}" : "\u{1F6AA}"} ${dir} ${ticker}`,
    body: lines.join("\n")
  };
}
