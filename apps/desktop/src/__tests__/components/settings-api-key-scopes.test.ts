// API-key scope catalog (roadmap item 5): the checkbox grid must
// render the REAL backend scope ids — this test pins the catalog to
// apps/api/internal/apikeys/apikeys.go AllScopes (7 core + 6 audit:*).
// Plus the pure selection/validation/summary helpers.

import { describe, expect, it } from "vitest";

import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_GROUPS,
  scopesSummary,
  toggleScope,
  validateKeyDraft,
} from "../../components/settings/api-key-scopes";

describe("API_KEY_SCOPES", () => {
  it("mirrors the backend AllScopes catalog exactly", () => {
    expect(API_KEY_SCOPES.map((s) => s.id).sort()).toEqual(
      [
        "read:subscribers",
        "write:subscribers",
        "read:campaigns",
        "write:campaigns",
        "send:transactional",
        "read:reports",
        "admin",
        "audit:read",
        "audit:read_pii",
        "audit:read_all_tenants",
        "audit:configure_sinks",
        "audit:configure_retention",
        "audit:execute_actions",
      ].sort(),
    );
  });

  it("groups every scope under a rendered group with a description", () => {
    for (const s of API_KEY_SCOPES) {
      expect(API_KEY_SCOPE_GROUPS).toContain(s.group);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it("marks only the admin wildcard as privileged", () => {
    expect(
      API_KEY_SCOPES.filter((s) => s.privileged).map((s) => s.id),
    ).toEqual(["admin"]);
  });
});

describe("toggleScope", () => {
  it("adds and removes immutably", () => {
    const base = ["read:reports"];
    const added = toggleScope(base, "admin");
    expect(added).toEqual(["read:reports", "admin"]);
    expect(base).toEqual(["read:reports"]); // untouched
    expect(toggleScope(added, "admin")).toEqual(["read:reports"]);
  });
});

describe("validateKeyDraft", () => {
  it("requires a label and at least one scope", () => {
    expect(validateKeyDraft("", ["admin"])).toContain("label");
    expect(validateKeyDraft("   ", ["admin"])).toContain("label");
    expect(validateKeyDraft("Zapier", [])).toContain("scope");
    expect(validateKeyDraft("Zapier", ["read:reports"])).toBeNull();
  });
});

describe("scopesSummary", () => {
  it("collapses admin to the wildcard label", () => {
    expect(scopesSummary(["read:reports", "admin"])).toBe("admin (all scopes)");
  });

  it("lists few scopes verbatim and truncates many", () => {
    expect(scopesSummary(["a", "b"])).toBe("a, b");
    expect(scopesSummary(["a", "b", "c", "d", "e"])).toBe("a, b, c +2 more");
    expect(scopesSummary([])).toBe("no scopes");
  });
});
