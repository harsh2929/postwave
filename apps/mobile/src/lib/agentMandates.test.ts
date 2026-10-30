import { describe, expect, it } from "vitest";

import {
  liveMandateCount,
  mandateIsLive,
  mandateIsRevocable,
  mandateRevokeConsequence,
  mandateScopeSentence,
  mandateState,
  sortMandates,
  toMandate,
  type AgentMandateLike,
} from "./agentMandates";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function mandate(over: Partial<AgentMandateLike> = {}): AgentMandateLike {
  return {
    id: "m1",
    purpose: "Nightly digest",
    actions: ["campaigns:send"],
    resources: ["list:42"],
    usesRemaining: 5,
    expiresAt: "2026-08-19T12:00:00Z",
    ...over,
  };
}

describe("mandateState precedence", () => {
  it("reports active when nothing has ended it", () => {
    expect(mandateState(mandate(), NOW)).toBe("active");
  });

  it("prefers revoked over expired — the human act is the informative one", () => {
    const m = mandate({
      revokedAt: "2026-08-17T00:00:00Z",
      expiresAt: "2026-08-01T00:00:00Z",
    });
    expect(mandateState(m, NOW)).toBe("revoked");
  });

  it("prefers revoked over exhausted", () => {
    const m = mandate({ revokedAt: "2026-08-17T00:00:00Z", usesRemaining: 0 });
    expect(mandateState(m, NOW)).toBe("revoked");
  });

  it("prefers expired over exhausted", () => {
    const m = mandate({ expiresAt: "2026-08-01T00:00:00Z", usesRemaining: 0 });
    expect(mandateState(m, NOW)).toBe("expired");
  });

  it("reports exhausted when uses run out before the clock", () => {
    expect(mandateState(mandate({ usesRemaining: 0 }), NOW)).toBe("exhausted");
  });

  it("treats an expiry exactly at now as expired, not active", () => {
    const m = mandate({ expiresAt: new Date(NOW).toISOString() });
    expect(mandateState(m, NOW)).toBe("expired");
  });

  it("does not treat an unparseable expiry as already expired", () => {
    // A malformed timestamp must not silently read as "dead" — that would hide
    // a live mandate from the count this screen exists to make honest.
    const m = mandate({ expiresAt: "not-a-date" });
    expect(mandateState(m, NOW)).toBe("active");
  });
});

describe("mandateIsRevocable", () => {
  it("offers revoke for an active mandate", () => {
    expect(mandateIsRevocable(mandate(), NOW)).toBe(true);
  });

  it("offers revoke for an exhausted-but-unexpired mandate", () => {
    // Uses can be exhausted while the grant is still live in principle; ending
    // it outright is still a meaningful act.
    expect(mandateIsRevocable(mandate({ usesRemaining: 0 }), NOW)).toBe(true);
  });

  it("hides revoke once already revoked", () => {
    expect(
      mandateIsRevocable(mandate({ revokedAt: "2026-08-17T00:00:00Z" }), NOW),
    ).toBe(false);
  });

  it("hides revoke once expired — the action could not change anything", () => {
    expect(
      mandateIsRevocable(mandate({ expiresAt: "2026-08-01T00:00:00Z" }), NOW),
    ).toBe(false);
  });
});

