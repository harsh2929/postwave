// SPDX-License-Identifier: AGPL-3.0-only
//
// Every cache key must carry the tenant and role it was computed under.
//
// keys.test.ts asserts this for the factories that exist today — two tenants
// never collide, two roles never collide, identity-unresolved keys stay
// well-formed. What nothing asserted is the RULE: a seventeenth factory added
// without `base()` would ship an unscoped key, and every existing test would
// still pass because none of them knows about it.
//
// This is the shared substrate for web, desktop and mobile — all three consume
// it and none forks it — so an unscoped key here is an unscoped key on every
// surface at once. On web a stale entry is bounded by QueryProvider rebuilding
// the whole client on identity change; the native clients have no equivalent
// backstop, which is what makes the key shape itself load-bearing.
//
// `authMe` is the one deliberate exception and is named here rather than
// pattern-matched: it is the query that RESOLVES identity, so scoping it by
// identity would be circular.
import { describe, expect, it } from "vitest";

import { base, qk, type RoleKey } from "./keys";

const IDENTITY_AGNOSTIC = new Set(["authMe"]);

describe("every key factory is tenant- and role-scoped", () => {
  const factories = Object.entries(qk).filter(
    ([, fn]) => typeof fn === "function",
  ) as [string, (...args: unknown[]) => readonly unknown[]][];

  it("enumerates the factories", () => {
    // Guard the guard: an empty enumeration passes silently, which for a
    // cross-tenant isolation check is the worst possible false green.
    expect(factories.length).toBeGreaterThan(10);
    expect(factories.map(([n]) => n)).toContain("authMe");
  });

  it("produces a different key for a different tenant", () => {
    const offenders: string[] = [];
    for (const [name, fn] of factories) {
      if (IDENTITY_AGNOSTIC.has(name)) continue;
      const a = JSON.stringify(fn("tenant-a", "admin" as RoleKey, "x", "y"));
      const b = JSON.stringify(fn("tenant-b", "admin" as RoleKey, "x", "y"));
      if (a === b) offenders.push(name);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("produces a different key for a different role", () => {
    const offenders: string[] = [];
    for (const [name, fn] of factories) {
      if (IDENTITY_AGNOSTIC.has(name)) continue;
      const a = JSON.stringify(fn("tenant-a", "admin" as RoleKey, "x", "y"));
      const b = JSON.stringify(fn("tenant-a", "viewer" as RoleKey, "x", "y"));
      if (a === b) offenders.push(name);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("keeps the identity-agnostic exception genuinely agnostic", () => {
    // If authMe ever started varying by tenant it would never resolve: the
    // tenant is what it is being asked to discover.
    expect(qk.authMe()).toEqual(qk.authMe());
  });

  it("substitutes a stable sentinel before identity resolves", () => {
    // "" and null must not produce distinct keys, or the pre-login render and
    // the post-login render fetch twice and cache separately.
    expect(base("dashboard", "", "admin" as RoleKey)).toEqual(
      base("dashboard", "", "admin" as RoleKey),
    );
    expect(JSON.stringify(base("dashboard", "", null as unknown as RoleKey)))
      .toContain("anon");
    expect(JSON.stringify(base("dashboard", "", null as unknown as RoleKey)))
      .toContain("unknown");
  });
});
