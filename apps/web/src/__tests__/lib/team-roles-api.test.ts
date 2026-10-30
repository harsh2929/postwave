// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the role × scope matrix client helpers (node env).

import { describe, it, expect } from "vitest";

import {
  dedupeScopes,
  toggleScope,
  scopeLabel,
} from "@/lib/team-roles-api";

describe("dedupeScopes", () => {
  it("trims, drops empties, dedupes preserving order", () => {
    expect(dedupeScopes([" audit:read ", "audit:read", "", "audit:write"])).toEqual(
      ["audit:read", "audit:write"],
    );
  });
});

describe("toggleScope", () => {
  it("adds when enabled and removes when disabled", () => {
    expect(toggleScope(["audit:read"], "audit:write", true).sort()).toEqual([
      "audit:read",
      "audit:write",
    ]);
    expect(toggleScope(["audit:read", "audit:write"], "audit:write", false)).toEqual(
      ["audit:read"],
    );
  });

  it("is idempotent (no duplicate when re-adding)", () => {
    expect(toggleScope(["audit:read"], "audit:read", true)).toEqual([
      "audit:read",
    ]);
  });
});

describe("scopeLabel", () => {
  it("strips the namespace and title-cases the tail", () => {
    expect(scopeLabel("audit:read")).toBe("Read");
    expect(scopeLabel("audit:role_admin")).toBe("Role Admin");
    expect(scopeLabel("plain")).toBe("Plain");
  });
});
