/**
 * The applied-view export must (1) send exactly the view's filters, (2) never
 * present a slice as the audience, and (3) neutralise spreadsheet formulas in
 * attacker-writable cells. Each is pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  subscriberExportBlockedReason,
  subscriberExportCsv,
  subscriberExportNotice,
  subscriberExportScope,
  subscribersExportPath,
  SUBSCRIBER_EXPORT_MAX_ROWS,
} from "./subscriberExport";

describe("subscribersExportPath", () => {
  it("carries the applied query, status, sort, and archive scope", () => {
    const path = subscribersExportPath({
      query: " acme corp ",
      engineStatus: "blocklisted",
      sort: "engagement",
      order: "desc",
      includeArchived: true,
    });
    const url = new URL(`https://x${path}`);
    expect(url.pathname).toBe("/api/v1/subscribers/export.csv");
    expect(url.searchParams.get("q")).toBe("acme corp");
    expect(url.searchParams.get("status")).toBe("blocklisted");
    expect(url.searchParams.get("sort")).toBe("engagement");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("include_archived")).toBe("true");
    expect(url.searchParams.get("limit")).toBe(
      String(SUBSCRIBER_EXPORT_MAX_ROWS),
    );
  });

  it("omits the filters the view does not apply", () => {
    const path = subscribersExportPath({
      query: "",
      engineStatus: undefined,
      sort: "updated_at",
      order: "desc",
      includeArchived: false,
    });
    const url = new URL(`https://x${path}`);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("status")).toBe(false);
    expect(url.searchParams.has("include_archived")).toBe(false);
  });
});

describe("subscriberExportBlockedReason", () => {
  it("refuses gated, offline, and still-settling views in that order", () => {
    expect(
      subscriberExportBlockedReason({
        draftQuery: "a",
        settledQuery: "a",
        loading: false,
        gated: true,
        online: false,
      }),
    ).toMatch(/Reconnect/);
    expect(
      subscriberExportBlockedReason({
        draftQuery: "a",
        settledQuery: "a",
        loading: false,
        gated: false,
        online: false,
      }),
    ).toMatch(/offline/);
    expect(
      subscriberExportBlockedReason({
        draftQuery: "ac",
        settledQuery: "a",
        loading: false,
        gated: false,
        online: true,
      }),
    ).toMatch(/finish updating/);
    expect(
      subscriberExportBlockedReason({
        draftQuery: "a",
        settledQuery: "a",
        loading: false,
        gated: false,
        online: true,
      }),
    ).toBeNull();
  });
});

const HEADER =
  "email,name,status,tags,custom_fields_json,merge_fields_json,engagement_score,rating,churn_score,created_at";

function serverCsv(rows: string[]): string {
  return [HEADER, ...rows].join("\r\n");
}

describe("subscriberExportCsv", () => {
  it("re-emits the server rows injection-safe", () => {
    const out = subscriberExportCsv(
      serverCsv(['=cmd()|x,"+SUM(A1)",enabled,,,,,,,2026-01-01']),
      { scope: "all subscribers" },
    );
    expect(out.included).toBe(1);
    const dataLine = out.body.split("\n")[1] ?? "";
    // Leading formula characters must be neutralised, not forwarded.
    expect(dataLine.startsWith("=")).toBe(false);
    expect(dataLine).not.toMatch(/(^|,)=/);
    expect(dataLine).not.toMatch(/(^|,)\+SUM/);
  });

  it("treats a response that exactly fills the cap as truncated", () => {
    const rows = Array.from({ length: 3 }, (_, i) => `a${i}@x.com,,enabled`);
    const out = subscriberExportCsv(serverCsv(rows), {
      scope: "all subscribers",
      cap: 3,
    });
    expect(out.included).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.title).toMatch(/first 3/);
  });

  it("uses the view's own total to admit the export is partial", () => {
    const out = subscriberExportCsv(serverCsv(["a@x.com,,enabled"]), {
      scope: "matching “acme”",
      serverTotal: 40,
      cap: 500,
    });
    expect(out.truncated).toBe(true);
    expect(out.title).toContain("first 1 of 40");
  });

  it("reports a complete set as complete", () => {
    const out = subscriberExportCsv(serverCsv(["a@x.com,,enabled"]), {
      scope: "all subscribers",
      serverTotal: 1,
    });
    expect(out.truncated).toBe(false);
    expect(subscriberExportNotice(out)).toMatch(/complete matching set/);
  });

  it("says out loud when there is nothing to export", () => {
    const out = subscriberExportCsv(serverCsv([]), { scope: "x" });
    expect(out.included).toBe(0);
    expect(subscriberExportNotice(out)).toMatch(/nothing to export/);
  });
});

describe("subscriberExportScope", () => {
  it("names every axis the view applied", () => {
    expect(
      subscriberExportScope({
        query: "acme",
        statusNoun: "unsubscribed subscribers",
        includeArchived: true,
      }),
    ).toBe("matching “acme” · unsubscribed subscribers · including archived");
  });
});
