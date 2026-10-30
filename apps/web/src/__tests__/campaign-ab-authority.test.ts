// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  assertFreshCampaignAdminAuthority,
  assertFreshCampaignWriteAuthority,
  canAdminCampaigns,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import type { MeResponse } from "@/lib/auth-api";

const identity = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.com",
  role: "editor",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
  ...overrides,
});

describe("campaign A/B authority", () => {
  it("allows campaign writers but never viewer mode", () => {
    for (const role of ["owner", "admin", "editor"] as const) {
      expect(canWriteCampaigns(identity({ role }))).toBe(true);
    }
    expect(canWriteCampaigns(identity({ role: "viewer" }))).toBe(false);
    expect(canWriteCampaigns(identity({ viewer_mode: true }))).toBe(false);
    expect(
      canWriteCampaigns(identity({ role: "owner", effective_role: "viewer" })),
    ).toBe(false);
  });

  it("limits campaign admin operations to unchanged owners and admins", () => {
    for (const role of ["owner", "admin"] as const) {
      const opened = identity({ role, effective_role: role });
      expect(canAdminCampaigns(opened)).toBe(true);
      expect(() =>
        assertFreshCampaignAdminAuthority(opened, identity({ role })),
      ).not.toThrow();
    }
    expect(canAdminCampaigns(identity({ role: "editor" }))).toBe(false);
    expect(
      canAdminCampaigns(identity({ role: "admin", viewer_mode: true })),
    ).toBe(false);
    expect(() =>
      assertFreshCampaignAdminAuthority(
        identity({ role: "admin" }),
        identity({ role: "editor" }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "campaign_admin_authority_changed" }),
    );
  });

  it("requires a fresh, unchanged user, workspace, role, and viewer state", () => {
    const opened = identity();
    expect(() =>
      assertFreshCampaignWriteAuthority(opened, identity()),
    ).not.toThrow();

    for (const fresh of [
      identity({ user_id: "user-2" }),
      identity({ tenant_id: "tenant-2" }),
      identity({ role: "viewer" }),
      identity({ viewer_mode: true }),
      identity({ effective_role: "viewer" }),
    ]) {
      expect(() =>
        assertFreshCampaignWriteAuthority(opened, fresh),
      ).toThrowError(
        expect.objectContaining({ code: "campaign_write_authority_changed" }),
      );
    }
  });
});
