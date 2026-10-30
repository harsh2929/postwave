import { describe, expect, it } from "vitest";

import {
  type MatchOperator,
  evaluateJSONPath,
  matchOperator,
} from "../../lib/jsonpath";

const payload = {
  user: { email: "amy@example.com", name: "Amy" },
  events: [
    { type: "signup", at: 1 },
    { type: "purchase", at: 2 },
  ],
  meta: { source: "shopify", tags: ["new", "vip"] },
};

describe("evaluateJSONPath", () => {
  it("root", () => {
    expect(evaluateJSONPath(payload, "$")).toEqual([payload]);
  });
  it("simple prop", () => {
    expect(evaluateJSONPath(payload, "$.user.email")).toEqual([
      "amy@example.com",
    ]);
  });
  it("array index", () => {
    expect(evaluateJSONPath(payload, "$.events[0].type")).toEqual(["signup"]);
  });
  // D12-comms-webhooks#8: the desktop evaluator deliberately mirrors the
  // BACKEND's limited subset (inbound_webhooks/triggers.go) so the live
  // "Trigger fires" preview never green-lights a match that is dead
  // server-side. A negative index never matches and `[*]` resolves to the
  // FIRST array element only (and not over object values).
  it("negative array index never matches (backend parity)", () => {
    expect(evaluateJSONPath(payload, "$.events[-1].type")).toEqual([]);
  });
  it("wildcard over array → first element only (backend parity)", () => {
    expect(evaluateJSONPath(payload, "$.events[*].type")).toEqual(["signup"]);
  });
  it("wildcard over object → no match (backend parity)", () => {
    expect(evaluateJSONPath(payload, "$.user[*]")).toEqual([]);
  });
  it("bracket-quoted properties follow the server's no-escape subset", () => {
    expect(evaluateJSONPath(payload, "$['user']['email']")).toEqual([
      "amy@example.com",
    ]);
    expect(evaluateJSONPath(payload, "$['user']")).toEqual([payload.user]);
    expect(evaluateJSONPath(payload, "$['us\\\\er']")).toEqual([]);
  });
  it("recursive descent is rejected (backend parity)", () => {
    expect(evaluateJSONPath(payload, "$..type")).toEqual([]);
  });
  it("reserved dotted-key characters are rejected (backend parity)", () => {
    expect(evaluateJSONPath({ "a*": 1 }, "$.a*")).toEqual([]);
    expect(evaluateJSONPath({ "a]": 1 }, "$.a]")).toEqual([]);
    expect(evaluateJSONPath({ "a\\b": 1 }, "$.a\\b")).toEqual([]);
  });
  it("missing path returns empty", () => {
    expect(evaluateJSONPath(payload, "$.does.not.exist")).toEqual([]);
  });
  it("invalid path returns empty", () => {
    expect(evaluateJSONPath(payload, "garbage")).toEqual([]);
  });
  it("malformed $-prefixed paths return empty, not the root match", () => {
    expect(evaluateJSONPath(payload, "$foo")).toEqual([]);
    expect(evaluateJSONPath(payload, "$.")).toEqual([]);
    expect(evaluateJSONPath(payload, "$.user[")).toEqual([]);
    expect(evaluateJSONPath(payload, "$ ")).toEqual([payload]); // trimmed root is fine
  });
});

describe("matchOperator", () => {
  const cases: Array<{
    op: MatchOperator;
    matches: unknown[];
    expected?: string | null;
    out: boolean;
  }> = [
    { op: "exists", matches: ["x"], out: true },
    { op: "exists", matches: [], out: false },
    { op: "equals", matches: ["amy"], expected: "amy", out: true },
    { op: "equals", matches: ["amy"], expected: "bob", out: false },
    {
      op: "contains",
      matches: ["amy@example.com"],
      expected: "example",
      out: true,
    },
    {
      op: "contains",
      matches: ["amy@example.com"],
      expected: "missing",
      out: false,
    },
    { op: "contains", matches: [{ a: 1 }], expected: '"a":1', out: true },
    { op: "regex", matches: ["amy@x.com"], expected: "@x\\.", out: false },
    { op: "regex", matches: ["x"], expected: "[", out: false },
  ];
  for (const c of cases) {
    it(`${c.op}(${JSON.stringify(c.matches)}, ${c.expected ?? ""}) → ${c.out}`, () => {
      expect(matchOperator(c.op, c.matches, c.expected)).toBe(c.out);
    });
  }

  it("rejects oversized regex patterns instead of compiling them", () => {
    const huge = `(${"a".repeat(600)})+`;
    expect(matchOperator("regex", ["aaaa"], huge)).toBe(false);
  });
});
