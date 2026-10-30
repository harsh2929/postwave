// List inbox-reality tab copy (full-surface wiring #46). Wire rows are
// per-seed-test placement results; the honesty invariants: pending
// tests show "—" rather than a fake 0%, and the seed split labels any
// seeds that haven't reported instead of hiding them.

import { describe, expect, it } from "vitest";

import {
  inboxPctLabel,
  seedSplitLabel,
  statusBadgeClass,
} from "../../components/lists/tabs/inbox-reality-copy";
import type { ListInboxRealityRow } from "../../lib/api-client";

function rowOf(over: Partial<ListInboxRealityRow>): ListInboxRealityRow {
  return {
    test_id: "t-1",
    created_at: "2026-06-10T00:00:00Z",
    status: "completed",
    total_seeds: 20,
    inbox: 17,
    spam: 2,
    missing: 1,
    inbox_pct: 85,
    ...over,
  };
}

describe("inboxPctLabel", () => {
  it("renders the reported percentage for a completed test", () => {
    expect(inboxPctLabel(rowOf({}))).toBe("85%");
    expect(inboxPctLabel(rowOf({ inbox_pct: 92.4 }))).toBe("92%");
  });

  it("shows — when no seeds have reported (pending test), never 0%", () => {
    expect(
      inboxPctLabel(
        rowOf({ status: "pending", inbox: 0, spam: 0, missing: 0, inbox_pct: 0 }),
      ),
    ).toBe("—");
  });

  it("shows — when the test has no seeds at all", () => {
    expect(
      inboxPctLabel(rowOf({ total_seeds: 0, inbox: 0, spam: 0, missing: 0 })),
    ).toBe("—");
  });

  it("guards a non-finite percentage from the wire", () => {
    expect(inboxPctLabel(rowOf({ inbox_pct: Number.NaN }))).toBe("—");
  });
});

describe("seedSplitLabel", () => {
  it("sums exactly what the server reported", () => {
    expect(seedSplitLabel(rowOf({}))).toBe(
      "17 inbox · 2 spam · 1 missing (20 seeds)",
    );
  });

  it("labels seeds that haven't reported yet instead of hiding them", () => {
    expect(
      seedSplitLabel(rowOf({ inbox: 10, spam: 1, missing: 0, total_seeds: 20 })),
    ).toBe("10 inbox · 1 spam · 0 missing · 9 not yet reported (20 seeds)");
  });

  it("zero-seed tests say so", () => {
    expect(seedSplitLabel(rowOf({ total_seeds: 0 }))).toBe("No seeds reported");
  });
});

describe("statusBadgeClass", () => {
  it("maps completed/failed/pending to the app badge palette", () => {
    expect(statusBadgeClass("completed")).toBe("badge success");
    expect(statusBadgeClass("FAILED")).toBe("badge danger");
    expect(statusBadgeClass("pending")).toBe("badge");
    expect(statusBadgeClass("running")).toBe("badge");
  });
});
