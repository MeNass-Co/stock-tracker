import { useFundManagers } from "../hooks/useApi";

export default function FundManagers() {
  const { data = [], isLoading } = useFundManagers();
  if (isLoading) return <p className="text-muted">Loading fund managers...</p>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Fund Managers</h1>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.map((fund) => (
          <article key={fund.cik} className="rounded-md border border-line bg-panel p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-white">{fund.manager}</h2>
                <p className="text-sm text-muted">{fund.fund}</p>
              </div>
              <span className="rounded border border-accent px-2 py-1 text-xs text-accent">Tier {fund.tier}</span>
            </div>
            <p className="mt-3 text-sm text-muted">{fund.style}</p>
            <p className="mt-1 text-xs text-muted">CIK {fund.cik}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
