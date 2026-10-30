// Tag merge copy (full-surface wiring #27). The Go handler responds
// {from, into, subscribers_updated} — the legacy client read `merged`,
// which never existed on the wire, so every toast said "0 subscribers".
// These tests pin the honest behavior: predicted counts are labelled
// approximate, result toasts only sum server-confirmed counts, and
// partial failures name the failing tags.

import { describe, expect, it } from "vitest";

import {
  mergePlanCopy,
  mergeResultToastCopy,
} from "../../components/tags/merge-tags-helpers";
import type { TagUsage } from "../../lib/api-client";

const usage = (subs: Record<string, number>): Record<string, TagUsage> => {
  const out: Record<string, TagUsage> = {};
  for (const [tag, subscribers] of Object.entries(subs)) {
    out[tag] = { tag, subscribers, registered: true };
  }
  return out;
};

describe("mergePlanCopy", () => {
  it("sums predicted counts across all sources and says they can drift", () => {
    const plan = mergePlanCopy(
      ["vip", "whale"],
      "premium",
      usage({ vip: 10, whale: 5, premium: 99 }),
    );
    expect(plan.predicted).toBe(15); // never counts the destination
    expect(plan.title).toBe('Merge 2 tags into "premium"?');
    expect(plan.description).toContain("~15 subscribers");
    expect(plan.description).toContain("may drift");
  });

  it("single source gets the simple title", () => {
    const plan = mergePlanCopy(["vip"], "premium", usage({ vip: 1 }));
    expect(plan.title).toBe('Merge "vip" into "premium"?');
    expect(plan.description).toContain("~1 subscriber carry");
  });

  it("without a usage map it admits the count is unknown instead of saying 0", () => {
    const plan = mergePlanCopy(["vip"], "premium", undefined);
    expect(plan.predicted).toBe(0);
    expect(plan.description).toContain("counts are unavailable");
    expect(plan.description).not.toContain("~0");
  });
});

describe("mergeResultToastCopy", () => {
  it("reports the server-confirmed subscribers_updated total", () => {
    const copy = mergeResultToastCopy("premium", [
      { from: "vip", ok: true, subscribersUpdated: 10 },
      { from: "whale", ok: true, subscribersUpdated: 5 },
    ]);
    expect(copy.ok).toBe(true);
    expect(copy.message).toBe('Merged 2 tags into "premium"');
    expect(copy.detail).toBe("15 subscribers updated.");
  });

  it("says when the server omitted the count rather than inventing zero", () => {
    const copy = mergeResultToastCopy("premium", [
      { from: "vip", ok: true, subscribersUpdated: undefined },
    ]);
    expect(copy.ok).toBe(true);
    expect(copy.detail).toContain(
      "server didn't report how many subscribers were updated",
    );
    expect(copy.detail).not.toContain("0 subscribers");
  });

  it("mixed confirmed/unconfirmed counts are reported as a lower bound", () => {
    const copy = mergeResultToastCopy("premium", [
      { from: "vip", ok: true, subscribersUpdated: 10 },
      { from: "whale", ok: true },
    ]);
    expect(copy.detail).toContain("at least 10 subscribers updated");
  });

  it("partial failure names the failing tag and stays an error toast", () => {
    const copy = mergeResultToastCopy("premium", [
      { from: "vip", ok: true, subscribersUpdated: 10 },
      { from: "whale", ok: false, error: "conflict" },
    ]);
    expect(copy.ok).toBe(false);
    expect(copy.message).toBe('Merged 1 of 2 tags into "premium"');
    expect(copy.detail).toContain('"whale" (conflict)');
  });

  it("total failure carries the first server error", () => {
    const copy = mergeResultToastCopy("premium", [
      { from: "vip", ok: false, error: "boom" },
    ]);
    expect(copy.ok).toBe(false);
    expect(copy.message).toBe('Couldn\'t merge "vip"');
    expect(copy.detail).toBe("boom");
  });
});
