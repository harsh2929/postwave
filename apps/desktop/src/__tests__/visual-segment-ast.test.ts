// Tests for the pure AST build/validate logic behind the visual segment
// builder (KLV-06). These pin the emitted query AST to the backend
// compiler's contract (apps/api/internal/segments/compile.go +
// predicates/tag_lifecycle.go): scalar coercion by value_type, in/not_in
// arrays, the {tag,days} lifecycle shape, NOT wrappers, nesting, and the
// empty/invalid → null collapse.

import { describe, expect, it } from "vitest";

import type { PredicateDefinition } from "../components/segments/segmentsClient";
import {
  buildAst,
  compilerComparator,
  coerceValue,
  comparatorsFor,
  emptyGroup,
  emptyRow,
  isComplete,
  isListComparator,
  isLifecycleComparator,
  isRowComplete,
  isSupportedPredicate,
  newId,
  splitList,
  type ConditionRow,
  type GroupNode,
} from "../components/segments/visual-segment-ast";

/* ─── Fixtures ─────────────────────────────────────────────────────── */

const PREDS: PredicateDefinition[] = [
  {
    key: "email",
    label: "Email",
    category: "Profile",
    value_type: "string",
    comparators: ["equals", "contains", "starts_with"],
    source: "profile",
    activation: [],
    compiler_status: "supported",
  },
  {
    key: "total_orders",
    label: "Total orders",
    category: "Commerce",
    value_type: "number",
    comparators: ["equals", "gt", "gte", "lt", "in", "not_in"],
    source: "commerce",
    activation: [],
    compiler_status: "supported",
  },
  {
    key: "marketing_consent",
    label: "Marketing consent",
    category: "Consent",
    value_type: "boolean",
    comparators: ["equals", "not_equals"],
    source: "consent",
    activation: [],
    compiler_status: "supported",
  },
  {
    key: "country",
    label: "Country",
    category: "Profile",
    value_type: "string",
    comparators: ["equals", "in", "not_in"],
    source: "profile",
    activation: [],
    compiler_status: "supported",
  },
  {
    key: "tags",
    label: "Tags",
    category: "Profile",
    value_type: "string",
    comparators: ["contains", "added_in_last_days", "removed_in_last_days"],
    source: "profile",
    activation: [],
    compiler_status: "supported",
  },
  {
    key: "predicted_ltv",
    label: "Predicted LTV",
    category: "Predictive",
    value_type: "number",
    comparators: ["gt", "gte"],
    source: "predictive",
    activation: [],
    compiler_status: "planned",
  },
];

function row(over: Partial<ConditionRow>): ConditionRow {
  return { ...emptyRow(), ...over };
}

function group(op: "and" | "or", children: GroupNode["children"]): GroupNode {
  return { ...emptyGroup(op), children };
}

/* ─── newId ────────────────────────────────────────────────────────── */

describe("newId", () => {
  it("returns unique ids on successive calls (never an index)", () => {
    const ids = new Set([newId(), newId(), newId(), newId()]);
    expect(ids.size).toBe(4);
  });
});

/* ─── classification helpers ───────────────────────────────────────── */

describe("comparator classification", () => {
  it("detects list comparators case-insensitively", () => {
    expect(isListComparator("in")).toBe(true);
    expect(isListComparator("NOT_IN")).toBe(true);
    expect(isListComparator("equals")).toBe(false);
  });
  it("detects lifecycle comparators", () => {
    expect(isLifecycleComparator("added_in_last_days")).toBe(true);
    expect(isLifecycleComparator("removed_in_last_days")).toBe(true);
    expect(isLifecycleComparator("contains")).toBe(false);
  });
  it("flags only supported predicates", () => {
    expect(isSupportedPredicate(PREDS[0])).toBe(true);
    expect(isSupportedPredicate(PREDS[5])).toBe(false); // planned
    expect(isSupportedPredicate(undefined)).toBe(false);
  });
  it("returns a predicate's comparators defensively", () => {
    expect(comparatorsFor(PREDS[0])).toEqual([
      "equals",
      "contains",
      "starts_with",
    ]);
    expect(comparatorsFor(undefined)).toEqual([]);
    // Non-array comparators must not crash.
    expect(
      comparatorsFor({ comparators: null } as unknown as PredicateDefinition),
    ).toEqual([]);
  });
  it("removes unsupported range choices and maps verified date aliases", () => {
    const datePredicate: PredicateDefinition = {
      ...PREDS[0]!,
      key: "consent_timestamp",
      value_type: "date",
      comparators: ["before", "after", "between"],
    };
    expect(comparatorsFor(datePredicate)).toEqual(["before", "after"]);
    expect(compilerComparator("before")).toBe("lt");
    expect(compilerComparator("after")).toBe("gt");
  });
});

