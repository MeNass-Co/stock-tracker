import type { RankingMetrics, RankingResult } from "../types.js";

/**
 * Ranks politicians per chamber: z-scores and rank_position are computed
 * within each chamber partition, so a "top 15 house" cap means rank within
 * the House, not a slice of a global senate-dominated list.
 */
export function compositeRank(metrics: RankingMetrics[]): RankingResult[] {
  const partitions = new Map<string, RankingMetrics[]>();
  for (const metric of metrics) {
    const key = metric.chamber ?? "";
    const bucket = partitions.get(key) ?? [];
    bucket.push(metric);
    partitions.set(key, bucket);
  }
  const results: RankingResult[] = [];
  for (const partition of partitions.values()) {
    results.push(...rankPartition(partition));
  }
  return results;
}

function rankPartition(metrics: RankingMetrics[]): RankingResult[] {
  if (metrics.length === 0) return [];
  const maxTrades = Math.max(...metrics.map((metric) => metric.tradeCount));
  const alpha = zscores(metrics.map((metric) => metric.alpha));
  const winRate = zscores(metrics.map((metric) => metric.winRate));
  const sharpe = zscores(metrics.map((metric) => metric.sharpe));
  const profitFactor = zscores(metrics.map((metric) => metric.profitFactor));

  return metrics
    .map((metric, index) => {
      const logFreqBonus = maxTrades <= 1 ? 0 : Math.log2(metric.tradeCount) / Math.log2(maxTrades);
      const score =
        0.3 * alpha[index] +
        0.2 * winRate[index] +
        0.2 * sharpe[index] +
        0.15 * profitFactor[index] +
        0.1 * logFreqBonus +
        0.05 * metric.recencyBonus;
      return { ...metric, score, rankPosition: 0 };
    })
    .sort((a, b) => b.score - a.score)
    .map((metric, index) => ({ ...metric, rankPosition: index + 1 }));
}

function zscores(values: number[]) {
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const std = Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
  if (std === 0) return values.map(() => 0);
  return values.map((value) => (value - avg) / std);
}
