import { describe, expect, it } from "vitest";

import { dsarTotals } from "../../components/privacy/portal-dashboard-helpers";
import type { PrivacyPortalSummary } from "../../lib/api-client";

type DsarRow = PrivacyPortalSummary["dsar_requests"][number];

describe("dsarTotals", () => {
  it("returns all-zero totals for undefined input (partial 200 body)", () => {
    // Regression: the live portal white-screened with
    // "Cannot read properties of undefined (reading 'reduce')" when the
    // summary endpoint returned a 200 whose body omitted dsar_requests.
    expect(dsarTotals(undefined)).toEqual({ open: 0, overdue: 0, closed: 0 });
  });

  it("returns all-zero totals for an empty array", () => {
    expect(dsarTotals([])).toEqual({ open: 0, overdue: 0, closed: 0 });
  });

  it("sums across request types", () => {
    const rows: DsarRow[] = [
      { request_type: "access", open: 2, overdue: 1, closed: 5 },
      { request_type: "deletion", open: 3, overdue: 0, closed: 4 },
    ];
    expect(dsarTotals(rows)).toEqual({ open: 5, overdue: 1, closed: 9 });
  });

  it("treats missing per-row numeric fields as 0 (never NaN)", () => {
    // A row with omitted counts must not poison the totals with NaN.
    const rows = [
      { request_type: "access" } as unknown as DsarRow,
      { request_type: "deletion", open: 4 } as unknown as DsarRow,
    ];
    const totals = dsarTotals(rows);
    expect(totals).toEqual({ open: 4, overdue: 0, closed: 0 });
    expect(Number.isNaN(totals.open)).toBe(false);
    expect(Number.isNaN(totals.overdue)).toBe(false);
    expect(Number.isNaN(totals.closed)).toBe(false);
  });
});
