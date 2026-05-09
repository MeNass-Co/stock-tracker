import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseForm4Xml } from "../../src/parsing/form4-parser.js";

describe("parseForm4Xml", () => {
  it("normalizes Form 4 transactions", () => {
    const xml = readFileSync("tests/fixtures/form4.xml", "utf8");
    const trades = parseForm4Xml(xml, { sourceId: "fixture", filingDate: "2026-04-02" });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      ticker: "EXM",
      direction: "buy",
      amountMidpoint: 5000,
      tradeDate: "2026-04-01",
      filingDate: "2026-04-02"
    });
  });
});
