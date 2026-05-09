import type { NormalizedTrade, SourceHealth } from "../types.js";

export abstract class BaseSource {
  abstract readonly name: string;

  abstract fetchNewTrades(): Promise<NormalizedTrade[]>;

  async healthCheck(): Promise<SourceHealth> {
    return { source: this.name, ok: true, checkedAt: new Date().toISOString() };
  }
}
