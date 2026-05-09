import AlertFeed from "../components/AlertFeed";
import { useAlerts } from "../hooks/useApi";

export default function AlertHistory() {
  const { data = [], isLoading } = useAlerts();
  if (isLoading) return <p className="text-muted">Loading alerts...</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Alert History</h1>
      <AlertFeed alerts={data} />
    </div>
  );
}
