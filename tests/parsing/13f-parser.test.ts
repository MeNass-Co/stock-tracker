import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse13FXML } from "../../src/parsing/13f-parser.js";

describe("parse13FXML", () => {
  it("normalizes information table rows", () => {
    const xml = readFileSync("tests/fixtures/13f.xml", "utf8");
    const holdings = parse13FXML(xml, {
      fundName: "Berkshire Hathaway",
      fundCik: "0001067983",
      reportDate: "2026-03-31",
      filingDate: "2026-05-15"
    });
    expect(holdings).toHaveLength(1);
    expect(holdings[0]).toMatchObject({
      cusip: "037833100",
      securityName: "APPLE INC",
      shares: 5000,
      valueThousands: 1000
    });
  });
});
