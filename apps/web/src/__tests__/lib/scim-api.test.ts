// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the SCIM admin client helpers (node env).

import { describe, it, expect } from "vitest";

import {
  normalizeRoleMappingInput,
  isTokenActive,
  type ScimToken,
} from "@/lib/scim-api";

describe("normalizeRoleMappingInput", () => {
  it("trims group, lower-cases + validates role, defaults precedence", () => {
    const out = normalizeRoleMappingInput({
      group_name: "  Engineers ",
      role: "ADMIN",
    });
    expect(out).toEqual({ group_name: "Engineers", role: "admin", precedence: 0 });
  });

  it("rounds and accepts in-range precedence", () => {
    const out = normalizeRoleMappingInput({
      group_name: "g",
      role: "viewer",
      precedence: 10.7,
    });
    expect(out.precedence).toBe(11);
  });

  it("rejects empty group, bad role, out-of-range precedence", () => {
    expect(() =>
      normalizeRoleMappingInput({ group_name: "", role: "admin" }),
    ).toThrow(/group/i);
    expect(() =>
      normalizeRoleMappingInput({ group_name: "g", role: "superuser" }),
    ).toThrow(/role/i);
    expect(() =>
      normalizeRoleMappingInput({ group_name: "g", role: "admin", precedence: 9999 }),
    ).toThrow(/precedence/i);
  });
});

describe("isTokenActive", () => {
  const base: ScimToken = {
    id: "1",
    prefix: "scim_ab",
    description: "",
    created_at: "",
  };
  it("is false once revoked", () => {
    expect(isTokenActive(base)).toBe(true);
    expect(isTokenActive({ ...base, revoked_at: "2026-01-01T00:00:00Z" })).toBe(
      false,
    );
  });
});