/* ─── splitList ────────────────────────────────────────────────────── */

describe("splitList", () => {
  it("splits, trims, and drops empties", () => {
    expect(splitList("a, b ,, c")).toEqual(["a", "b", "c"]);
    expect(splitList("")).toEqual([]);
    expect(splitList("  ")).toEqual([]);
  });
});

/* ─── coerceValue ──────────────────────────────────────────────────── */

describe("coerceValue", () => {
  it("coerces number value_type to a number", () => {
    expect(coerceValue({ value: "42", comparator: "gt" }, "number")).toBe(42);
    expect(coerceValue({ value: "3.5", comparator: "equals" }, "number")).toBe(
      3.5,
    );
  });
  it("rejects empty / non-numeric numbers as null", () => {
    expect(coerceValue({ value: "", comparator: "gt" }, "number")).toBeNull();
    expect(
      coerceValue({ value: "abc", comparator: "gt" }, "number"),
    ).toBeNull();
  });
  it("coerces boolean value_type from the checkbox string", () => {
    expect(
      coerceValue({ value: "true", comparator: "equals" }, "boolean"),
    ).toBe(true);
    expect(
      coerceValue({ value: "false", comparator: "equals" }, "boolean"),
    ).toBe(false);
    expect(
      coerceValue({ value: "", comparator: "equals" }, "boolean"),
    ).toBeNull();
  });
  it("passes strings through trimmed", () => {
    expect(
      coerceValue({ value: "  hi  ", comparator: "equals" }, "string"),
    ).toBe("hi");
    expect(
      coerceValue({ value: "  ", comparator: "equals" }, "string"),
    ).toBeNull();
  });
  it("coerces in/not_in to a string array (comparator wins over value_type)", () => {
    expect(
      coerceValue({ value: "1, 2, 3", comparator: "in" }, "number"),
    ).toEqual(["1", "2", "3"]);
    expect(
      coerceValue({ value: "us, ca", comparator: "not_in" }, "string"),
    ).toEqual(["us", "ca"]);
    expect(coerceValue({ value: "", comparator: "in" }, "string")).toBeNull();
  });
  it("coerces lifecycle comparators to {tag, days}", () => {
    expect(
      coerceValue(
        { value: "vip", days: "30", comparator: "added_in_last_days" },
        "string",
      ),
    ).toEqual({ tag: "vip", days: 30 });
  });
  it("rejects lifecycle rows missing the tag or the days", () => {
    expect(
      coerceValue(
        { value: "", days: "30", comparator: "added_in_last_days" },
        "string",
      ),
    ).toBeNull();
    expect(
      coerceValue(
        { value: "vip", days: "", comparator: "removed_in_last_days" },
        "string",
      ),
    ).toBeNull();
    expect(
      coerceValue(
        { value: "vip", days: "x", comparator: "added_in_last_days" },
        "string",
      ),
    ).toBeNull();
  });
  it("rejects 0/negative/fractional days — backend would build a future or empty window", () => {
    // days <= 0 turns into `now() - '0 days'` (short-circuits FALSE) or
    // `now() - '-5 days'` (a future window no historical row can match):
    // both silently produce a permanently-empty segment, so the row must
    // be treated as incomplete here rather than saved.
    expect(
      coerceValue(
        { value: "vip", days: "0", comparator: "added_in_last_days" },
        "string",
      ),
    ).toBeNull();
    expect(
      coerceValue(
        { value: "vip", days: "-5", comparator: "added_in_last_days" },
        "string",
      ),
    ).toBeNull();
    expect(
      coerceValue(
        { value: "vip", days: "3.5", comparator: "removed_in_last_days" },
        "string",
      ),
    ).toBeNull();
  });
});

