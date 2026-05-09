import { config } from "../config.js";
import type { AlertInput } from "../types.js";
import { formatDiscordAlert } from "./formatters.js";

export class DiscordAlerter {
  async send(alert: AlertInput) {
    if (!config.DISCORD_WEBHOOK_URL) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(config.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formatDiscordAlert(alert))
      });
      if (response.ok || response.status === 204) return true;
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") || "2") * 1000;
        await new Promise((r) => setTimeout(r, retryAfter));
        continue;
      }
      throw new Error(`Discord webhook failed: ${response.status}`);
    }
    return false;
  }
}
