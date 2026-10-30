import { describe, expect, it } from "vitest";

import {
  FORM_EXPORT_MAX_ROWS,
  formSubmissionsCsvShare,
  formSubmissionsExportNotice,
} from "./formSubmissionsExport";

// The exact header the server writes (handlers.go:372), plus rows.
const SERVER_CSV = [
  "id,email,status,submitted_at,confirmed_at,ip,user_agent,custom_fields_json",
  'sub-1,ada@example.com,confirmed,2026-08-01T10:00:00Z,2026-08-01T10:05:00Z,203.0.113.9,"Mozilla/5.0",{}',
  'sub-2,+lead@example.com,pending,2026-08-02T11:00:00Z,,198.51.100.4,"Mozilla/5.0","{""plan"":""pro""}"',
].join("\n");

describe("formSubmissionsCsvShare", () => {
  it("keeps the five identity columns and drops ip/user_agent/custom fields", () => {
    const out = formSubmissionsCsvShare(SERVER_CSV, { formName: "Spring popup" });
    const lines = out.body.split("\n");
    expect(lines[0]).toBe("id,email,status,submitted_at,confirmed_at");
    expect(out.body).not.toContain("203.0.113.9");
    expect(out.body).not.toContain("Mozilla");
    expect(out.included).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it("neutralises a formula-leading email instead of forwarding it", () => {
    // `+lead@…` is a legitimate local part AND an executable prefix in
    // Excel/Sheets. The server does not neutralise it; we must.
    const out = formSubmissionsCsvShare(SERVER_CSV, { formName: "F" });
    expect(out.body).toContain("'+lead@example.com");
  });

  it("caps the rows and says so in the title", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) => `sub-${i},u${i}@example.com,pending,2026-08-01T10:00:00Z,`,
    );
    const out = formSubmissionsCsvShare(
      [
        "id,email,status,submitted_at,confirmed_at,ip,user_agent,custom_fields_json",
        ...rows,
      ].join("\n"),
      { formName: "Busy", cap: 5 },
    );
    expect(out.included).toBe(5);
    expect(out.truncated).toBe(true);
    expect(out.title).toBe("Busy submissions — newest 5");
  });

  it("treats an at-the-cap response as truncated — it may be a slice", () => {
    const rows = Array.from(
      { length: 3 },
      (_, i) => `sub-${i},u${i}@example.com,pending,2026-08-01T10:00:00Z,`,
    );
    const out = formSubmissionsCsvShare(rows.join("\n"), {
      formName: "F",
      cap: 3,
    });
    expect(out.truncated).toBe(true);
  });

  it("survives a headerless body and an empty body", () => {
    const headerless = formSubmissionsCsvShare(
      "sub-1,a@example.com,pending,2026-08-01T10:00:00Z,",
      { formName: "F" },
    );
    expect(headerless.included).toBe(1);
    const empty = formSubmissionsCsvShare("", { formName: "F" });
    expect(empty.included).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it("keeps the default cap at a share-sheet-safe size", () => {
    expect(FORM_EXPORT_MAX_ROWS).toBe(500);
  });
});

describe("formSubmissionsExportNotice", () => {
  it("says nothing was exported when the form is empty", () => {
    expect(
      formSubmissionsExportNotice({
        body: "",
        title: "",
        included: 0,
        truncated: false,
      }),
    ).toBe("This form has no submissions to export.");
  });

  it("admits truncation instead of implying completeness", () => {
    expect(
      formSubmissionsExportNotice({
        body: "",
        title: "",
        included: 500,
        truncated: true,
      }),
    ).toContain("full file needs the web export");
    expect(
      formSubmissionsExportNotice({
        body: "",
        title: "",
        included: 1,
        truncated: false,
      }),
    ).toBe("Shared 1 submission.");
  });
});

describe("columns are resolved by header name, never by position", () => {
  it("survives the server reordering columns without leaking ip or user_agent", () => {
    // Same data as SERVER_CSV, but the server has moved the sensitive columns
    // to the FRONT. A positional reader would ship the IP under "id".
    const reordered = [
      "ip,user_agent,custom_fields,id,email,status,submitted_at,confirmed_at",
      '203.0.113.9,"Mozilla/5.0",{},s1,ana@example.com,confirmed,2026-07-01T00:00:00Z,2026-07-01T00:01:00Z',
    ].join("\n");
    const out = formSubmissionsCsvShare(reordered, { formName: "F" });
    const [head, first] = out.body.split("\n");
    expect(head).toBe("id,email,status,submitted_at,confirmed_at");
    expect(first).toBe("s1,ana@example.com,confirmed,2026-07-01T00:00:00Z,2026-07-01T00:01:00Z");
    expect(out.body).not.toContain("203.0.113.9");
    expect(out.body).not.toContain("Mozilla");
  });

  it("ships a kept column empty when the header lacks it, rather than a neighbour's value", () => {
    const missing = ["id,email,status,submitted_at", "s1,ana@example.com,pending,2026-07-01T00:00:00Z"].join("\n");
    const out = formSubmissionsCsvShare(missing, { formName: "F" });
    expect(out.body.split("\n")[1]).toBe("s1,ana@example.com,pending,2026-07-01T00:00:00Z,");
  });
});