describe("sortMandates", () => {
  it("puts live mandates above dead ones", () => {
    const dead = mandate({ id: "dead", revokedAt: "2026-08-17T00:00:00Z" });
    const live = mandate({ id: "live" });
    expect(sortMandates([dead, live], NOW).map((m) => m.id)).toEqual([
      "live",
      "dead",
    ]);
  });

  it("ranks recently used above sooner-to-expire", () => {
    const used = mandate({
      id: "used",
      lastUsedAt: "2026-08-18T11:59:00Z",
      expiresAt: "2026-08-30T00:00:00Z",
    });
    const soon = mandate({ id: "soon", expiresAt: "2026-08-18T13:00:00Z" });
    expect(sortMandates([soon, used], NOW).map((m) => m.id)).toEqual([
      "used",
      "soon",
    ]);
  });

  it("is total and stable — equal rows fall back to id", () => {
    const a = mandate({ id: "aaa" });
    const b = mandate({ id: "bbb" });
    expect(sortMandates([b, a], NOW).map((m) => m.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate its input", () => {
    const input = [mandate({ id: "z" }), mandate({ id: "a" })];
    const before = input.map((m) => m.id);
    sortMandates(input, NOW);
    expect(input.map((m) => m.id)).toEqual(before);
  });
});

describe("mandateScopeSentence", () => {
  it("reads as a clause, not as arrays", () => {
    const m = mandate({
      actions: ["campaigns:send", "segments:write"],
      resources: ["list:42"],
    });
    expect(mandateScopeSentence(m)).toBe(
      "campaigns:send, segments:write on list:42",
    );
  });

  it("overflows by count so it never truncates mid-identifier", () => {
    const m = mandate({
      actions: ["a:1", "a:2", "a:3", "a:4", "a:5"],
      resources: [],
    });
    expect(mandateScopeSentence(m, 3)).toBe("a:1, a:2, a:3 and 2 more");
  });

  it("says outright when a mandate grants nothing", () => {
    const m = mandate({ actions: [], resources: [] });
    expect(mandateScopeSentence(m)).toMatch(/Grants nothing/);
  });

  it("ignores whitespace-only entries rather than rendering blanks", () => {
    const m = mandate({ actions: ["  ", ""], resources: ["  "] });
    expect(mandateScopeSentence(m)).toMatch(/Grants nothing/);
  });
});

describe("mandateRevokeConsequence", () => {
  it("names the last use when there is one", () => {
    const m = mandate({ lastUsedAt: "2026-08-18T11:00:00Z" });
    expect(mandateRevokeConsequence(m)).toContain("Last used at");
  });

  it("says never used rather than omitting the line", () => {
    expect(mandateRevokeConsequence(mandate())).toContain("Never used");
  });

  it("always states that revocation cannot be undone", () => {
    expect(mandateRevokeConsequence(mandate())).toMatch(/cannot be undone/);
    expect(
      mandateRevokeConsequence(mandate({ lastUsedAt: "2026-08-18T11:00:00Z" })),
    ).toMatch(/cannot be undone/);
  });

  it("singularises a single remaining use", () => {
    expect(mandateRevokeConsequence(mandate({ usesRemaining: 1 }))).toContain(
      "1 use remaining",
    );
  });
});

describe("liveMandateCount", () => {
  it("counts only what currently holds authority", () => {
    const rows = [
      mandate({ id: "a" }),
      mandate({ id: "b", revokedAt: "2026-08-17T00:00:00Z" }),
      mandate({ id: "c", expiresAt: "2026-08-01T00:00:00Z" }),
      mandate({ id: "d", usesRemaining: 0 }),
    ];
    expect(liveMandateCount(rows, NOW)).toBe(1);
  });

  it("is zero for an empty list", () => {
    expect(liveMandateCount([], NOW)).toBe(0);
  });
});

describe("toMandate", () => {
  const wire = {
    id: "w1",
    purpose: "Nightly digest",
    actions: ["campaigns:send"],
    resources: ["list:42"],
    uses_remaining: 3,
    expires_at: "2026-08-19T12:00:00Z",
  };

  it("maps the wire shape across the case boundary", () => {
    expect(toMandate(wire)).toEqual({
      id: "w1",
      purpose: "Nightly digest",
      actions: ["campaigns:send"],
      resources: ["list:42"],
      usesRemaining: 3,
      expiresAt: "2026-08-19T12:00:00Z",
    });
  });

  it("flattens explicit nulls to absent, so Go's omitempty round-trips", () => {
    const m = toMandate({ ...wire, last_used_at: null, revoked_at: null });
    expect(m.lastUsedAt).toBeUndefined();
    expect(m.revokedAt).toBeUndefined();
    expect(mandateState(m, NOW)).toBe("active");
  });

  it("carries timestamps through when present", () => {
    const m = toMandate({ ...wire, revoked_at: "2026-08-17T00:00:00Z" });
    expect(mandateState(m, NOW)).toBe("revoked");
  });

  it("does not read a missing use count as unlimited", () => {
    const { uses_remaining: _drop, ...without } = wire;
    const m = toMandate(without as unknown as typeof wire);
    expect(m.usesRemaining).toBe(0);
    expect(mandateState(m, NOW)).toBe("exhausted");
  });

  it("names an untitled mandate rather than rendering a blank row", () => {
    expect(toMandate({ ...wire, purpose: "   " }).purpose).toBe(
      "Untitled mandate",
    );
  });

  it("tolerates non-array action/resource fields", () => {
    const m = toMandate({
      ...wire,
      actions: undefined as unknown as string[],
      resources: undefined as unknown as string[],
    });
    expect(mandateScopeSentence(m)).toMatch(/Grants nothing/);
  });
});

describe("mandateIsLive", () => {
  it("agrees with mandateState across every state", () => {
    const cases: AgentMandateLike[] = [
      mandate(),
      mandate({ revokedAt: "2026-08-17T00:00:00Z" }),
      mandate({ expiresAt: "2026-08-01T00:00:00Z" }),
      mandate({ usesRemaining: 0 }),
    ];
    for (const m of cases) {
      expect(mandateIsLive(m, NOW)).toBe(mandateState(m, NOW) === "active");
    }
  });
});
