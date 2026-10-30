import { describe, expect, it } from "vitest";

import {
  AST_MAX_NODES,
  countAstConditions,
  describeSegmentAst,
  describeValue,
  humaniseField,
} from "./segmentAst";

const CONDITION = {
  op: "condition",
  field: "status",
  comparator: "equals",
  value: "enabled",
};

describe("humaniseField", () => {
  it("un-snakes and separates a dotted path", () => {
    expect(humaniseField("predictive.churn_risk")).toBe("predictive › churn risk");
  });

  it("leaves a plain field alone", () => {
    expect(humaniseField("email")).toBe("email");
  });
});

describe("describeValue", () => {
  it("renders scalars", () => {
    expect(describeValue("enabled")).toBe("enabled");
    expect(describeValue(42)).toBe("42");
    expect(describeValue(true)).toBe("yes");
    expect(describeValue(false)).toBe("no");
  });

  it("renders nothing for null/undefined rather than 'null'", () => {
    expect(describeValue(null)).toBe("");
    expect(describeValue(undefined)).toBe("");
  });

  it("truncates a long string instead of blowing out the row", () => {
    const out = describeValue("x".repeat(200));
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("caps an array and says how many were hidden", () => {
    expect(describeValue([1, 2, 3, 4, 5, 6, 7])).toBe("1, 2, 3, 4, 5 +2 more");
  });

  it("never dumps a nested object", () => {
    expect(describeValue({ a: 1 })).toBe("…");
  });
});

describe("describeSegmentAst", () => {
  it("renders a single condition", () => {
    expect(describeSegmentAst(CONDITION)).toEqual([
      { depth: 0, text: "status is enabled" },
    ]);
  });

  it("renders an AND group with indented children", () => {
    expect(
      describeSegmentAst({
        op: "and",
        children: [
          CONDITION,
          { op: "condition", field: "tags", comparator: "in", value: ["vip"] },
        ],
      }),
    ).toEqual([
      { depth: 0, text: "All of:" },
      { depth: 1, text: "status is enabled" },
      { depth: 1, text: "tags is one of vip" },
    ]);
  });

  it("renders OR as 'Any of:'", () => {
    expect(describeSegmentAst({ op: "or", children: [CONDITION] })[0]).toEqual({
      depth: 0,
      text: "Any of:",
    });
  });

  it("handles NOT with either `child` or a single-element `children`", () => {
    expect(describeSegmentAst({ op: "not", child: CONDITION })).toEqual([
      { depth: 0, text: "Not:" },
      { depth: 1, text: "status is enabled" },
    ]);
    expect(describeSegmentAst({ op: "not", children: [CONDITION] })).toEqual([
      { depth: 0, text: "Not:" },
      { depth: 1, text: "status is enabled" },
    ]);
  });

  it("never throws on garbage — a broken rule must not blank the screen", () => {
    expect(describeSegmentAst(null)).toEqual([
      { depth: 0, text: "(unreadable rule)" },
    ]);
    expect(describeSegmentAst("nope")).toEqual([
      { depth: 0, text: "(unreadable rule)" },
    ]);
    expect(describeSegmentAst([1, 2])).toEqual([
      { depth: 0, text: "(unreadable rule)" },
    ]);
  });

  it("stops at the depth cap rather than recursing forever", () => {
    // A pathologically deep tree from an LLM-authored compile.
    let node: unknown = CONDITION;
    for (let i = 0; i < 50; i += 1) node = { op: "not", child: node };
    const lines = describeSegmentAst(node);
    expect(lines.length).toBeLessThan(20);
    expect(lines.at(-1)?.text).toContain("and more");
  });

  it("stops at the node cap on a very wide tree", () => {
    const children = Array.from({ length: 500 }, () => CONDITION);
    const lines = describeSegmentAst({ op: "and", children });
    expect(lines.length).toBeLessThanOrEqual(AST_MAX_NODES + 2);
    expect(lines.at(-1)?.text).toContain("and more");
  });

  it("degrades gracefully for an unknown op", () => {
    expect(describeSegmentAst({ op: "weird_op" })).toEqual([
      { depth: 0, text: "weird op" },
    ]);
  });

  it("tolerates a legacy condition node with no explicit op", () => {
    expect(
      describeSegmentAst({ field: "email", comparator: "is_not_null" }),
    ).toEqual([{ depth: 0, text: "email is set" }]);
  });
});

describe("countAstConditions", () => {
  it("counts leaves, not groups", () => {
    expect(
      countAstConditions({
        op: "and",
        children: [CONDITION, { op: "or", children: [CONDITION, CONDITION] }],
      }),
    ).toBe(3);
  });

  it("is 1 for a bare condition and 0 for nothing", () => {
    expect(countAstConditions(CONDITION)).toBe(1);
    expect(countAstConditions(null)).toBe(0);
    expect(countAstConditions(undefined)).toBe(0);
  });

  it("terminates on a cyclic-looking, very deep tree", () => {
    let node: unknown = CONDITION;
    for (let i = 0; i < 200; i += 1) node = { op: "not", child: node };
    expect(countAstConditions(node)).toBe(0);
  });
});
