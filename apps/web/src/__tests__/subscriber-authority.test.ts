// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ whoamiFresh: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

import {
  reauthorizeSubscriberMutation,
  sameSubscriberAuthority,
  subscriberAuthorityFromMe,
} from "@/lib/subscriber-authority";

const me = {
  tenant_id: "tenant-a",
  user_id: "user-a",
  email: "operator@example.test",
  role: "editor" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace A",
  workspace_slug: "workspace-a",
};

beforeEach(() => mocks.whoamiFresh.mockReset());

describe("subscriber mutation authority", () => {
  it("fails closed for viewer mode even when the underlying role can write", () => {
    expect(subscriberAuthorityFromMe({ ...me, viewer_mode: true })).toBeNull();
    expect(
      subscriberAuthorityFromMe({ ...me, effective_role: "viewer" }),
    ).toBeNull();
  });

  it("matches write:subscribers by allowing editors outside viewer mode", () => {
    expect(subscriberAuthorityFromMe(me)).toEqual({
      tenantId: "tenant-a",
      userId: "user-a",
      role: "editor",
    });
  });

  it("binds tenant, user, effective role, and viewer state", () => {
    const authority = subscriberAuthorityFromMe(me);
    if (!authority) throw new Error("missing authority");
    expect(sameSubscriberAuthority(authority, me)).toBe(true);
    expect(
      sameSubscriberAuthority(authority, { ...me, tenant_id: "tenant-b" }),
    ).toBe(false);
    expect(
      sameSubscriberAuthority(authority, { ...me, user_id: "user-b" }),
    ).toBe(false);
    expect(sameSubscriberAuthority(authority, { ...me, role: "admin" })).toBe(
      false,
    );
    expect(
      sameSubscriberAuthority(authority, { ...me, viewer_mode: true }),
    ).toBe(false);
  });

  it("reauthorizes against a fresh whoami response immediately before/after writes", async () => {
    const authority = subscriberAuthorityFromMe(me);
    if (!authority) throw new Error("missing authority");
    mocks.whoamiFresh.mockResolvedValueOnce({
      ...me,
      tenant_id: "tenant-b",
    });
    await expect(reauthorizeSubscriberMutation(authority)).rejects.toThrow(
      "Workspace access changed",
    );
  });
});
