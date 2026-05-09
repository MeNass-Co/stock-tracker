export default function ClusterIndicator({
  clusters
}: {
  clusters: Array<{ ticker: string; politicianCount: number; tradeCount: number }>;
}) {
  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <h2 className="mb-3 text-sm font-semibold text-white">Active Clusters</h2>
      <div className="space-y-2">
        {clusters.length === 0 ? (
          <p className="text-sm text-muted">No 30-day buy clusters detected.</p>
        ) : (
          clusters.map((cluster) => (
            <div key={cluster.ticker} className="flex items-center justify-between rounded bg-[#1b202b] px-3 py-2 text-sm">
              <span className="font-semibold text-accent">{cluster.ticker}</span>
              <span className="text-muted">
                {cluster.politicianCount} politicians / {cluster.tradeCount} trades
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
