/**
 * The stopping-half rule, enforced against the app rather than asserted about
 * itself.
 *
 * A test that only checked `STOPPING_HALF_CASES` against its own fields would
 * prove nothing — both halves would be things this change wrote. So each case
 * is checked against the actual transport layer: the stopping verb must be
 * REACHABLE from src/api or src/hooks, and the starting verb must not be.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  STOPPING_HALF_CASES,
  stoppingHalfBelongsOnMobile,
} from "./stoppingHalfPolicy";

/** Every transport source file, concatenated. */
function transportSources(): string {
  const roots = [join(__dirname, "..", "api"), join(__dirname, "..", "hooks")];
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      // Test files would let an assertion pass on the strength of a fixture.
      if (!entry.endsWith(".ts") || entry.includes(".test.")) continue;
      parts.push(readFileSync(abs, "utf8"));
    }
  };
  for (const root of roots) walk(root);
  return parts.join("\n");
}

describe("the stopping half belongs on the phone", () => {
  const sources = transportSources();

  it("reads a non-trivial transport layer (guards against an empty scan)", () => {
    expect(sources.length).toBeGreaterThan(50_000);
    expect(sources).toContain("/api/v1/");
  });

  it("records the rule with a reason for every case", () => {
    expect(STOPPING_HALF_CASES.length).toBeGreaterThanOrEqual(3);
    for (const entry of STOPPING_HALF_CASES) {
      expect(entry.capability.trim().length).toBeGreaterThan(0);
      expect(
        entry.reason.trim().length,
        `${entry.capability} has no reason`,
      ).toBeGreaterThan(40);
    }
  });

  it("actually reaches every stopping verb it claims", () => {
    // This is the assertion that makes the rule real. If somebody deletes the
    // cancel action from Inbox Reality because a future audit calls it
    // "not phone-appropriate", this fails and points at the decision.
    for (const entry of STOPPING_HALF_CASES) {
      expect(
        sources.includes(entry.stopping),
        `${entry.capability}: mobile no longer reaches ${entry.stopping}. The stopping half of a capability is the half that belongs on a phone — see lib/stoppingHalfPolicy.`,
      ).toBe(true);
    }
  });

  it("reaches no starting verb it has ruled out", () => {
    for (const entry of STOPPING_HALF_CASES) {
      if (!entry.starting) continue;
      expect(
        sources.includes(entry.starting),
        `${entry.capability}: mobile reaches ${entry.starting}, which this policy rules out — ${entry.reason}`,
      ).toBe(false);
    }
  });

  it("never mints a reveal-once credential from this platform", () => {
    // The concrete form of the "no starting half" rule, checked against the
    // three routes that hand back a secret exactly once. Each has a REVOKE on
    // this platform and must never gain a CREATE.
    const mintRoutes = [
      ['POST", "/api/v1/api-keys"', "an API key"],
      ['POST", "/api/v1/agent-mandates"', "an agent mandate"],
      ['POST", "/api/v1/scim/tokens"', "a SCIM provisioning token"],
    ] as const;
    for (const [fragment, what] of mintRoutes) {
      expect(
        sources.includes(fragment),
        `mobile mints ${what}. The response carries the credential exactly once and this platform has no hardened capture-then-dismiss ceremony, so offering it manufactures the dead end it is meant to solve.`,
      ).toBe(false);
    }
  });

  it("names the rule so it has a call site, not just prose", () => {
    expect(stoppingHalfBelongsOnMobile()).toBe(true);
  });
});
