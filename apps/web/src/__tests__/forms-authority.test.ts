// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { AuthRole, MeResponse } from "@/lib/auth-api";
import {
  assertFreshFormAuthority,
  canAdminForms,
  canWriteForms,
  FormAuthorityError,
} from "@/lib/forms-authority";

function identity(
  role: AuthRole,
  overrides: Partial<MeResponse> = {},
): MeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "operator@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
    ...overrides,
  };
}

describe("forms authority", () => {
  it.each(["owner", "admin", "editor"] as const)(
    "allows %s to write form configuration",
    (role) => expect(canWriteForms(identity(role))).toBe(true),
  );

  it("keeps destructive and submission authority owner/admin-only", () => {
    expect(canAdminForms(identity("owner"))).toBe(true);
    expect(canAdminForms(identity("admin"))).toBe(true);
    expect(canAdminForms(identity("editor"))).toBe(false);
    expect(canAdminForms(identity("viewer"))).toBe(false);
  });

  it("fails closed for effective viewers and viewer mode", () => {
    expect(canWriteForms(identity("owner", { effective_role: "viewer" }))).toBe(
      false,
    );
    expect(canWriteForms(identity("owner", { viewer_mode: true }))).toBe(false);
    expect(canAdminForms(identity("owner", { viewer_mode: true }))).toBe(false);
  });

  it.each([
    ["user", identity("editor", { user_id: "user-2" })],
    ["tenant", identity("editor", { tenant_id: "tenant-2" })],
    ["effective role", identity("viewer")],
    ["viewer mode", identity("editor", { viewer_mode: true })],
  ])("rejects stale write authority when %s changes", (_label, fresh) => {
    expect(() =>
      assertFreshFormAuthority(identity("editor"), fresh, "write"),
    ).toThrow(FormAuthorityError);
  });

  it("rejects an editor at the admin boundary even when identity is stable", () => {
    expect(() =>
      assertFreshFormAuthority(identity("editor"), identity("editor"), "admin"),
    ).toThrow(FormAuthorityError);
  });
});
