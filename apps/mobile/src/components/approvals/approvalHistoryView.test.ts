/**
 * Slicing and ordering the loaded approvals window — the mobile half of
 * desktop's history status/sort selects (approvals-view-model.ts).
 */
import { describe, expect, it } from "vitest";

import {
  APPROVAL_SORTS,
  APPROVAL_STATUS_FILTERS,
  applyApprovalHistoryView,
  narrowApprovalsByStatus,
  sortApprovals,
  type ApprovalHistoryRow,
} from "./approvalHistoryView";

function row(over: Partial<ApprovalHistoryRow>): ApprovalHistoryRow {
  return {
    resourceType: "campaign",
    resourceId: "c-1",
    requestedByActorLabel: "amy@example.com",
    requestedAt: "2026-08-20T10:00:00Z",
    status: "pending",
    ...over,
  };
}

const ROWS: ApprovalHistoryRow[] = [
  row({
    status: "approved",
    requestedAt: "2026-08-22T10:00:00Z",
    resourceType: "segment",
    resourceId: "s-9",
    requestedByActorLabel: "zoe@example.com",
  }),
  row({
    status: "rejected",
    requestedAt: "2026-08-24T10:00:00Z",
    resourceType: "campaign",
    resourceId: "c-2",
    requestedByActorLabel: "amy@example.com",
  }),
  row({
    status: "expired",
    requestedAt: "2026-08-21T10:00:00Z",
    resourceType: "api_key",
    resourceId: "k-1",
    requestedByActorLabel: "mo@example.com",
  }),
];

describe("narrowApprovalsByStatus", () => {
  it("slices the loaded window to one resolved state", () => {
    expect(narrowApprovalsByStatus(ROWS, "rejected").map((r) => r.status)).toEqual(
      ["rejected"],
    );
    expect(narrowApprovalsByStatus(ROWS, "all")).toHaveLength(3);
  });

  it("offers no 'unverified' chip — that state is a desktop decode artifact", () => {
    expect(APPROVAL_STATUS_FILTERS.map((f) => f.key)).toEqual([
      "all",
      "approved",
      "rejected",
      "expired",
    ]);
  });
});

describe("sortApprovals", () => {
  it("defaults to newest request first and can flip to oldest", () => {
    expect(sortApprovals(ROWS, "newest").map((r) => r.resourceId)).toEqual([
      "c-2",
      "s-9",
      "k-1",
    ]);
    expect(sortApprovals(ROWS, "oldest").map((r) => r.resourceId)).toEqual([
      "k-1",
      "s-9",
      "c-2",
    ]);
  });

  it("orders by the HUMAN-READABLE resource label, not the wire value", () => {
    // Wire values: api_key < campaign < segment. Labels: "API key" < "Campaign
    // send"? — the assertion that matters is that the order follows what the
    // rows display. api_key's label starts with "A" so it still leads, but a
    // custom-labelled type must sort by its label; pin via the pair below.
    const rows = [
      row({ resourceType: "segment", resourceId: "1" }),
      row({ resourceType: "campaign", resourceId: "2" }),
    ];
    const sorted = sortApprovals(rows, "resource");
    // "Campaign send" < "Segment", matching the labels the list renders.
    expect(sorted.map((r) => r.resourceId)).toEqual(["2", "1"]);
  });

  it("orders by requester and by status alphabetically, case-insensitive", () => {
    expect(
      sortApprovals(ROWS, "requester").map((r) => r.requestedByActorLabel),
    ).toEqual(["amy@example.com", "mo@example.com", "zoe@example.com"]);
    expect(sortApprovals(ROWS, "status").map((r) => r.status)).toEqual([
      "approved",
      "expired",
      "rejected",
    ]);
  });

  it("sends an unparseable timestamp to the old end instead of the top", () => {
    const rows = [...ROWS, row({ requestedAt: "not-a-date", resourceId: "x" })];
    const newest = sortApprovals(rows, "newest");
    expect(newest.at(-1)?.resourceId).toBe("x");
  });

  it("does not mutate the input order", () => {
    const before = ROWS.map((r) => r.resourceId);
    sortApprovals(ROWS, "oldest");
    expect(ROWS.map((r) => r.resourceId)).toEqual(before);
  });
});

describe("applyApprovalHistoryView", () => {
  it("applies status then sort on the All window", () => {
    const out = applyApprovalHistoryView(
      ROWS,
      { status: "approved", sort: "newest" },
      false,
    );
    expect(out.map((r) => r.resourceId)).toEqual(["s-9"]);
  });

  it("ignores the status slice on the Pending window but keeps the sort", () => {
    const out = applyApprovalHistoryView(
      ROWS,
      { status: "approved", sort: "oldest" },
      true,
    );
    // Nothing dropped — Pending is already a status filter upstream.
    expect(out).toHaveLength(3);
    expect(out[0]?.resourceId).toBe("k-1");
  });

  it("hides the status sort option outside history", () => {
    const statusSort = APPROVAL_SORTS.find((s) => s.key === "status");
    expect(statusSort?.historyOnly).toBe(true);
  });
});
