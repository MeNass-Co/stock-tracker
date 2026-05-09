import { XMLParser } from "fast-xml-parser";
import { config } from "../config.js";
import type { NormalizedTrade } from "../types.js";
import { normalizeDate, normalizeName } from "../parsing/normalizer.js";
import { BaseSource } from "./base-source.js";
import { logger } from "../utils/logger.js";

const FD_XML_URL = (year: number) => `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`;

interface HouseFiling {
  Prefix?: string;
  Last: string;
  First: string;
  Suffix?: string;
  FilingType: string;
  StateDst: string;
  Year: string | number;
  FilingDate: string;
  DocID: string | number;
}

export interface HouseFilingDetection {
  name: string;
  state: string | null;
  filingDate: string;
  docId: string;
  pdfUrl: string;
}

const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });

export class HouseClerkSource extends BaseSource {
  readonly name = "house-clerk";
  private lastSeenDocIds = new Set<string>();
  private _lastDetections: HouseFilingDetection[] = [];

  get lastDetections() { return this._lastDetections; }

  async healthCheck() {
    return { source: this.name, ok: true, checkedAt: new Date().toISOString() };
  }

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    this._lastDetections = [];
    const year = new Date().getFullYear();
    const filings = await this.fetchFilings(year);

    const ptrFilings = filings.filter((f) => String(f.FilingType).toUpperCase() === "P");
    logger.info({ year, total: filings.length, ptr: ptrFilings.length }, "house-clerk: filings parsed");

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);

    const newFilings: HouseFilingDetection[] = [];
    for (const filing of ptrFilings) {
      const filed = new Date(filing.FilingDate);
      if (Number.isNaN(filed.getTime()) || filed < cutoff) continue;

      const docId = String(filing.DocID);
      if (this.lastSeenDocIds.has(docId)) continue;
      this.lastSeenDocIds.add(docId);

      newFilings.push({
        name: normalizeName(`${filing.First ?? ""} ${filing.Last ?? ""}`.trim()),
        state: String(filing.StateDst ?? "").replace(/\d+/g, "").trim() || null,
        filingDate: normalizeDate(filing.FilingDate),
        docId,
        pdfUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
      });
    }

    this._lastDetections = newFilings;
    if (newFilings.length > 0) {
      logger.info({ count: newFilings.length, names: newFilings.slice(0, 5).map((f) => f.name) }, "house-clerk: new PTR filings detected");
    }

    // Return empty — House Clerk doesn't produce trade-level data.
    // Filing detections are handled separately by the scheduler via lastDetections.
    return [];
  }

  private async fetchFilings(year: number): Promise<HouseFiling[]> {
    const res = await fetch(FD_XML_URL(year), {
      headers: { "User-Agent": config.SEC_USER_AGENT },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, year }, "house-clerk: XML fetch failed");
      return [];
    }

    const xml = await res.text();
    const parsed = parser.parse(xml);
    const members = parsed?.FinancialDisclosure?.Member;
    if (!members) return [];
    return Array.isArray(members) ? members : [members];
  }
}
