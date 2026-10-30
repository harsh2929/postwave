// Tests for the sequence-level settings logic
// (components/sequence/sequence-settings.ts): goal options + honest
// caveat copy, stuck-threshold parsing (server bounds: 0=off..365),
// and stuck-report error classification (400 unconfigured / 404 absent /
// 503 retryable dependency outage).

import { describe, expect, it } from "vitest";

import {
  EXIT_ON_GOAL_CAVEAT,
  GOAL_KIND_OPTIONS,
  STUCK_AFTER_DAYS_MAX,
  STUCK_UNCONFIGURED_COPY,
  STUCK_UNAVAILABLE_COPY,
  classifyStuckError,
  goalKindCaveat,
  parseStuckAfterDays,
} from "../../components/sequence/sequence-settings";

describe("goal kind options", () => {
  it("offers exactly the server's three kinds", () => {
    expect(GOAL_KIND_OPTIONS.map((o) => o.value)).toEqual([
      "open",
      "click",
      "conversion",
    ]);
  });

  it("the conversion caveat states the goal is stored but not evaluated", () => {
    const copy = goalKindCaveat("conversion");
    expect(copy).toMatch(/stored but not yet evaluated/i);
    expect(copy).toMatch(/no conversion event source/i);
  });

  it("open/click caveats point at the Goal met participants status", () => {
    expect(goalKindCaveat("open")).toMatch(/Goal met/);
    expect(goalKindCaveat("click")).toMatch(/Goal met/);
  });

  it("the exit-on-goal caveat is honest about engine-side sends", () => {
    expect(EXIT_ON_GOAL_CAVEAT).toMatch(/can't stop engine-side sends yet/i);
    expect(EXIT_ON_GOAL_CAVEAT).toMatch(/completed_goal/);
  });
});

describe("parseStuckAfterDays", () => {
  it("treats blank and 0 as off", () => {
    expect(parseStuckAfterDays("")).toEqual({ ok: true, value: 0 });
    expect(parseStuckAfterDays("   ")).toEqual({ ok: true, value: 0 });
    expect(parseStuckAfterDays("0")).toEqual({ ok: true, value: 0 });
  });

  it("accepts whole days within the server bounds", () => {
    expect(parseStuckAfterDays("1")).toEqual({ ok: true, value: 1 });
    expect(parseStuckAfterDays("14")).toEqual({ ok: true, value: 14 });
    expect(parseStuckAfterDays(String(STUCK_AFTER_DAYS_MAX))).toEqual({
      ok: true,
      value: STUCK_AFTER_DAYS_MAX,
    });
  });

  it("rejects out-of-range, fractional, and non-numeric input", () => {
    for (const raw of ["-1", "366", "3.5", "abc", "1e9", "Infinity"]) {
      const out = parseStuckAfterDays(raw);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toMatch(/between 0 \(off\) and 365/);
    }
  });
});

describe("classifyStuckError", () => {
  it("maps 400 to unconfigured (no threshold on the sequence)", () => {
    expect(classifyStuckError({ status: 400 })).toBe("unconfigured");
  });

  it("maps 404 to unavailable (route absent on an older gateway)", () => {
    expect(classifyStuckError({ status: 404 })).toBe("unavailable");
  });

  it("maps everything else (incl. network errors with no status) to other", () => {
    expect(classifyStuckError({ status: 500 })).toBe("other");
    expect(classifyStuckError({ status: 503 })).toBe("other");
    expect(classifyStuckError({})).toBe("other");
    expect(classifyStuckError(undefined)).toBe("other");
  });

  it("honest-state copy names the fix for each terminal state", () => {
    expect(STUCK_UNCONFIGURED_COPY).toMatch(/Set a threshold first/i);
    expect(STUCK_UNAVAILABLE_COPY).toMatch(/does not expose/i);
  });
});
