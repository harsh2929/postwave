/**
 * The four extra server facets (action / resource type / resource id /
 * actor label) — the narrowing that reaches the QUERY, not just the loaded
 * pages. What is pinned:
 *
 *  - counting and describing run over the NORMALIZED values, so whitespace-only input
 *    never lights the chip badge or fabricates a disclosure sentence;
 *  - the description names every active facet and says nothing when none is —
 *    the filter bar and the export sheet both read it verbatim.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_AUDIT_ADVANCED_FILTERS,
  countAuditAdvancedFilters,
  describeAuditAdvancedFilters,
  hasAuditAdvancedFilters,
  normalizeAuditAdvancedFilters,
} from "./auditAdvancedFilters";

describe("normalizeAuditAdvancedFilters", () => {
  it("trims every field so the server never receives padding", () => {
    expect(
      normalizeAuditAdvancedFilters({
        action: "  export ",
        resourceType: " campaign ",
        resourceId: " 12 ",
        actorLabel: "  ops@example.com ",
      }),
    ).toEqual({
      action: "export",
      resourceType: "campaign",
      resourceId: "12",
      actorLabel: "ops@example.com",
    });
  });
});

describe("countAuditAdvancedFilters", () => {
  it("counts only genuinely-set facets", () => {
    expect(countAuditAdvancedFilters(EMPTY_AUDIT_ADVANCED_FILTERS)).toBe(0);
    expect(
      countAuditAdvancedFilters({
        ...EMPTY_AUDIT_ADVANCED_FILTERS,
        action: "export",
        resourceId: "12",
      }),
    ).toBe(2);
  });

  it("does not count whitespace-only input as an active facet", () => {
    expect(
      countAuditAdvancedFilters({
        ...EMPTY_AUDIT_ADVANCED_FILTERS,
        actorLabel: "   ",
      }),
    ).toBe(0);
    expect(
      hasAuditAdvancedFilters({
        ...EMPTY_AUDIT_ADVANCED_FILTERS,
        actorLabel: "   ",
      }),
    ).toBe(false);
  });
});

describe("describeAuditAdvancedFilters", () => {
  it("is null when nothing is server-filtered — no disclosure line renders", () => {
    expect(describeAuditAdvancedFilters(EMPTY_AUDIT_ADVANCED_FILTERS)).toBeNull();
  });

  it("names every active facet in one sentence", () => {
    const text = describeAuditAdvancedFilters({
      action: "export",
      resourceType: "campaign",
      resourceId: "12",
      actorLabel: "ops@example.com",
    });
    expect(text).toContain("action contains “export”");
    expect(text).toContain("resource type campaign");
    expect(text).toContain("resource id contains “12”");
    expect(text).toContain("actor ops@example.com");
  });

  it("distinguishes the substring facets from the exact ones in its copy", () => {
    // resource_type and actor_label are EXACT equality on the server; the
    // sentence must not claim "contains" for them, or an empty result over a
    // truncated value reads as a UI bug instead of "no rows".
    const text = describeAuditAdvancedFilters({
      ...EMPTY_AUDIT_ADVANCED_FILTERS,
      resourceType: "campaign",
    });
    expect(text).toBe("Server-filtered to resource type campaign.");
    expect(text).not.toContain("contains");
  });
});
