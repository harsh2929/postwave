// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import type { MeResponse } from "@/lib/auth-api";

const identity = {
  user_id: "user-a",
  tenant_id: "tenant-a",
  email: "a@example.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace A",
  workspace_slug: "workspace-a",
} satisfies MeResponse;

describe("admin read authority", () => {
  it("requires an effective owner/admin role outside viewer mode", () => {
    expect(canReadAdminData(identity)).toBe(true);
    expect(canReadAdminData({ ...identity, effective_role: "editor" })).toBe(
      false,
    );
    expect(canReadAdminData({ ...identity, viewer_mode: true })).toBe(false);
    expect(canReadAdminData(null)).toBe(false);
  });

  it("isolates cache identity by tenant, user, effective role, and viewer state", () => {
    expect(adminReadIdentityParts(identity)).toEqual([
      "tenant-a",
      "user-a",
      "owner",
      "durable-mode",
    ]);
    expect(adminReadIdentityParts({ ...identity, viewer_mode: true })).toEqual([
      "tenant-a",
      "user-a",
      "owner",
      "viewer-mode",
    ]);
  });
});
