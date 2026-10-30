import { describe, expect, it } from "vitest";

import {
  WORKSPACE_DATE_FORMATS,
  WORKSPACE_DATE_FORMAT_DEFAULT,
  WORKSPACE_DATE_FORMAT_REJECTED,
  isAllowedWorkspaceDateFormat,
  workspaceDateFormatExample,
  workspaceDateFormatLabel,
  workspaceDateFormatPatch,
  workspaceDateFormatSummary,
} from "./workspaceDateFormat";

/**
 * The keys of `allowedDateFormats` in apps/api/internal/settings/workspace.go.
 * Written out here so a change on either side has to be made deliberately on
 * both — the point of the option list is that it matches the server's set.
 */
const SERVER_ALLOWED = [
  "YYYY-MM-DD",
  "MMM D, YYYY",
  "D MMM YYYY",
  "MM/DD/YYYY",
];

describe("WORKSPACE_DATE_FORMATS", () => {
  it("offers exactly the set the handler accepts", () => {
    expect([...WORKSPACE_DATE_FORMATS.map((o) => o.value)].sort()).toEqual(
      [...SERVER_ALLOWED].sort(),
    );
  });

  it("keeps desktop's labels so the two clients name the same option alike", () => {
    expect(WORKSPACE_DATE_FORMATS.map((o) => o.label)).toEqual([
      "May 3, 2026 (MMM D, YYYY)",
      "3 May 2026 (D MMM YYYY)",
      "2026-05-03 (YYYY-MM-DD)",
      "05/03/2026 (MM/DD/YYYY)",
    ]);
  });

  it("defaults to the value the server writes when the column is unset", () => {
    expect(SERVER_ALLOWED).toContain(WORKSPACE_DATE_FORMAT_DEFAULT);
    expect(WORKSPACE_DATE_FORMAT_DEFAULT).toBe("MMM D, YYYY");
  });
});

describe("isAllowedWorkspaceDateFormat", () => {
  it("accepts each allowed value, trimmed", () => {
    for (const value of SERVER_ALLOWED) {
      expect(isAllowedWorkspaceDateFormat(value)).toBe(true);
      expect(isAllowedWorkspaceDateFormat(` ${value} `)).toBe(true);
    }
  });

  it("refuses anything else, including near-misses", () => {
    expect(isAllowedWorkspaceDateFormat("")).toBe(false);
    expect(isAllowedWorkspaceDateFormat("DD/MM/YYYY")).toBe(false);
    expect(isAllowedWorkspaceDateFormat("MMM D YYYY")).toBe(false);
    expect(isAllowedWorkspaceDateFormat("yyyy-mm-dd")).toBe(false);
  });
});

describe("label and example lookup", () => {
  it("answers for a known value and null for an unknown one", () => {
    expect(workspaceDateFormatLabel("YYYY-MM-DD")).toBe(
      "2026-05-03 (YYYY-MM-DD)",
    );
    expect(workspaceDateFormatExample("MM/DD/YYYY")).toBe("05/03/2026");
    expect(workspaceDateFormatLabel("DD.MM.YYYY")).toBeNull();
    expect(workspaceDateFormatExample("")).toBeNull();
  });
});

describe("workspaceDateFormatSummary", () => {
  it("reads the chosen format as a rendered date", () => {
    expect(workspaceDateFormatSummary("D MMM YYYY")).toBe(
      "Dates render as 3 May 2026.",
    );
  });

  it("says UNSET rather than pretending the default was chosen", () => {
    expect(workspaceDateFormatSummary("")).toBe(
      "Not set — dates render as May 3, 2026 until you choose one.",
    );
  });

  it("does not hide a stored value this client does not recognise", () => {
    expect(workspaceDateFormatSummary("DD.MM.YYYY")).toBe(
      'This workspace stores "DD.MM.YYYY", which this version of Moosewave does not recognise.',
    );
  });
});

describe("workspaceDateFormatPatch", () => {
  it("sends nothing when the choice is the saved one", () => {
    expect(workspaceDateFormatPatch("MMM D, YYYY", "MMM D, YYYY")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("sends the chosen value when it changed", () => {
    expect(workspaceDateFormatPatch("MMM D, YYYY", "YYYY-MM-DD")).toEqual({
      ok: true,
      value: "YYYY-MM-DD",
    });
  });

  it("treats a blank choice as 'leave the column alone', like the handler does", () => {
    expect(workspaceDateFormatPatch("MMM D, YYYY", "")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("refuses an unknown format locally, in the handler's own sentence", () => {
    expect(workspaceDateFormatPatch("MMM D, YYYY", "DD/MM/YYYY")).toEqual({
      ok: false,
      message: WORKSPACE_DATE_FORMAT_REJECTED,
    });
    expect(WORKSPACE_DATE_FORMAT_REJECTED).toBe(
      "date_format must be one of YYYY-MM-DD, MMM D, YYYY, D MMM YYYY, MM/DD/YYYY",
    );
  });

  it("changes to a value the server stored but this client cannot name are still refused", () => {
    expect(workspaceDateFormatPatch("DD.MM.YYYY", "DD.MM.YYYY")).toEqual({
      ok: false,
      message: WORKSPACE_DATE_FORMAT_REJECTED,
    });
  });
});
