import PortfolioTreemap from "../components/PortfolioTreemap";
import { useBuffettPortfolio } from "../hooks/useApi";

export default function BuffettPortfolio() {
  const { data, isLoading } = useBuffettPortfolio();
  if (isLoading) return <p className="text-muted">Loading Berkshire portfolio...</p>;
  const holdings = data?.holdings ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-white">Berkshire Hathaway 13F</h1>
      <PortfolioTreemap holdings={holdings} />
    </div>
  );
}
