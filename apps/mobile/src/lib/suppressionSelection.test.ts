import { describe, expect, it } from "vitest";

import {
  beginSelection,
  MAX_SUPPRESSION_SELECTION,
  parseSuppressionBulkResult,
  selectAllLoaded,
  suppressionBulkAvailability,
  suppressionBulkConfirmCopy,
  suppressionBulkResultMessage,
  suppressionSelectionTitle,
  toggleSelection,
} from "./suppressionSelection";

describe("selection algebra (reused from subscriberSelection)", () => {
  it("enters seeded with the long-pressed row", () => {
    expect(beginSelection("a@example.com")).toEqual({
      active: true,
      ids: ["a@example.com"],
    });
  });

  it("toggles a row in and out", () => {
    const one = beginSelection("a@example.com");
    const two = toggleSelection(one, "b@example.com").next;
    expect(two.ids).toEqual(["a@example.com", "b@example.com"]);
    expect(toggleSelection(two, "a@example.com").next.ids).toEqual([
      "b@example.com",
    ]);
  });

  it("REFUSES past the ceiling rather than silently truncating", () => {
    const ids = Array.from(
      { length: MAX_SUPPRESSION_SELECTION },
      (_, i) => `x${i}@example.com`,
    );
    const full = { active: true as const, ids };
    const result = toggleSelection(full, "one-too-many@example.com");
    expect(result.refused).toBe(true);
    expect(result.next.ids).toHaveLength(MAX_SUPPRESSION_SELECTION);
  });

  it("select-all covers the LOADED rows and reports a cap", () => {
    const loaded = Array.from(
      { length: MAX_SUPPRESSION_SELECTION + 5 },
      (_, i) => `y${i}@example.com`,
    );
    const result = selectAllLoaded(loaded);
    expect(result.capped).toBe(true);
    expect(result.next.ids).toHaveLength(MAX_SUPPRESSION_SELECTION);
  });

  it("matches the server's own 500-identifier per-request limit", () => {
    // bulk.go validateBulkSelection: "max 500 identifiers per request".
    expect(MAX_SUPPRESSION_SELECTION).toBe(500);
  });
});

describe("suppressionBulkAvailability", () => {
  it("admits owner|admin only — the ScopeAdmin mount", () => {
    expect(
      suppressionBulkAvailability({
        count: 3,
        hasAdminRole: true,
        online: true,
        gated: false,
      }),
    ).toEqual({ enabled: true });
    const editor = suppressionBulkAvailability({
      count: 3,
      hasAdminRole: false,
      online: true,
      gated: false,
    });
    expect(editor.enabled).toBe(false);
    expect(editor.reason).toContain("owner or admin");
  });

  it("gives the ROLE reason precedence over connectivity", () => {
    expect(
      suppressionBulkAvailability({
        count: 3,
        hasAdminRole: false,
        online: false,
        gated: true,
      }).reason,
    ).toContain("owner or admin");
  });

  it("refuses an empty selection with a reason, not a silent no-op", () => {
    const empty = suppressionBulkAvailability({
      count: 0,
      hasAdminRole: true,
      online: true,
      gated: false,
    });
    expect(empty.enabled).toBe(false);
    expect(empty.reason).toContain("at least one");
  });

  it("says the verb is NOT queued offline", () => {
    expect(
      suppressionBulkAvailability({
        count: 2,
        hasAdminRole: true,
        online: false,
        gated: false,
      }).reason,
    ).toContain("isn't queued");
  });
});

describe("suppressionBulkConfirmCopy", () => {
  it("gates on a typed phrase and names the blast radius", () => {
    const copy = suppressionBulkConfirmCopy(40);
    expect(copy.confirmPhrase).toBe("RELEASE");
    expect(copy.destructive).toBe(true);
    expect(copy.title).toContain("40 addresses");
    expect(copy.consequence).toContain("40 people");
    // It must warn that some rows will be skipped BEFORE the user commits.
    expect(copy.message).toContain("skipped");
  });

  it("uses the singular for one row", () => {
    expect(suppressionBulkConfirmCopy(1).title).toBe("Release 1 address?");
  });
});

describe("parseSuppressionBulkResult / suppressionBulkResultMessage", () => {
  it("reports blocked rows separately — never folded into the released count", () => {
    const result = parseSuppressionBulkResult({
      deleted_count: 37,
      blocked: ["a@example.com", "b@example.com", "c@example.com"],
      errors: [],
    });
    expect(result.released).toBe(37);
    const message = suppressionBulkResultMessage(result, 40);
    expect(message).toContain("37 addresses released");
    expect(message).toContain("3 can't be released");
  });

  it("surfaces per-row errors too", () => {
    const message = suppressionBulkResultMessage(
      parseSuppressionBulkResult({
        deleted_count: 1,
        errors: ["x@example.com: not found"],
      }),
      2,
    );
    expect(message).toContain("1 failed");
  });

  it("says what was ASKED FOR when the server sent no count — absence is not zero", () => {
    expect(suppressionBulkResultMessage(parseSuppressionBulkResult({}), 12)).toBe(
      "Release sent for 12 addresses.",
    );
    expect(suppressionBulkResultMessage(null, 1)).toBe(
      "Release sent for 1 address.",
    );
  });

  it("reports a genuine zero as zero", () => {
    expect(
      suppressionBulkResultMessage(
        parseSuppressionBulkResult({ deleted_count: 0, blocked: ["a"] }),
        1,
      ),
    ).toContain("0 addresses released");
  });

  it("ignores non-string entries in blocked/errors", () => {
    const result = parseSuppressionBulkResult({
      deleted_count: 1,
      blocked: ["a@example.com", 5, null],
      errors: "not-an-array",
    });
    expect(result.blocked).toEqual(["a@example.com"]);
    expect(result.errors).toEqual([]);
  });
});

describe("suppressionSelectionTitle", () => {
  it("names the noun and the count", () => {
    expect(suppressionSelectionTitle(0)).toBe("Select addresses");
    expect(suppressionSelectionTitle(1)).toBe("1 address selected");
    expect(suppressionSelectionTitle(1200)).toBe("1,200 addresses selected");
  });
});
