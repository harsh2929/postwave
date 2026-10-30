// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { AuthRole, MeResponse } from "@/lib/auth-api";
import {
  assertFreshLandingPageAdminAuthority,
  canAdminLandingPages,
  LandingPageAuthorityError,
} from "@/lib/landing-page-authority";

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

describe("landing-page admin authority", () => {
  it.each(["owner", "admin"] as const)("allows %s", (role) => {
    expect(canAdminLandingPages(identity(role))).toBe(true);
  });

  it.each(["editor", "viewer"] as const)("denies %s", (role) => {
    expect(canAdminLandingPages(identity(role))).toBe(false);
  });

  it("fails closed for effective viewer and viewer-mode sessions", () => {
    expect(
      canAdminLandingPages(identity("owner", { effective_role: "viewer" })),
    ).toBe(false);
    expect(canAdminLandingPages(identity("owner", { viewer_mode: true }))).toBe(
      false,
    );
  });

  it.each([
    ["user", identity("admin", { user_id: "user-2" })],
    ["tenant", identity("admin", { tenant_id: "tenant-2" })],
    ["effective role", identity("editor")],
    ["viewer mode", identity("admin", { viewer_mode: true })],
  ])("rejects stale authority when %s changes", (_label, fresh) => {
    expect(() =>
      assertFreshLandingPageAdminAuthority(identity("admin"), fresh),
    ).toThrow(LandingPageAuthorityError);
  });

  it("accepts an unchanged owner/admin identity", () => {
    const opened = identity("admin");
    expect(() =>
      assertFreshLandingPageAdminAuthority(opened, { ...opened }),
    ).not.toThrow();
  });
});
