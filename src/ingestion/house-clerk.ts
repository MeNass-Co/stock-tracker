import { XMLParser } from "fast-xml-parser";
import type Database from "better-sqlite3";
import { config } from "../config.js";
import type { NormalizedTrade, SourceHealth } from "../types.js";
import { loadSeenHouseDocIds, markHouseDocsSeen } from "../db/queries.js";
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
  /** In-memory mirror of house_seen_docs; DB-backed so restarts don't re-alert. */
  private lastSeenDocIds = new Set<string>();
  private seenLoaded = false;
  private _lastDetections: HouseFilingDetection[] = [];

  constructor(private readonly db?: Database.Database) {
    super();
  }

  get lastDetections() { return this._lastDetections; }

  /** Honest health check: verifies the Clerk's FD index is actually reachable. */
  async healthCheck(): Promise<SourceHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(FD_XML_URL(new Date().getFullYear()), {
        method: "HEAD",
        headers: { "User-Agent": config.SEC_USER_AGENT }
      });
      await res.body?.cancel().catch(() => {});
      return { source: this.name, ok: res.ok, checkedAt, message: res.ok ? null : `HTTP ${res.status}` };
    } catch (error) {
      return { source: this.name, ok: false, checkedAt, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Mark filings as processed AFTER downstream handling succeeded. Marking on
   * detection meant a failure later in the job (verified: the Quiver-bridge
   * 500) permanently swallowed the filings.
   */
  markProcessed(docIds: string[]) {
    if (docIds.length === 0) return;
    for (const docId of docIds) this.lastSeenDocIds.add(docId);
    if (this.db) markHouseDocsSeen(this.db, docIds);
  }

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    this._lastDetections = [];
    if (!this.seenLoaded && this.db) {
      for (const docId of loadSeenHouseDocIds(this.db)) this.lastSeenDocIds.add(docId);
      this.seenLoaded = true;
    }
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
      // Deliberately NOT marked seen here — the scheduler calls markProcessed()
      // once the whole downstream job succeeded.

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
