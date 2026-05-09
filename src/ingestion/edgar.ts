import { config } from "../config.js";
import { parse13FXML } from "../parsing/13f-parser.js";
import type { FundHoldingInput, FundManager, NormalizedTrade } from "../types.js";
import { RateLimiter } from "../utils/rate-limiter.js";
import { retry } from "../utils/retry.js";
import { TIER_1_FUNDS } from "../tracking/fund-manager-tracker.js";
import { logger } from "../utils/logger.js";
import { BaseSource } from "./base-source.js";

const secLimiter = new RateLimiter(8);

type RecentFiling = {
  accessionNumber: string;
  form: string;
  filingDate: string;
  reportDate: string;
  primaryDocument: string;
};

export class EdgarSource extends BaseSource {
  readonly name = "edgar";

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    // SEC Form 4 filings are general corporate insider reports, not congressional PTR disclosures.
    // Congressional trade ingestion should come from Quiver/Capitol Trades or official PTR sources.
    return [];
  }

  async fetch13FForTier1Funds() {
    const holdings: FundHoldingInput[] = [];
    for (const fund of TIER_1_FUNDS) {
      try {
        const result = await this.fetchLatest13F(fund);
        holdings.push(...result);
        logger.info({ fund: fund.fund, holdings: result.length }, "13F fund parsed");
      } catch (error) {
        logger.error({ fund: fund.fund, cik: fund.cik, err: error instanceof Error ? error.message : String(error) }, "13F fund fetch failed");
      }
    }
    return holdings;
  }

  async fetchLatest13F(fund: FundManager): Promise<FundHoldingInput[]> {
    const submissions = await this.getSubmissions(fund.cik);
    const filing = submissions.find((item) => item.form === "13F-HR");
    if (!filing) return [];
    const accessionNoDashes = filing.accessionNumber.replaceAll("-", "");
    const cikNoLeading = fund.cik.replace(/^0+/, "");
    const xmlUrl = await this.findXmlDocument(cikNoLeading, accessionNoDashes, "13f");
    if (!xmlUrl) return [];
    const xml = await this.fetchText(xmlUrl);
    return parse13FXML(xml, {
      fundName: fund.fund,
      fundCik: fund.cik,
      reportDate: filing.reportDate || filing.filingDate,
      filingDate: filing.filingDate
    });
  }

  private async getSubmissions(cik: string): Promise<RecentFiling[]> {
    const padded = cik.padStart(10, "0");
    const data = (await this.fetchJson(`https://data.sec.gov/submissions/CIK${padded}.json`)) as any;
    const recent = data.filings?.recent;
    if (!recent) return [];

    return recent.accessionNumber.map((accessionNumber: string, index: number) => ({
      accessionNumber,
      form: recent.form[index],
      filingDate: recent.filingDate[index],
      reportDate: recent.reportDate[index],
      primaryDocument: recent.primaryDocument[index]
    }));
  }

  private async findXmlDocument(cikNoLeading: string, accessionNoDashes: string, preferred?: "13f") {
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionNoDashes}/index.json`;
    const index = (await this.fetchJson(indexUrl)) as any;
    const items = index.directory?.item ?? [];
    const xmlItems = items.filter((item: any) => String(item.name).toLowerCase().endsWith(".xml"));

    let chosen;
    if (preferred === "13f") {
      chosen =
        xmlItems.find((item: any) => /infotable|form13f/i.test(item.name)) ??
        xmlItems.find((item: any) => !/primary_doc|xsl|^R\d/i.test(item.name)) ??
        xmlItems[0];
    } else {
      chosen = xmlItems.find((item: any) => !/xsl/i.test(item.name)) ?? xmlItems[0];
    }
    if (!chosen) return null;
    return `https://www.sec.gov/Archives/edgar/data/${cikNoLeading}/${accessionNoDashes}/${chosen.name}`;
  }

  private fetchText(url: string) {
    return retry(() =>
      secLimiter.schedule(async () => {
        const response = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`SEC request failed ${response.status}: ${url}`);
        return response.text();
      })
    );
  }

  private fetchJson(url: string) {
    return retry(() =>
      secLimiter.schedule(async () => {
        const response = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`SEC request failed ${response.status}: ${url}`);
        return response.json();
      })
    );
  }

  private headers() {
    return {
      "User-Agent": config.SEC_USER_AGENT,
      Accept: "application/json,text/xml,application/xml,text/plain"
    };
  }
}
