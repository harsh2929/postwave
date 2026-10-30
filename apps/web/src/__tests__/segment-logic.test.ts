// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import type { SegmentNode } from "@/lib/segments-api";
import {
  COMPARATORS,
  countConditions,
  countIncompleteConditions,
  duplicateName,
  duplicateSegmentInput,
  formatRelativeDate,
  isComparator,
  isIncompleteCondition,
  isValuelessComparator,
  parseRelativeDate,
  restoreSegmentInput,
  seedConditionFromParams,
  validateName,
  validateSegment,
} from "@/components/segments/segment-logic";

describe("relative-date grammar", () => {
  it("parses past and future tokens", () => {
    expect(parseRelativeDate("now-30d")).toEqual({ days: 30, direction: "past" });
    expect(parseRelativeDate("now+5d")).toEqual({ days: 5, direction: "future" });
    expect(parseRelativeDate("NOW-7D")).toEqual({ days: 7, direction: "past" });
  });
  it("rejects non-relative or out-of-range values", () => {
    expect(parseRelativeDate("2026-01-01T00:00")).toBeNull();
    expect(parseRelativeDate("now-0d")).toBeNull();
    expect(parseRelativeDate("now-40000d")).toBeNull();
    expect(parseRelativeDate(30)).toBeNull();
    expect(parseRelativeDate("")).toBeNull();
  });
  it("formats and round-trips", () => {
    expect(formatRelativeDate(30)).toBe("now-30d");
    expect(formatRelativeDate(5, "future")).toBe("now+5d");
    expect(parseRelativeDate(formatRelativeDate(90))).toEqual({
      days: 90,
      direction: "past",
    });
  });
  it("clamps invalid day counts when formatting", () => {
    expect(formatRelativeDate(0)).toBe("now-1d");
    expect(formatRelativeDate(999999)).toBe("now-36500d");
  });
});

describe("valueless comparators", () => {
  it("treats presence operators as valueless", () => {
    expect(isValuelessComparator("is_null")).toBe(true);
    expect(isValuelessComparator("is_not_null")).toBe(true);
    expect(isValuelessComparator("equals")).toBe(false);
  });
  it("a presence condition with empty value is NOT incomplete", () => {
    expect(
      isIncompleteCondition({
        op: "condition",
        field: "last_opened_at",
        comparator: "is_not_null",
        value: "",
      }),
    ).toBe(false);
  });
});

describe("validateName", () => {
  it("requires a non-empty name", () => {
    expect(validateName("")).toBe("Name is required");
    expect(validateName("   ")).toBe("Name is required");
  });
  it("caps the length", () => {
    expect(validateName("x".repeat(200), 120)).toMatch(/120 characters/);
    expect(validateName("VIPs")).toBeNull();
  });
});

describe("condition counting", () => {
  const ast: SegmentNode = {
    op: "and",
    children: [
      { op: "condition", field: "email", comparator: "equals", value: "a@b.c" },
      { op: "condition", field: "email", comparator: "equals", value: "" },
      {
        op: "not",
        child: {
          op: "condition",
          field: "tag",
          comparator: "in",
          value: [],
        },
      },
    ],
  };
  it("counts all leaf conditions", () => {
    expect(countConditions(ast)).toBe(3);
  });
  it("counts incomplete (empty-value) conditions, including inside NOT", () => {
    expect(countIncompleteConditions(ast)).toBe(2);
  });
});

describe("validateSegment", () => {
  it("blocks on missing name or incomplete rules", () => {
    const r = validateSegment("", {
      op: "condition",
      field: "email",
      comparator: "equals",
      value: "",
    });
    expect(r.valid).toBe(false);
    expect(r.nameError).toBe("Name is required");
    expect(r.incompleteCount).toBe(1);
  });
  it("warns when every condition is incomplete (matches no one)", () => {
    const r = validateSegment("Empty", {
      op: "and",
      children: [
        { op: "condition", field: "email", comparator: "equals", value: "" },
      ],
    });
    expect(r.matchNoneWarning).toBe(true);
  });
  it("passes a complete definition", () => {
    const r = validateSegment("Engaged", {
      op: "condition",
      field: "last_opened_at",
      comparator: "is_not_null",
      value: "",
    });
    expect(r.valid).toBe(true);
    expect(r.matchNoneWarning).toBe(false);
    expect(r.matchAllWarning).toBe(false);
  });
  it("warns when there are no rules (would match everyone) — SEG-030", () => {
    const r = validateSegment("Everyone", { op: "and", children: [] });
    expect(r.matchAllWarning).toBe(true);
    expect(r.matchNoneWarning).toBe(false);
    // saveable, but the warning is surfaced non-blockingly
    expect(r.valid).toBe(true);
  });
});

