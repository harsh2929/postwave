// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for pluralization helpers (node env).

import { describe, it, expect } from "vitest";

import { blockerWarningLabel, pluralize, pluralizeCount } from "@/lib/pluralize";

describe("pluralize", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralize(1, "blocker")).toBe("1 blocker");
  });
  it("uses the plural for zero and many", () => {
    expect(pluralize(0, "blocker")).toBe("0 blockers");
    expect(pluralize(2, "blocker")).toBe("2 blockers");
  });
  it("accepts an irregular plural", () => {
    expect(pluralize(1, "entry", "entries")).toBe("1 entry");
    expect(pluralize(3, "entry", "entries")).toBe("3 entries");
  });
});

// The count phrases the product shows people. "Deleted 1 contacts." and
// "1 rows" were shipped copy; a count of one is the one an operator is most
// likely to be looking at.
describe("pluralizeCount", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralizeCount(1, "contact")).toBe("1 contact");
    expect(pluralizeCount(1, "row")).toBe("1 row");
  });
  it("uses the plural for zero and many", () => {
    expect(pluralizeCount(0, "contact")).toBe("0 contacts");
    expect(pluralizeCount(2, "contact")).toBe("2 contacts");
  });
  it("groups the digits, which a five-figure audience needs", () => {
    expect(pluralizeCount(1200, "contact")).toBe("1,200 contacts");
    expect(pluralizeCount(48000, "row")).toBe("48,000 rows");
  });
  it("accepts an irregular plural", () => {
    expect(pluralizeCount(1, "batch", "batches")).toBe("1 batch");
    expect(pluralizeCount(3, "batch", "batches")).toBe("3 batches");
  });
  it("keeps a multi-word noun intact", () => {
    expect(pluralizeCount(1, "failed row")).toBe("1 failed row");
    expect(pluralizeCount(4, "failed row")).toBe("4 failed rows");
  });
});

describe("blockerWarningLabel", () => {
  it("pluralizes both counts correctly", () => {
    expect(blockerWarningLabel(1, 1)).toBe("1 blocker, 1 warning");
    expect(blockerWarningLabel(13, 0)).toBe("13 blockers, 0 warnings");
    expect(blockerWarningLabel(0, 2)).toBe("0 blockers, 2 warnings");
  });
});
