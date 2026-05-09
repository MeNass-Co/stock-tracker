import { XMLParser } from "fast-xml-parser";
import type { FundHoldingInput } from "../types.js";
import { asArray, toNumber } from "./normalizer.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
});

type Parse13FOptions = {
  fundName: string;
  fundCik: string;
  reportDate: string;
  filingDate: string;
};

export function parse13FXML(xml: string, options: Parse13FOptions): FundHoldingInput[] {
  const document = parser.parse(xml) as Record<string, any>;
  const table =
    document.informationTable ??
    document.XML?.informationTable ??
    document.edgarSubmission?.formData?.informationTable ??
    document;
  const rows = asArray(table.infoTable);

  return rows
    .map((row: any): FundHoldingInput | null => {
      const shares = toNumber(row.shrsOrPrnAmt?.sshPrnamt ?? row.shares);
      const valueThousands = toNumber(row.value);
      const cusip = String(row.cusip ?? "").trim();
      if (!cusip || shares === null || valueThousands === null) return null;
      const putCall = String(row.putCall ?? row.putOrCall ?? "").trim().toUpperCase() || null;

      return {
        fundName: options.fundName,
        fundCik: options.fundCik,
        reportDate: options.reportDate,
        filingDate: options.filingDate,
        ticker: row.ticker ? String(row.ticker).toUpperCase() : null,
        cusip,
        securityName: String(row.nameOfIssuer ?? "Unknown security").trim(),
        shares,
        valueThousands,
        putCall
      };
    })
    .filter((holding): holding is FundHoldingInput => holding !== null);
}
