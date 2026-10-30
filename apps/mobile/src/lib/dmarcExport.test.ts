import { describe, expect, it } from "vitest";

import {
  csvField,
  dmarcCsv,
  DMARC_EXPORT_MAX_ROWS,
  type DmarcExportRow,
} from "./dmarcExport";

function row(over: Partial<DmarcExportRow> = {}): DmarcExportRow {
  return {
    domain: "mail.example.com",
    orgName: "google.com",
    passCount: 120,
    failCount: 3,
    dateBegin: "2026-07-01T00:00:00Z",
    dateEnd: "2026-07-02T00:00:00Z",
    receivedAt: "2026-07-02T06:11:00Z",
    policyP: "quarantine",
    id: "abc-123",
    ...over,
  };
}

describe("csvField", () => {
  it("quotes and doubles embedded quotes (RFC4180)", () => {
    expect(csvField("Yahoo!, Inc.")).toBe('"Yahoo!, Inc."');
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField("line\nbreak")).toBe('"line\nbreak"');
  });

  it("neutralises formula injection BEFORE quoting", () => {
    // A reporter name is attacker-adjacent free text. Excel and Sheets execute
    // a leading =/+/-/@ when the share text is pasted, so the apostrophe must
    // land INSIDE the field, not outside the quotes.
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    // …and when the payload ALSO needs quoting, the apostrophe stays inside.
    expect(csvField("=SUM(A1,A2)")).toBe('"\'=SUM(A1,A2)"');
    expect(csvField("+1234")).toBe("'+1234");
    expect(csvField("@here")).toBe("'@here");
    expect(csvField("-5")).toBe("'-5");
  });

  it("renders numbers without quoting and empties non-finite ones", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField(Number.NaN)).toBe("");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });
});

describe("dmarcCsv", () => {
  it("writes a header plus one line per report", () => {
    const out = dmarcCsv([row(), row({ domain: "b.example.com" })], {
      windowLabel: "30 days",
      domain: "",
    });
    const lines = out.body.split("\n");
    expect(lines[0]).toBe(
      "domain,reporter,pass,fail,period_start,period_end,received_at,policy,report_id",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("mail.example.com,google.com,120,3");
    expect(out.included).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("names the scope and the window in the share title", () => {
    const all = dmarcCsv([row()], { windowLabel: "7 days", domain: "" });
    expect(all.title).toBe("DMARC reports — all domains, last 7 days (1)");
    const one = dmarcCsv([row()], {
      windowLabel: "7 days",
      domain: "mail.example.com",
    });
    expect(one.title).toContain("mail.example.com");
  });

  it("caps the payload and SAYS it capped — a partial export must not pass as whole", () => {
    const many = Array.from({ length: DMARC_EXPORT_MAX_ROWS + 25 }, () =>
      row(),
    );
    const out = dmarcCsv(many, { windowLabel: "90 days", domain: "" });
    expect(out.included).toBe(DMARC_EXPORT_MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.title).toContain(
      `first ${DMARC_EXPORT_MAX_ROWS} of ${many.length}`,
    );
    expect(out.body.split("\n")).toHaveLength(DMARC_EXPORT_MAX_ROWS + 1);
  });

  it("keeps a comma in a reporter name from shifting every later column", () => {
    const out = dmarcCsv([row({ orgName: "Yahoo!, Inc." })], {
      windowLabel: "30 days",
      domain: "",
    });
    const line = out.body.split("\n")[1] ?? "";
    expect(line).toContain('"Yahoo!, Inc."');
    // Nine columns, and the quoted comma is not one of the separators.
    expect(line.split('"')[2]?.split(",").filter(Boolean)).toHaveLength(7);
  });

  it("emits an empty body-with-header rather than throwing on no rows", () => {
    const out = dmarcCsv([], { windowLabel: "30 days", domain: "" });
    expect(out.included).toBe(0);
    expect(out.body.split("\n")).toHaveLength(1);
  });
});