describe("duplicateName", () => {
  it("appends (copy) and increments on collision", () => {
    expect(duplicateName("VIPs")).toBe("VIPs (copy)");
    expect(duplicateName("VIPs", ["VIPs (copy)"])).toBe("VIPs (copy 2)");
    expect(duplicateName("VIPs (copy)", ["VIPs (copy)"])).toBe("VIPs (copy 2)");
  });
});

// --- Deep-link seeding (SEG / ANL-031) -------------------------------------
//
// Regression: the editor read `?seedField/&seedComparator=` from the URL and
// cast the comparator straight into the AST — `seedComparator as Comparator`.
// Nothing validated it. `isIncompleteCondition` only checks that a VALUE is
// present, so a condition carrying a bogus comparator passed validateSegment()
// and was saved. The comparator <select> has no matching <option>, so the rule
// also rendered blank: the user saw an empty dropdown on a segment that had
// already persisted an operator the compiler never defined.
describe("seedConditionFromParams", () => {
  const q = (s: string) => new URLSearchParams(s);

  it("builds a condition from a well-formed insight link", () => {
    expect(
      seedConditionFromParams(q("seedField=contact_rating&seedComparator=equals&seedValue=4")),
    ).toEqual({
      op: "and",
      children: [
        { op: "condition", field: "contact_rating", comparator: "equals", value: "4" },
      ],
    });
  });

  it("rejects a comparator the compiler does not define", () => {
    expect(seedConditionFromParams(q("seedField=x&seedComparator=DROP+TABLE"))).toBeNull();
    expect(seedConditionFromParams(q("seedField=x&seedComparator=like"))).toBeNull();
    expect(seedConditionFromParams(q("seedField=x&seedComparator="))).toBeNull();
  });

  it("requires a field as well as a comparator", () => {
    expect(seedConditionFromParams(q("seedComparator=equals"))).toBeNull();
    expect(seedConditionFromParams(q("seedField=+&seedComparator=equals"))).toBeNull();
  });

  it("defaults a missing value to empty rather than dropping the rule", () => {
    const node = seedConditionFromParams(q("seedField=x&seedComparator=is_null"));
    expect(node?.op).toBe("and");
    // Narrow: only and/or carry `children`.
    if (node?.op !== "and") throw new Error("expected an and-node");
    expect(node.children[0]).toMatchObject({ comparator: "is_null", value: "" });
  });

  it("accepts every comparator the type declares", () => {
    for (const c of COMPARATORS) {
      expect(isComparator(c)).toBe(true);
      expect(seedConditionFromParams(q(`seedField=x&seedComparator=${c}`))).not.toBeNull();
    }
  });
});

// --- Definition-preserving clone/restore (SEG-034) -------------------------
//
// Regression: `includeArchived` is part of what a segment MEANS — it decides
// whether archived contacts are in scope — and onSave persisted it. But the two
// paths that rebuild a definition did not carry it:
//
//   * Duplicate built { name, description, queryAst } only, so the copy of an
//     archive-scoped segment quietly excluded archived contacts and reported a
//     different member count than the original it claimed to duplicate;
//   * the delete toast's Undo restored the same three fields, so restoring a
//     segment silently reset its scope.
//
// Neither surfaced an error: the field is optional on CreateSegmentInput, so
// omitting it type-checks and the server just applies the default.
describe("segment definition clone/restore", () => {
  const ast: SegmentNode = {
    op: "and",
    children: [
      { op: "condition", field: "email", comparator: "contains", value: "@x.com" },
    ],
  };
  const source = {
    id: "s1",
    tenantId: "t1",
    name: "Archived VIPs",
    description: "includes archived",
    queryAst: ast,
    includeArchived: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("carries the archive scope into a duplicate", () => {
    const input = duplicateSegmentInput(source, {
      description: source.description,
      queryAst: ast,
    });
    expect(input.name).toBe("Archived VIPs (copy)");
    expect(input.includeArchived).toBe(true);
    expect(input.queryAst).toEqual(ast);
  });

  it("carries the archive scope into a restore", () => {
    expect(restoreSegmentInput(source)).toEqual({
      name: "Archived VIPs",
      description: "includes archived",
      queryAst: ast,
      includeArchived: true,
    });
  });

  it("defaults an absent scope to active-only rather than undefined", () => {
    const { includeArchived, ...rest } = source;
    void includeArchived;
    expect(restoreSegmentInput(rest).includeArchived).toBe(false);
    expect(
      duplicateSegmentInput(rest, { description: "", queryAst: ast })
        .includeArchived,
    ).toBe(false);
  });

  it("avoids colliding with names already taken", () => {
    const input = duplicateSegmentInput(
      source,
      { description: "", queryAst: ast },
      ["Archived VIPs (copy)"],
    );
    expect(input.name).toBe("Archived VIPs (copy 2)");
  });
});
