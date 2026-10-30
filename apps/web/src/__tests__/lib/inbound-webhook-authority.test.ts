// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import type { AuthRole, MeResponse } from "@/lib/auth-api";
import {
  ADMIN_WRITE_AUTHORITY_CHANGED_MESSAGE,
  INBOUND_WEBHOOK_BULK_CONCURRENCY,
  assertFreshInboundWebhookAdmin,
  canAdminInboundWebhooks,
  settleInboundWebhookBatch,
} from "@/lib/inbound-webhook-authority";

function identity(
  role: AuthRole,
  overrides: Partial<MeResponse> = {},
): MeResponse {
  return {
    user_id: "user_1",
    tenant_id: "tenant_1",
    email: "operator@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Inbound QA",
    workspace_slug: "inbound-qa",
    ...overrides,
  };
}

describe("inbound webhook admin authority", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["editor", false],
    ["viewer", false],
  ] as const)("maps effective %s authority to %s", (role, expected) => {
    expect(canAdminInboundWebhooks(identity(role))).toBe(expected);
  });

  it("honors effective role while viewer mode always removes admin authority", () => {
    expect(
      canAdminInboundWebhooks(identity("owner", { viewer_mode: true })),
    ).toBe(false);
    expect(
      canAdminInboundWebhooks(identity("owner", { effective_role: "editor" })),
    ).toBe(false);
    expect(
      canAdminInboundWebhooks(
        identity("viewer", { effective_role: "admin", viewer_mode: false }),
      ),
    ).toBe(true);
  });

  it.each([
    ["different user", { user_id: "user_2" }],
    ["different tenant", { tenant_id: "tenant_2" }],
    ["role downgrade", { role: "editor", effective_role: "editor" }],
    ["viewer mode", { viewer_mode: true }],
  ] satisfies Array<[string, Partial<MeResponse>]>)(
    "rejects a stale action after %s",
    (_label, freshOverrides) => {
      const opened = identity("admin");
      expect(() =>
        assertFreshInboundWebhookAdmin(
          opened,
          identity("admin", freshOverrides),
        ),
      ).toThrow(ADMIN_WRITE_AUTHORITY_CHANGED_MESSAGE);
    },
  );

  it("accepts the unchanged owner or administrator identity", () => {
    expect(() =>
      assertFreshInboundWebhookAdmin(identity("owner"), identity("owner")),
    ).not.toThrow();
    expect(() =>
      assertFreshInboundWebhookAdmin(identity("admin"), identity("admin")),
    ).not.toThrow();
  });

  it("bounds bulk request pressure while preserving ordered row outcomes", async () => {
    let active = 0;
    let peak = 0;
    const results = await settleInboundWebhookBatch(
      Array.from({ length: 11 }, (_, index) => index),
      async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        if (index === 6) throw new Error("row failed");
        return index * 2;
      },
    );

    expect(peak).toBeLessThanOrEqual(INBOUND_WEBHOOK_BULK_CONCURRENCY);
    expect(results[2]).toEqual({ status: "fulfilled", value: 4 });
    expect(results[6]?.status).toBe("rejected");
    expect(results).toHaveLength(11);
  });
});
