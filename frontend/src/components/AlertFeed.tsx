import type { Alert } from "../hooks/useApi";

const color = {
  high: "border-danger text-danger",
  medium: "border-warning text-warning",
  low: "border-accent text-accent"
};

export default function AlertFeed({ alerts }: { alerts: Alert[] }) {
  return (
    <div className="space-y-3">
      {alerts.map((alert) => (
        <article key={alert.id} className="rounded-md border border-line bg-panel p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-white">{alert.title}</h3>
            <span className={`rounded border px-2 py-1 text-xs uppercase ${color[alert.severity]}`}>{alert.severity}</span>
          </div>
          <p className="text-sm text-muted">{alert.body}</p>
          <time className="mt-3 block text-xs text-muted">{alert.created_at}</time>
        </article>
      ))}
    </div>
  );
}
