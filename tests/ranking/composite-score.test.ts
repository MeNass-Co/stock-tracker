import { describe, expect, it } from "vitest";
import { compositeRank } from "../../src/ranking/composite-score.js";

describe("compositeRank", () => {
  it("uses the specified weighted formula and minimum-ready metrics", () => {
    const rankings = compositeRank([
      { politicianId: 1, alpha: 0.2, winRate: 0.7, sharpe: 1.5, profitFactor: 2, tradeCount: 10, recencyBonus: 0.8 },
      { politicianId: 2, alpha: -0.1, winRate: 0.4, sharpe: -0.2, profitFactor: 0.8, tradeCount: 5, recencyBonus: 0.2 }
    ]);
    expect(rankings[0].politicianId).toBe(1);
    expect(rankings[0].rankPosition).toBe(1);
  });
});
