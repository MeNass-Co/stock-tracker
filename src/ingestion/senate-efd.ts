import * as cheerio from "cheerio";
import { config } from "../config.js";
import type { NormalizedTrade } from "../types.js";
import { directionFromTransaction, midpointForRange, normalizeDate, normalizeName, normalizeTicker } from "../parsing/normalizer.js";
import { BaseSource } from "./base-source.js";
import { logger } from "../utils/logger.js";

const BASE = "https://efdsearch.senate.gov";
const SEARCH_PAGE = `${BASE}/search/`;
const REPORT_API = `${BASE}/search/report/data/`;

export class SenateEfdSource extends BaseSource {
  readonly name = "senate-efd";
  private csrfToken = "";
  private cookies = "";

  async fetchNewTrades(): Promise<NormalizedTrade[]> {
    // Disabled: efd.senate.gov is behind Akamai bot protection (403).
    // Senate trades are already covered by Quiver congressional trading endpoint.
    return [];
  }

  private async initSession(): Promise<void> {
    const res = await fetch(SEARCH_PAGE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      logger.warn({ status: res.status, server: res.headers.get("server") }, "senate-efd: search page blocked (likely Akamai/CDN bot protection)");
      return;
    }

    // Method 1: getSetCookie() (Node 20+)
    const setCookies = (res.headers as any).getSetCookie?.() as string[] | undefined;
    if (setCookies) {
      for (const c of setCookies) {
        const m = c.match(/csrftoken=([^;]+)/);
        if (m) { this.csrfToken = m[1]; this.cookies = `csrftoken=${m[1]}`; return; }
      }
    }

    // Method 2: single set-cookie header
    const raw = res.headers.get("set-cookie") ?? "";
    const match = raw.match(/csrftoken=([^;]+)/);
    if (match) {
      this.csrfToken = match[1];
      this.cookies = `csrftoken=${match[1]}`;
      return;
    }

    // Method 3: extract from HTML body (Django csrfmiddlewaretoken hidden input)
    const html = await res.text();
    const $ = cheerio.load(html);
    const tokenInput = $("input[name='csrfmiddlewaretoken']").val();
    if (typeof tokenInput === "string" && tokenInput) {
      this.csrfToken = tokenInput;
      this.cookies = `csrftoken=${tokenInput}`;
      return;
    }

    // Method 4: extract from meta tag
    const metaToken = $("meta[name='csrf-token']").attr("content") ?? $("meta[name='csrftoken']").attr("content");
    if (metaToken) {
      this.csrfToken = metaToken;
      this.cookies = `csrftoken=${metaToken}`;
    }
  }

  private fmtDate(d: Date) {
    return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  }

  private async searchPTR(start: Date, end: Date) {
    const body = new URLSearchParams({
      report_type: "11",
      filer_type: "1",
      submitted_start_date: this.fmtDate(start),
      submitted_end_date: this.fmtDate(end),
    });

    const res = await fetch(REPORT_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": this.csrfToken,
        Cookie: this.cookies,
        Referer: SEARCH_PAGE,
        "User-Agent": config.SEC_USER_AGENT,
      },
      body: body.toString(),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "senate-efd: search request failed");
      return [];
    }

    const json = (await res.json()) as { data?: string[][] };
    if (!json.data) return [];

    return json.data.map((row) => {
      const $ = cheerio.load(row[0] ?? "");
      const link = $("a").first();
      const href = link.attr("href") ?? "";
      return {
        name: link.text().trim(),
        url: href.startsWith("/") ? `${BASE}${href}` : href,
        filingDate: (row[2] ?? "").trim(),
      };
    }).filter((r) => r.url && r.name);
  }

  private async parseReport(report: { name: string; url: string; filingDate: string }): Promise<NormalizedTrade[]> {
    const res = await fetch(report.url, {
      headers: { Cookie: this.cookies, "User-Agent": config.SEC_USER_AGENT },
    });
    if (!res.ok) return [];

    const $ = cheerio.load(await res.text());
    const trades: NormalizedTrade[] = [];

    $("table.table tbody tr, table tbody tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 6) return;

      const txDate = $(cells.get(1)).text().trim();
      const owner = $(cells.get(2)).text().trim();
      const ticker = $(cells.get(3)).text().trim().replace(/\s*\[.*?\]\s*/g, "");
      const assetName = $(cells.get(4)).text().trim();
      const assetType = $(cells.get(5)).text().trim();
      const txType = $(cells.get(6)).text().trim();
      const amount = $(cells.get(7)).text().trim();

      if (!txDate || txDate === "--") return;
      const normalizedTicker = normalizeTicker(ticker);
      if (!normalizedTicker && !assetName) return;

      const amountRange = amount || null;

      trades.push({
        politician: { name: normalizeName(report.name), chamber: "senate" },
        ticker: normalizedTicker,
        assetName: assetName || ticker || "Unknown",
        tradeDate: normalizeDate(txDate),
        filingDate: normalizeDate(report.filingDate),
        detectedAt: new Date().toISOString(),
        direction: directionFromTransaction(txType),
        amountRange,
        amountMidpoint: midpointForRange(amountRange),
        assetType: assetType.toLowerCase().includes("stock") ? "stock" : assetType.toLowerCase() || "stock",
        source: "senate-efd",
        sourceId: `efd-${report.name.replace(/\s/g, "-")}-${normalizedTicker ?? "none"}-${txDate}`,
        rawData: { url: report.url, owner },
      });
    });

    return trades;
  }
}
