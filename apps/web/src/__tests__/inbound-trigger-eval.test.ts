import { describe, expect, it } from "vitest";

import {
  evaluateTriggerMatch,
  operatorMatches,
  queryJsonPath,
  simulateTrigger,
  stringify,
} from "@/lib/inbound-trigger-eval";

describe("queryJsonPath", () => {
  const payload = {
    event_type: "user.created",
    user: { email: "a@b.com", vip: true, score: 5 },
    form_response: { answers: [{ email: "x@y.com" }, { email: "z@w.com" }] },
    tags: ["new", "vip"],
  };

  it("resolves the root", () => {
    expect(queryJsonPath(payload, "$")).toEqual({ value: payload, found: true });
  });

  it("resolves a nested key", () => {
    expect(queryJsonPath(payload, "$.user.email")).toEqual({ value: "a@b.com", found: true });
  });

  it("resolves array index", () => {
    expect(queryJsonPath(payload, "$.form_response.answers[0].email")).toEqual({ value: "x@y.com", found: true });
  });

  it("resolves glob to the first element", () => {
    expect(queryJsonPath(payload, "$.form_response.answers[*].email")).toEqual({ value: "x@y.com", found: true });
  });

  it("reports not-found on a missing key", () => {
    expect(queryJsonPath(payload, "$.user.missing")).toEqual({ value: undefined, found: false });
  });

  it("reports not-found for a path without $", () => {
    expect(queryJsonPath(payload, "user.email")).toEqual({ value: undefined, found: false });
  });

  it("resolves a boolean/number leaf as found", () => {
    expect(queryJsonPath(payload, "$.user.vip")).toEqual({ value: true, found: true });
    expect(queryJsonPath(payload, "$.user.score")).toEqual({ value: 5, found: true });
  });
});

describe("stringify", () => {
  it("mirrors backend rendering", () => {
    expect(stringify("a")).toBe("a");
    expect(stringify(5)).toBe("5");
    expect(stringify(true)).toBe("true");
    expect(stringify(null)).toBe("");
    expect(stringify(undefined)).toBe("");
    expect(stringify({ a: 1 })).toBe('{"a":1}');
  });
});

describe("operatorMatches", () => {
  it("exists is true only when found", () => {
    expect(operatorMatches("exists", undefined, true, null)).toBe(true);
    expect(operatorMatches("exists", undefined, false, null)).toBe(false);
  });

  it("equals compares stringified value", () => {
    expect(operatorMatches("equals", "user.created", true, "user.created")).toBe(true);
    expect(operatorMatches("equals", "user.created", true, "user.updated")).toBe(false);
    expect(operatorMatches("equals", "x", true, null)).toBe(false);
  });

  it("contains does substring", () => {
    expect(operatorMatches("contains", "user.created", true, "created")).toBe(true);
    expect(operatorMatches("contains", "user.created", true, "deleted")).toBe(false);
  });

  it("regex matches, and a bad pattern is false not a throw", () => {
    expect(operatorMatches("regex", "user.created", true, "^user\\.")).toBe(true);
    expect(operatorMatches("regex", "user.created", true, "(")).toBe(false);
  });
});

describe("evaluateTriggerMatch", () => {
  const payload = {
    event_type: "user.created",
    user: { email: "a@b.com" },
    bad: { email: "not-an-email" },
  };

  it("matches and resolves a valid email", () => {
    const sim = evaluateTriggerMatch(payload, {
      match_jsonpath: "$.event_type",
      match_operator: "equals",
      match_value: "user.created",
      email_jsonpath: "$.user.email",
    });
    expect(sim.matched).toBe(true);
    expect(sim.resolvedEmail).toBe("a@b.com");
    expect(sim.emailValid).toBe(true);
    expect(sim.note).toBeNull();
  });

  it("does not match when operator fails", () => {
    const sim = evaluateTriggerMatch(payload, {
      match_jsonpath: "$.event_type",
      match_operator: "equals",
      match_value: "other",
      email_jsonpath: "$.user.email",
    });
    expect(sim.matched).toBe(false);
    expect(sim.resolvedEmail).toBeNull();
  });

  it("matches but flags an unresolved email path", () => {
    const sim = evaluateTriggerMatch(payload, {
      match_jsonpath: "$.event_type",
      match_operator: "exists",
      email_jsonpath: "$.user.missing",
    });
    expect(sim.matched).toBe(true);
    expect(sim.emailValid).toBe(false);
    expect(sim.note).toContain("did not resolve");
  });

  it("matches but flags an invalid resolved email", () => {
    const sim = evaluateTriggerMatch(payload, {
      match_jsonpath: "$.event_type",
      match_operator: "exists",
      email_jsonpath: "$.bad.email",
    });
    expect(sim.matched).toBe(true);
    expect(sim.emailValid).toBe(false);
    expect(sim.note).toContain("not a valid email");
  });
});

describe("simulateTrigger", () => {
  it("surfaces JSON parse errors", () => {
    const res = simulateTrigger("{ not json", {
      match_jsonpath: "$.x",
      match_operator: "exists",
      email_jsonpath: "$.email",
    });
    expect(res.parseError).toBeTruthy();
    expect(res.matched).toBe(false);
  });

  it("evaluates valid JSON", () => {
    const res = simulateTrigger('{"x":1,"email":"a@b.com"}', {
      match_jsonpath: "$.x",
      match_operator: "exists",
      email_jsonpath: "$.email",
    });
    expect(res.parseError).toBeNull();
    expect(res.matched).toBe(true);
    expect(res.resolvedEmail).toBe("a@b.com");
  });
});
