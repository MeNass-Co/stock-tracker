import { useQuery } from "@tanstack/react-query";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type Alert = {
  id: number;
  type: string;
  severity: "high" | "medium" | "low";
  title: string;
  body: string;
  created_at: string;
};

export type Trade = {
  id: number;
  politician_name: string;
  chamber: string;
  ticker: string | null;
  asset_name: string;
  trade_date: string;
  filing_date: string;
  direction: string;
  amount_range: string | null;
  amount_midpoint: number | null;
  source: string;
};

export type Ranking = {
  politician_id: number;
  name: string;
  chamber: string;
  score: number;
  alpha: number;
  win_rate: number;
  sharpe: number;
  profit_factor: number;
  trade_count: number;
  rank_position: number;
};

export type Holding = {
  id: number;
  fund_name: string;
  fund_cik: string;
  report_date: string;
  ticker: string | null;
  cusip: string;
  security_name: string;
  shares: number;
  value_thousands: number;
  change_type: string | null;
  change_pct: number | null;
};

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) throw new Error(`API ${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () =>
      api<{
        alerts: Alert[];
        topRankings: Ranking[];
        recentTrades: Trade[];
        clusters: Array<{ ticker: string; politicianCount: number; tradeCount: number }>;
      }>("/api/dashboard")
  });
}

export function useRankings() {
  return useQuery({ queryKey: ["rankings"], queryFn: () => api<Ranking[]>("/api/rankings") });
}

export function useTrades() {
  return useQuery({ queryKey: ["trades"], queryFn: () => api<Trade[]>("/api/trades") });
}

export function useAlerts() {
  return useQuery({ queryKey: ["alerts"], queryFn: () => api<Alert[]>("/api/alerts") });
}

export function useBuffettPortfolio() {
  return useQuery({
    queryKey: ["portfolio", "buffett"],
    queryFn: () => api<{ fund: unknown; holdings: Holding[] }>("/api/portfolio/buffett")
  });
}

export function useFundManagers() {
  return useQuery({
    queryKey: ["fund-managers"],
    queryFn: () => api<Array<{ manager: string; fund: string; cik: string; tier: number; style: string }>>("/api/funds")
  });
}
