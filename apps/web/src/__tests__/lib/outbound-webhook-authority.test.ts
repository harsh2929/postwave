// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import {
  OutboundWebhookAuthorityError,
  assertFreshOutboundWebhookAdmin,
  canAdminOutboundWebhooks,
} from "@/lib/outbound-webhook-authority";

const identity = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  user_id: "user_1",
  tenant_id: "tenant_1",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Webhook workspace",
  workspace_slug: "webhook-workspace",
  ...overrides,
});

describe("outbound webhook authority", () => {
  it("allows durable owners/admins and denies editor, viewer, and viewer mode", () => {
    expect(canAdminOutboundWebhooks(identity())).toBe(true);
    expect(
      canAdminOutboundWebhooks(
        identity({ role: "admin", effective_role: "admin" }),
      ),
    ).toBe(true);
    expect(
      canAdminOutboundWebhooks(
        identity({
          role: "owner",
          effective_role: "viewer",
          viewer_mode: true,
        }),
      ),
    ).toBe(false);
    expect(
      canAdminOutboundWebhooks(
        identity({ role: "editor", effective_role: "editor" }),
      ),
    ).toBe(false);
    expect(
      canAdminOutboundWebhooks(
        identity({ role: "viewer", effective_role: "viewer" }),
      ),
    ).toBe(false);
  });

  it.each([
    ["user", { user_id: "user_2" }],
    ["tenant", { tenant_id: "tenant_2" }],
    ["effective role", { effective_role: "editor" as const }],
    ["viewer mode", { effective_role: "viewer" as const, viewer_mode: true }],
  ])("rejects a fresh %s mismatch", (_label, overrides) => {
    expect(() =>
      assertFreshOutboundWebhookAdmin(identity(), identity(overrides)),
    ).toThrow(OutboundWebhookAuthorityError);
  });
});
