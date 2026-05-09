import AlertFeed from "../components/AlertFeed";
import ClusterIndicator from "../components/ClusterIndicator";
import RankingChart from "../components/RankingChart";
import TradeTable from "../components/TradeTable";
import { useDashboard } from "../hooks/useApi";

export default function Dashboard() {
  const { data, isLoading, error } = useDashboard();
  if (isLoading) return <p className="text-muted">Loading dashboard...</p>;
  if (error || !data) return <p className="text-danger">Dashboard API unavailable.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Congress and 13F Signals</h1>
        <p className="mt-1 text-sm text-muted">Live ingestion, ranking, clusters, and fund-manager alerts.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Metric label="Recent Alerts" value={data.alerts.length} />
        <Metric label="Top Ranked" value={data.topRankings[0]?.name ?? "N/A"} />
        <Metric label="Clusters" value={data.clusters.length} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <RankingChart rankings={data.topRankings} />
        <ClusterIndicator clusters={data.clusters} />
      </div>
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">Latest Trades</h2>
        <TradeTable trades={data.recentTrades} />
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold text-white">Latest Alerts</h2>
        <AlertFeed alerts={data.alerts} />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="text-xs uppercase text-muted">{label}</div>
      <div className="mt-2 truncate text-xl font-semibold text-white">{value}</div>
    </div>
  );
}
