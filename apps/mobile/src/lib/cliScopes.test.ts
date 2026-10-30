import { describe, expect, it } from "vitest";

import {
  CLI_ADMIN_SCOPES,
  CLI_EDITOR_SCOPES,
  CLI_READ_SCOPES,
  cliGrantNeedsStepUp,
  cliScopesForRole,
  isValidDeviceCode,
  normalizeCliScopeRole,
  normalizeDeviceCode,
  scopeDisclosure,
  scopeSummary,
} from "./cliScopes";

describe("cliScopesForRole", () => {
  it("mirrors cliScopesForPrincipal's role → scope mapping exactly", () => {
    expect(cliScopesForRole("viewer")).toEqual([...CLI_READ_SCOPES]);
    expect(cliScopesForRole("editor")).toEqual([...CLI_EDITOR_SCOPES]);
    expect(cliScopesForRole("admin")).toEqual([...CLI_ADMIN_SCOPES]);
    expect(cliScopesForRole("owner")).toEqual([...CLI_ADMIN_SCOPES]);
  });

  it("does NOT promise a viewer the write scopes the web console hardcodes", () => {
    expect(cliScopesForRole("viewer")).not.toContain("write:subscribers");
    expect(cliScopesForRole("editor")).not.toContain("send:transactional");
  });

  it("promises nothing for a role the server would refuse", () => {
    expect(cliScopesForRole("billing")).toEqual([]);
    expect(cliScopesForRole(null)).toEqual([]);
    expect(cliScopesForRole(undefined)).toEqual([]);
    expect(cliScopesForRole("")).toEqual([]);
  });

  it("normalises case, padding and the legacy member alias", () => {
    expect(normalizeCliScopeRole("  Owner ")).toBe("owner");
    expect(normalizeCliScopeRole("MEMBER")).toBe("viewer");
    expect(normalizeCliScopeRole("nonsense")).toBe("unknown");
  });
});

describe("cliGrantNeedsStepUp", () => {
  it("requires step-up for write-capable roles that are not mfa_satisfied", () => {
    expect(cliGrantNeedsStepUp("editor", false)).toBe(true);
    expect(cliGrantNeedsStepUp("admin", false)).toBe(true);
    expect(cliGrantNeedsStepUp("owner", false)).toBe(true);
  });

  it("exempts viewers, who only ever get read scopes", () => {
    expect(cliGrantNeedsStepUp("viewer", false)).toBe(false);
  });

  it("is satisfied once the session is stepped up", () => {
    expect(cliGrantNeedsStepUp("admin", true)).toBe(false);
  });
});

describe("scopeDisclosure", () => {
  it("labels every scope the server can grant in plain language", () => {
    const lines = scopeDisclosure(CLI_ADMIN_SCOPES);
    expect(lines).toHaveLength(CLI_ADMIN_SCOPES.length);
    for (const line of lines) expect(line.label).not.toBe(line.scope);
  });

  it("flags write scopes so the UI can weight them differently", () => {
    const lines = scopeDisclosure(["read:campaigns", "write:campaigns"]);
    expect(lines.map((l) => l.write)).toEqual([false, true]);
  });

  it("passes an unknown scope through verbatim rather than hiding it", () => {
    expect(scopeDisclosure(["admin:everything"])[0]).toEqual({
      scope: "admin:everything",
      label: "admin:everything",
      write: true,
    });
  });

  it("drops blanks and duplicates", () => {
    expect(
      scopeDisclosure(["read:reports", "read:reports", "", "  "]),
    ).toHaveLength(1);
  });

  it("summarises a refused role instead of claiming an empty grant", () => {
    expect(scopeSummary([])).toMatch(/cannot authorize/);
    expect(scopeSummary(CLI_READ_SCOPES)).toMatch(/3 permissions/);
    expect(scopeSummary(["read:reports"])).toMatch(/1 permission:/);
  });
});

describe("normalizeDeviceCode", () => {
  it.each([
    ["abcd1234", "ABCD-1234"],
    ["ABCD-1234", "ABCD-1234"],
    ["ab cd 12 34", "ABCD-1234"],
    ["abc", "ABC"],
    ["abcd", "ABCD"],
    ["abcde", "ABCD-E"],
    ["abcd1234extra", "ABCD-1234"],
    ["", ""],
  ])("normalises %s to %s", (input, expected) => {
    expect(normalizeDeviceCode(input)).toBe(expected);
  });

  it("accepts only a fully-formed code as submittable", () => {
    expect(isValidDeviceCode("ABCD-1234")).toBe(true);
    expect(isValidDeviceCode("ABCD-123")).toBe(false);
    expect(isValidDeviceCode("abcd-1234")).toBe(false);
  });
});
