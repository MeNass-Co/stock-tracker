import RankingChart from "../components/RankingChart";
import { useRankings } from "../hooks/useApi";

export default function Rankings() {
  const { data = [], isLoading } = useRankings();
  if (isLoading) return <p className="text-muted">Loading rankings...</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Politician Rankings</h1>
      <RankingChart rankings={data} />
      <div className="overflow-hidden rounded-md border border-line">
        <table className="w-full text-left text-sm">
          <thead className="bg-[#1b202b] text-xs uppercase text-muted">
            <tr>
              <th className="px-3 py-3">Rank</th>
              <th className="px-3 py-3">Name</th>
              <th className="px-3 py-3">Score</th>
              <th className="px-3 py-3">Alpha</th>
              <th className="px-3 py-3">Win Rate</th>
              <th className="px-3 py-3">Trades</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.map((ranking) => (
              <tr key={ranking.politician_id}>
                <td className="px-3 py-3">{ranking.rank_position}</td>
                <td className="px-3 py-3 text-white">{ranking.name}</td>
                <td className="px-3 py-3">{ranking.score.toFixed(2)}</td>
                <td className="px-3 py-3">{(ranking.alpha * 100).toFixed(2)}%</td>
                <td className="px-3 py-3">{(ranking.win_rate * 100).toFixed(0)}%</td>
                <td className="px-3 py-3">{ranking.trade_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
