import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Ranking } from "../hooks/useApi";

export default function RankingChart({ rankings }: { rankings: Ranking[] }) {
  const data = rankings.slice(0, 10).map((ranking) => ({
    name: ranking.name,
    score: Number(ranking.score.toFixed(2))
  }));

  return (
    <div className="h-72 rounded-md border border-line bg-panel p-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 12, right: 12 }}>
          <XAxis type="number" stroke="#9aa3b2" />
          <YAxis dataKey="name" type="category" stroke="#9aa3b2" width={130} tick={{ fontSize: 12 }} />
          <Tooltip contentStyle={{ background: "#151821", border: "1px solid #2a3040" }} />
          <Bar dataKey="score" fill="#2dd4bf" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
