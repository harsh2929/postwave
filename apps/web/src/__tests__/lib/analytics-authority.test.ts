// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

import {
  abortAnalyticsWrite,
  analyticsCanWriteCampaigns,
  analyticsAuthorityFrom,
  beginAnalyticsWrite,
  endAnalyticsWrite,
  verifyAnalyticsAuthority,
} from "@/lib/analytics-authority";

const identity = {
  user_id: "user-a",
  tenant_id: "tenant-a",
  email: "owner@example.com",
  role: "owner" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "A",
  workspace_slug: "a",
};

afterEach(() => {
  abortAnalyticsWrite();
  vi.clearAllMocks();
});

describe("analytics authority", () => {
  it("keys authority by the exact principal, effective role, and viewer state", () => {
    expect(analyticsAuthorityFrom(identity)).toMatchObject({
      tenantId: "tenant-a",
      userId: "user-a",
      role: "admin",
      viewerMode: false,
      authorityKey: "tenant-a:user-a:admin:false",
    });
  });

  it("rejects viewer mode before issuing a fresh-auth transport", async () => {
    const authority = analyticsAuthorityFrom({
      ...identity,
      effective_role: "viewer",
      viewer_mode: true,
    });

    await expect(
      verifyAnalyticsAuthority(authority, new AbortController().signal),
    ).rejects.toThrow(/viewer mode is read-only/i);
    expect(mocks.whoamiFresh).not.toHaveBeenCalled();
  });

  it("does not grant the billable AI action to a durable viewer", () => {
    expect(
      analyticsCanWriteCampaigns(
        analyticsAuthorityFrom({
          ...identity,
          role: "viewer",
          effective_role: "viewer",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a tenant, user, role, or viewer-state change from a fresh read", async () => {
    const authority = analyticsAuthorityFrom(identity);
    mocks.whoamiFresh.mockResolvedValue({
      ...identity,
      tenant_id: "tenant-b",
    });

    await expect(
      verifyAnalyticsAuthority(authority, new AbortController().signal),
    ).rejects.toThrow(/access changed/i);
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
  });

  it("uses an owned synchronous lock that an older completion cannot release", () => {
    const first = beginAnalyticsWrite();
    expect(first).toBeInstanceOf(AbortController);
    expect(beginAnalyticsWrite()).toBeNull();

    abortAnalyticsWrite();
    const second = beginAnalyticsWrite();
    expect(second).toBeInstanceOf(AbortController);
    expect(second).not.toBe(first);

    endAnalyticsWrite(first!);
    expect(beginAnalyticsWrite()).toBeNull();

    endAnalyticsWrite(second!);
    expect(beginAnalyticsWrite()).toBeInstanceOf(AbortController);
  });
});