/* ─── isRowComplete ────────────────────────────────────────────────── */

describe("isRowComplete", () => {
  it("requires field, a matching comparator, and a value", () => {
    expect(
      isRowComplete(row({ field: "", comparator: "", value: "" }), PREDS),
    ).toBe(false);
    expect(
      isRowComplete(
        row({ field: "email", comparator: "", value: "a@b.com" }),
        PREDS,
      ),
    ).toBe(false);
    expect(
      isRowComplete(
        row({ field: "email", comparator: "equals", value: "" }),
        PREDS,
      ),
    ).toBe(false);
    expect(
      isRowComplete(
        row({ field: "email", comparator: "equals", value: "a@b.com" }),
        PREDS,
      ),
    ).toBe(true);
  });
  it("rejects a comparator not belonging to the predicate", () => {
    expect(
      isRowComplete(
        row({ field: "email", comparator: "gt", value: "5" }),
        PREDS,
      ),
    ).toBe(false);
  });
  it("rejects an unknown field", () => {
    expect(
      isRowComplete(
        row({ field: "nope", comparator: "equals", value: "x" }),
        PREDS,
      ),
    ).toBe(false);
  });
});

/* ─── isComplete (tree) ────────────────────────────────────────────── */

describe("isComplete", () => {
  it("an empty group is not complete", () => {
    expect(isComplete(emptyGroup("and"), PREDS)).toBe(false);
  });
  it("a group with one complete condition is complete", () => {
    const g = group("and", [
      row({ field: "email", comparator: "equals", value: "a@b.com" }),
    ]);
    expect(isComplete(g, PREDS)).toBe(true);
  });
  it("a group with any incomplete condition is not complete", () => {
    const g = group("and", [
      row({ field: "email", comparator: "equals", value: "a@b.com" }),
      row({ field: "total_orders", comparator: "gt", value: "" }),
    ]);
    expect(isComplete(g, PREDS)).toBe(false);
  });
});

/* ─── buildAst ─────────────────────────────────────────────────────── */

