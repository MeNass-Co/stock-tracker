import { config } from "../config.js";
import type { NormalizedTrade } from "../types.js";
import { BaseSource } from "./base-source.js";

export class UnusualWhalesSource extends BaseSource {
  readonly name = "unusual-whales";

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    if (!config.UNUSUAL_WHALES_API_KEY) return [];
    return [];
  }
}
