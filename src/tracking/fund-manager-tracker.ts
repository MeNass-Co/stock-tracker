import type { FundManager } from "../types.js";

export const FUND_MANAGERS: FundManager[] = [
  { manager: "Warren Buffett", fund: "Berkshire Hathaway", cik: "0001067983", tier: 1, style: "Deep value", concentration: "Tres haute" },
  { manager: "Bill Ackman", fund: "Pershing Square", cik: "0001336528", tier: 1, style: "Activist", concentration: "Tres haute" },
  { manager: "Stanley Druckenmiller", fund: "Duquesne Family", cik: "0001536411", tier: 1, style: "Macro + growth", concentration: "Haute" },
  { manager: "David Tepper", fund: "Appaloosa", cik: "0001656456", tier: 1, style: "Distressed", concentration: "Haute" },
  { manager: "David Einhorn", fund: "Greenlight Capital", cik: "0001079114", tier: 1, style: "Value", concentration: "Haute" },
  { manager: "Seth Klarman", fund: "Baupost Group", cik: "0001061768", tier: 1, style: "Deep value", concentration: "Moyenne" },
  { manager: "Dan Loeb", fund: "Third Point", cik: "0001040273", tier: 2, style: "Event-driven", concentration: "Moyenne-haute" },
  { manager: "Carl Icahn", fund: "Icahn Enterprises", cik: "0000049588", tier: 2, style: "Activist", concentration: "Haute" },
  { manager: "Michael Burry", fund: "Scion Asset", cik: "0001649339", tier: 3, style: "Contrarian", concentration: "Haute" },
  { manager: "Chase Coleman", fund: "Tiger Global", cik: "0001167483", tier: 3, style: "Tech/growth", concentration: "Basse" },
  { manager: "Ray Dalio", fund: "Bridgewater", cik: "0001350694", tier: 3, style: "Macro", concentration: "Tres basse" }
];

export const TIER_1_FUNDS = FUND_MANAGERS.filter((fund) => fund.tier === 1);
