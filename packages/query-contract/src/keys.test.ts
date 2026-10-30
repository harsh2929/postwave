import { describe, expect, it } from "vitest";
import { STALE, base, qk } from "./index";

describe("query key factory", () => {
  it("scopes keys by resource, tenant and role to prevent cross-tenant leakage", () => {
    expect(qk.campaigns("t1", "admin", { page: 1 })).toEqual([
      "campaigns",
      "t1",
      "admin",
      { page: 1 },
    ]);
    expect(qk.campaign("t1", "admin", 42)).toEqual(["campaign", "t1", "admin", "42"]);
  });

  it("two tenants never share a cache key for the same resource", () => {
    expect(qk.subscribers("t1", "admin")).not.toEqual(qk.subscribers("t2", "admin"));
  });

  it("two roles never share a cache key (role-scoped visibility)", () => {
    expect(qk.dashboard("t1", "admin")).not.toEqual(qk.dashboard("t1", "viewer"));
  });

  it("keeps keys well-formed before identity resolves", () => {
    expect(base("lists", "", null)).toEqual(["lists", "anon", "unknown"]);
  });

  it("normalizes a missing params/scope to a stable sentinel (not undefined)", () => {
    expect(qk.subscribers("t1", "admin")).toEqual(["subscribers", "t1", "admin", null]);
    expect(qk.settings("t1", "admin")).toEqual(["settings", "t1", "admin", "root"]);
  });

  it("authMe is identity-agnostic", () => {
    expect(qk.authMe()).toEqual(["auth-me"]);
  });

  it("exposes a staleness table", () => {
    expect(STALE.list).toBeGreaterThan(0);
    expect(STALE.reference).toBeGreaterThan(STALE.dashboard);
  });
});