describe("buildAst", () => {
  it("returns null for an empty tree", () => {
    expect(buildAst(emptyGroup("and"), PREDS)).toBeNull();
  });

  it("unwraps a single-condition group to the bare condition leaf", () => {
    const g = group("and", [
      row({ field: "email", comparator: "contains", value: "@acme.com" }),
    ]);
    expect(buildAst(g, PREDS)).toEqual({
      op: "condition",
      field: "email",
      comparator: "contains",
      value: "@acme.com",
    });
  });

  it("emits compiler-native operators for registry date aliases", () => {
    const datePredicate: PredicateDefinition = {
      ...PREDS[0]!,
      key: "consent_timestamp",
      value_type: "date",
      comparators: ["before", "after", "between"],
    };
    const g = group("and", [
      row({
        field: "consent_timestamp",
        comparator: "before",
        value: "2026-07-16",
      }),
    ]);
    expect(buildAst(g, [...PREDS, datePredicate])).toEqual({
      op: "condition",
      field: "consent_timestamp",
      comparator: "lt",
      value: "2026-07-16",
    });
  });

  it("emits an AND group for multiple conditions with coerced values", () => {
    const g = group("and", [
      row({ field: "email", comparator: "contains", value: "@acme.com" }),
      row({ field: "total_orders", comparator: "gt", value: "3" }),
    ]);
    expect(buildAst(g, PREDS)).toEqual({
      op: "and",
      children: [
        {
          op: "condition",
          field: "email",
          comparator: "contains",
          value: "@acme.com",
        },
        { op: "condition", field: "total_orders", comparator: "gt", value: 3 },
      ],
    });
  });

  it("emits an OR group and respects the group operator", () => {
    const g = group("or", [
      row({ field: "country", comparator: "equals", value: "US" }),
      row({ field: "country", comparator: "equals", value: "CA" }),
    ]);
    const ast = buildAst(g, PREDS);
    expect(ast).toMatchObject({ op: "or" });
  });

  it("wraps a negated row in a NOT", () => {
    const g = group("and", [
      row({
        field: "marketing_consent",
        comparator: "equals",
        value: "true",
        negated: true,
      }),
    ]);
    expect(buildAst(g, PREDS)).toEqual({
      op: "not",
      child: {
        op: "condition",
        field: "marketing_consent",
        comparator: "equals",
        value: true,
      },
    });
  });

  it("encodes in/not_in as a string array", () => {
    const g = group("and", [
      row({ field: "country", comparator: "in", value: "US, CA, GB" }),
    ]);
    expect(buildAst(g, PREDS)).toEqual({
      op: "condition",
      field: "country",
      comparator: "in",
      value: ["US", "CA", "GB"],
    });
  });

  it("encodes lifecycle comparators as {tag, days}", () => {
    const g = group("and", [
      row({
        field: "tags",
        comparator: "added_in_last_days",
        value: "vip",
        days: "30",
      }),
    ]);
    expect(buildAst(g, PREDS)).toEqual({
      op: "condition",
      field: "tags",
      comparator: "added_in_last_days",
      value: { tag: "vip", days: 30 },
    });
  });

  it("supports a nested group inside the root with its own operator", () => {
    const inner = group("or", [
      row({ field: "country", comparator: "equals", value: "US" }),
      row({ field: "country", comparator: "equals", value: "CA" }),
    ]);
    const rootTree = group("and", [
      row({ field: "total_orders", comparator: "gte", value: "1" }),
      inner,
    ]);
    expect(buildAst(rootTree, PREDS)).toEqual({
      op: "and",
      children: [
        { op: "condition", field: "total_orders", comparator: "gte", value: 1 },
        {
          op: "or",
          children: [
            {
              op: "condition",
              field: "country",
              comparator: "equals",
              value: "US",
            },
            {
              op: "condition",
              field: "country",
              comparator: "equals",
              value: "CA",
            },
          ],
        },
      ],
    });
  });

  it("wraps a negated nested group in NOT", () => {
    const inner: GroupNode = {
      ...group("or", [
        row({ field: "country", comparator: "equals", value: "US" }),
        row({ field: "country", comparator: "equals", value: "CA" }),
      ]),
      negated: true,
    };
    const rootTree = group("and", [
      row({ field: "total_orders", comparator: "gte", value: "1" }),
      inner,
    ]);
    expect(buildAst(rootTree, PREDS)).toEqual({
      op: "and",
      children: [
        { op: "condition", field: "total_orders", comparator: "gte", value: 1 },
        {
          op: "not",
          child: {
            op: "or",
            children: [
              {
                op: "condition",
                field: "country",
                comparator: "equals",
                value: "US",
              },
              {
                op: "condition",
                field: "country",
                comparator: "equals",
                value: "CA",
              },
            ],
          },
        },
      ],
    });
  });

  it("drops incomplete rows but keeps the rest of the group", () => {
    const g = group("and", [
      row({ field: "email", comparator: "equals", value: "a@b.com" }),
      row({ field: "total_orders", comparator: "gt", value: "" }), // incomplete → dropped
    ]);
    // Only one survives → unwrapped to the bare leaf.
    expect(buildAst(g, PREDS)).toEqual({
      op: "condition",
      field: "email",
      comparator: "equals",
      value: "a@b.com",
    });
  });

  it("collapses a group of only-incomplete rows to null", () => {
    const g = group("and", [
      row({ field: "email", comparator: "equals", value: "" }),
      row({ field: "", comparator: "", value: "" }),
    ]);
    expect(buildAst(g, PREDS)).toBeNull();
  });

  it("ignores a non-array children field without crashing", () => {
    const bad = {
      id: "x",
      kind: "group",
      op: "and",
      children: null,
    } as unknown as GroupNode;
    expect(buildAst(bad, PREDS)).toBeNull();
  });
});
