import { NavLink, Route, Routes } from "react-router-dom";
import { Bell, Briefcase, Gauge, History, LineChart, ListOrdered, Users } from "lucide-react";
import Dashboard from "./pages/Dashboard";
import Rankings from "./pages/Rankings";
import SenatorDetail from "./pages/SenatorDetail";
import TradeHistory from "./pages/TradeHistory";
import BuffettPortfolio from "./pages/BuffettPortfolio";
import FundManagers from "./pages/FundManagers";
import AlertHistory from "./pages/AlertHistory";
import { useRealTime } from "./hooks/useRealTime";

const links = [
  { to: "/", label: "Dashboard", icon: Gauge },
  { to: "/rankings", label: "Rankings", icon: ListOrdered },
  { to: "/trades", label: "Trades", icon: History },
  { to: "/buffett", label: "Buffett", icon: Briefcase },
  { to: "/funds", label: "Funds", icon: Users },
  { to: "/alerts", label: "Alerts", icon: Bell }
];

export default function App() {
  const connected = useRealTime();

  return (
    <div className="min-h-screen bg-[#0f1117] text-ink">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-panel/80 px-4 py-5 lg:block">
        <div className="mb-6 flex items-center gap-3 px-2">
          <LineChart className="h-6 w-6 text-accent" />
          <span className="text-lg font-semibold">Stock Tracker</span>
        </div>
        <nav className="space-y-1">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm ${isActive ? "bg-[#202634] text-white" : "text-muted hover:bg-[#1b202b] hover:text-white"}`
              }
            >
              <Icon className="h-4 w-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-[#0f1117]/95 px-4 py-3 backdrop-blur">
          <div className="flex items-center justify-between">
            <div className="lg:hidden">
              <span className="font-semibold">Stock Tracker</span>
            </div>
            <div className="ml-auto flex items-center gap-2 text-xs text-muted">
              <span className={`h-2 w-2 rounded-full ${connected ? "bg-accent" : "bg-danger"}`} />
              SSE
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/rankings" element={<Rankings />} />
            <Route path="/senators/:id" element={<SenatorDetail />} />
            <Route path="/trades" element={<TradeHistory />} />
            <Route path="/buffett" element={<BuffettPortfolio />} />
            <Route path="/funds" element={<FundManagers />} />
            <Route path="/alerts" element={<AlertHistory />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
