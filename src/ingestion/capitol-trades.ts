import type { NormalizedTrade } from "../types.js";
import { BaseSource } from "./base-source.js";

export class CapitolTradesSource extends BaseSource {
  readonly name = "capitol-trades";

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    return [];
  }
}
