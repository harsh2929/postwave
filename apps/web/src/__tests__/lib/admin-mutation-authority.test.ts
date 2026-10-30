// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const whoamiFresh = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-api", () => ({
  whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import type { MeResponse } from "@/lib/auth-api";

const OPENED: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

beforeEach(() => vi.clearAllMocks());

describe("fresh admin mutation authority", () => {
  it("accepts the same owner identity and forwards cancellation", async () => {
    const signal = new AbortController().signal;
    whoamiFresh.mockResolvedValue(OPENED);
    await expect(verifyFreshAdminAuthority(OPENED, signal)).resolves.toBe(
      OPENED,
    );
    expect(whoamiFresh).toHaveBeenCalledWith(signal);
  });

  it.each([
    ["user switch", { user_id: "another-user" }],
    ["workspace switch", { tenant_id: "another-tenant" }],
    ["role change", { role: "viewer" }],
    ["viewer mode", { viewer_mode: true }],
  ])("fails closed on %s", async (_label, change) => {
    whoamiFresh.mockResolvedValue({ ...OPENED, ...change });
    await expect(verifyFreshAdminAuthority(OPENED)).rejects.toThrow();
  });
});
