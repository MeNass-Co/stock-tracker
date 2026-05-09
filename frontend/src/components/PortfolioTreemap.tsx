import { ResponsiveContainer, Tooltip, Treemap } from "recharts";
import type { Holding } from "../hooks/useApi";

export default function PortfolioTreemap({ holdings }: { holdings: Holding[] }) {
  const data = holdings.slice(0, 40).map((holding) => ({
    name: holding.ticker ?? holding.security_name,
    size: holding.value_thousands
  }));

  return (
    <div className="h-[460px] rounded-md border border-line bg-panel p-4">
      <ResponsiveContainer width="100%" height="100%">
        <Treemap data={data} dataKey="size" nameKey="name" stroke="#0f1117" fill="#2dd4bf">
          <Tooltip contentStyle={{ background: "#151821", border: "1px solid #2a3040" }} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
