import type Database from "better-sqlite3";
import type { FundHoldingInput } from "../types.js";

export type HoldingDiff = FundHoldingInput & {
  changeType: "new" | "exit" | "increase" | "decrease" | "unchanged";
  changeShares: number;
  changePct: number | null;
};

export function diffHoldings(previous: FundHoldingInput[], current: FundHoldingInput[]): HoldingDiff[] {
  const previousByCusip = new Map(previous.map((holding) => [holding.cusip, holding]));
  const currentByCusip = new Map(current.map((holding) => [holding.cusip, holding]));
  const diffs: HoldingDiff[] = [];

  for (const holding of current) {
    const old = previousByCusip.get(holding.cusip);
    if (!old) {
      diffs.push({ ...holding, changeType: "new", changeShares: holding.shares, changePct: null });
      continue;
    }

    const changeShares = holding.shares - old.shares;
    const changePct = old.shares === 0 ? null : changeShares / old.shares;
    const changeType = changeShares > 0 ? "increase" : changeShares < 0 ? "decrease" : "unchanged";
    diffs.push({ ...holding, changeType, changeShares, changePct });
  }

  for (const old of previous) {
    if (!currentByCusip.has(old.cusip)) {
      diffs.push({
        ...old,
        shares: 0,
        valueThousands: 0,
        changeType: "exit",
        changeShares: -old.shares,
        changePct: -1
      });
    }
  }

  return diffs;
}

export function previousQuarterHoldings(db: Database.Database, fundCik: string, reportDate: string): FundHoldingInput[] {
  const previousDate = db
    .prepare("SELECT max(report_date) AS report_date FROM fund_holdings WHERE fund_cik = ? AND report_date < ?")
    .get(fundCik, reportDate) as { report_date: string | null };
  if (!previousDate.report_date) return [];

  return db
    .prepare("SELECT * FROM fund_holdings WHERE fund_cik = ? AND report_date = ?")
    .all(fundCik, previousDate.report_date)
    .map((row: any) => ({
      fundName: row.fund_name,
      fundCik: row.fund_cik,
      reportDate: row.report_date,
      filingDate: row.filing_date,
      ticker: row.ticker,
      cusip: row.cusip,
      securityName: row.security_name,
      shares: row.shares,
      valueThousands: row.value_thousands
    }));
}
