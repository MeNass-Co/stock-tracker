import TradeTable from "../components/TradeTable";
import { useTrades } from "../hooks/useApi";

export default function TradeHistory() {
  const { data = [], isLoading } = useTrades();
  if (isLoading) return <p className="text-muted">Loading trades...</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Trade History</h1>
      <TradeTable trades={data} />
    </div>
  );
}
