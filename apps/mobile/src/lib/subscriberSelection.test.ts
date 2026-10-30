import { describe, expect, it } from "vitest";

import {
  beginSelection,
  bulkAvailability,
  bulkConfirmCopy,
  bulkResultMessage,
  BULK_VERB_SPECS,
  EMPTY_SELECTION,
  isSelected,
  MAX_BULK_SELECTION,
  selectAllLoaded,
  selectionCapMessage,
  selectionTitle,
  toggleSelection,
} from "./subscriberSelection";

describe("selection algebra", () => {
  it("begins selection with the long-pressed row", () => {
    expect(beginSelection("a")).toEqual({ active: true, ids: ["a"] });
  });

  it("ignores an empty id rather than selecting a phantom row", () => {
    expect(beginSelection("")).toEqual({ active: true, ids: [] });
    expect(toggleSelection(EMPTY_SELECTION, "").next).toBe(EMPTY_SELECTION);
  });

  it("toggles a row in and out", () => {
    const on = toggleSelection(EMPTY_SELECTION, "a").next;
    expect(on.ids).toEqual(["a"]);
    const off = toggleSelection(on, "a").next;
    expect(off.ids).toEqual([]);
    // Deselecting the last row keeps the bar up so the user can re-pick.
    expect(off.active).toBe(true);
  });

  it("REFUSES rather than truncates past the ceiling", () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `id-${i}`);
    const full = { active: true, ids };
    const result = toggleSelection(full, "one-too-many");
    expect(result.refused).toBe(true);
    expect(result.next.ids).toHaveLength(MAX_BULK_SELECTION);
    expect(result.next.ids).not.toContain("one-too-many");
  });

  it("still allows DEselection at the ceiling", () => {
    const ids = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `id-${i}`);
    const result = toggleSelection({ active: true, ids }, "id-0");
    expect(result.refused).toBe(false);
    expect(result.next.ids).toHaveLength(MAX_BULK_SELECTION - 1);
  });

  it("select-all dedupes, drops blanks and reports the cap", () => {
    const small = selectAllLoaded(["a", "b", "a", ""]);
    expect(small.next.ids).toEqual(["a", "b"]);
    expect(small.capped).toBe(false);

    const many = Array.from(
      { length: MAX_BULK_SELECTION + 10 },
      (_, i) => `id-${i}`,
    );
    const big = selectAllLoaded(many);
    expect(big.capped).toBe(true);
    expect(big.next.ids).toHaveLength(MAX_BULK_SELECTION);
  });

  it("isSelected is false for a row the server sent without an id", () => {
    const state = beginSelection("a");
    expect(isSelected(state, "a")).toBe(true);
    expect(isSelected(state, undefined)).toBe(false);
  });
});

describe("availability", () => {
  const ok = { count: 3, hasAdminRole: true, online: true, gated: false };

  it("enables only for an admin, online, ungated, non-empty selection", () => {
    expect(bulkAvailability(ok)).toEqual({ enabled: true });
  });

  it("puts ROLE ahead of connectivity — the durable reason wins", () => {
    const r = bulkAvailability({ ...ok, hasAdminRole: false, online: false });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/owner or admin/i);
  });

  it("explains a stale session before offline", () => {
    const r = bulkAvailability({ ...ok, gated: true, online: false });
    expect(r.reason).toMatch(/reconnect/i);
  });

  it("says bulk writes are NOT queued offline", () => {
    const r = bulkAvailability({ ...ok, online: false });
    expect(r.reason).toMatch(/aren't queued/i);
  });

  it("always carries a reason when disabled", () => {
    for (const patch of [
      { hasAdminRole: false },
      { gated: true },
      { online: false },
      { count: 0 },
    ]) {
      const r = bulkAvailability({ ...ok, ...patch });
      expect(r.enabled).toBe(false);
      expect(r.reason && r.reason.length > 0).toBe(true);
    }
  });
});

describe("copy", () => {
  it("titles the bar with an exact, grouped count", () => {
    expect(selectionTitle(0)).toBe("Select subscribers");
    expect(selectionTitle(1)).toBe("1 subscriber selected");
    expect(selectionTitle(1200)).toBe("1,200 subscribers selected");
  });

  it("names the ceiling in the refusal message", () => {
    expect(selectionCapMessage()).toContain(
      MAX_BULK_SELECTION.toLocaleString("en-US"),
    );
  });

  it("gates unsubscribe on a typed phrase and offers no undo", () => {
    const copy = bulkConfirmCopy("unsubscribe", 12);
    expect(copy?.confirmPhrase).toBe("UNSUBSCRIBE");
    expect(copy?.destructive).toBe(true);
    expect(copy?.message).toMatch(/cannot undo/i);
    expect(BULK_VERB_SPECS.unsubscribe.reversible).toBe(false);
  });

  it("does not confirm the reversible verbs", () => {
    expect(bulkConfirmCopy("tag", 12)).toBeNull();
    expect(bulkConfirmCopy("add-to-list", 12)).toBeNull();
    expect(BULK_VERB_SPECS.tag.reversible).toBe(true);
  });
});

describe("result receipt", () => {
  it("reports affected and skipped separately", () => {
    expect(bulkResultMessage("tag", { affected: 40, skipped: 2 }, 42)).toBe(
      "40 subscribers tagged · 2 skipped",
    );
  });

  it("omits skipped when the server reported none", () => {
    expect(bulkResultMessage("add-to-list", { affected: 1 }, 1)).toBe(
      "1 subscriber added",
    );
  });

  it("never invents a zero when the server sent no count", () => {
    const msg = bulkResultMessage("unsubscribe", {}, 7);
    expect(msg).not.toMatch(/\b0 /);
    expect(msg).toContain("7 subscribers");
  });

  it("handles a missing body without claiming success counts", () => {
    expect(bulkResultMessage("tag", null, 3)).toBe(
      "Tag sent for 3 subscribers.",
    );
  });
});
