// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import {
  CommerceAuthorityError,
  assertFreshCommerceAdmin,
  canAdminCommerce,
} from "@/lib/commerce-authority";

const identity = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  user_id: "user_1",
  tenant_id: "tenant_1",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Commerce workspace",
  workspace_slug: "commerce-workspace",
  ...overrides,
});

describe("commerce authority", () => {
  it("allows durable owners/admins and denies editor, viewer, and viewer mode", () => {
    expect(canAdminCommerce(identity())).toBe(true);
    expect(
      canAdminCommerce(identity({ role: "admin", effective_role: "admin" })),
    ).toBe(true);
    expect(
      canAdminCommerce(
        identity({
          role: "owner",
          effective_role: "viewer",
          viewer_mode: true,
        }),
      ),
    ).toBe(false);
    expect(
      canAdminCommerce(identity({ role: "editor", effective_role: "editor" })),
    ).toBe(false);
    expect(
      canAdminCommerce(identity({ role: "viewer", effective_role: "viewer" })),
    ).toBe(false);
  });

  it.each([
    ["user", { user_id: "user_2" }],
    ["tenant", { tenant_id: "tenant_2" }],
    ["held role", { role: "admin" as const, effective_role: "admin" as const }],
    ["effective role", { effective_role: "editor" as const }],
    ["viewer mode", { effective_role: "viewer" as const, viewer_mode: true }],
  ])("rejects a fresh %s mismatch", (_label, overrides) => {
    expect(() =>
      assertFreshCommerceAdmin(identity(), identity(overrides)),
    ).toThrow(CommerceAuthorityError);
  });
});
