// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ whoamiFresh: vi.fn() }));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  whoamiFresh: mocks.whoamiFresh,
}));

import type { MeResponse } from "@/lib/auth-api";
import {
  exactPrincipalKey,
  FreshPrincipalChangedError,
  verifyFreshExactPrincipal,
} from "@/lib/exact-principal";
import {
  abortAccountSecurityOperationForPrincipal,
  accountSecurityOperationIsCurrent,
  beginAccountSecurityOperation,
  finishAccountSecurityOperation,
} from "@/lib/account-security-operation";

const IDENTITY: MeResponse = {
  user_id: "usr_1",
  tenant_id: "tnt_1",
  email: "ada@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

beforeEach(() => vi.clearAllMocks());

describe("exact principal authority", () => {
  it("separates user, workspace, held role, effective role, and viewer mode", () => {
    const variants = [
      IDENTITY,
      { ...IDENTITY, user_id: "usr_2" },
      { ...IDENTITY, tenant_id: "tnt_2" },
      { ...IDENTITY, role: "admin" as const },
      { ...IDENTITY, effective_role: "viewer" as const },
      { ...IDENTITY, viewer_mode: true },
    ];
    expect(new Set(variants.map(exactPrincipalKey)).size).toBe(variants.length);
  });

  it("keeps account-recovery actions available to an unchanged viewer-mode principal", async () => {
    const viewer = {
      ...IDENTITY,
      effective_role: "viewer" as const,
      viewer_mode: true,
    };
    mocks.whoamiFresh.mockResolvedValue(viewer);
    await expect(verifyFreshExactPrincipal(viewer)).resolves.toEqual(viewer);
  });

  it("rejects a held-role change even when effective viewer authority looks unchanged", async () => {
    const opened = {
      ...IDENTITY,
      effective_role: "viewer" as const,
      viewer_mode: true,
    };
    mocks.whoamiFresh.mockResolvedValue({
      ...opened,
      role: "admin",
    });
    await expect(verifyFreshExactPrincipal(opened)).rejects.toBeInstanceOf(
      FreshPrincipalChangedError,
    );
  });

  it("forwards cancellation to the online-only fresh identity read", async () => {
    const controller = new AbortController();
    mocks.whoamiFresh.mockResolvedValue(IDENTITY);
    await verifyFreshExactPrincipal(IDENTITY, controller.signal);
    expect(mocks.whoamiFresh).toHaveBeenCalledWith(controller.signal);
  });
});

describe("account-security operation coordination", () => {
  it("serializes cross-card writes and only lets the owner release the lock", () => {
    const first = beginAccountSecurityOperation("principal-a", "totp");
    try {
      expect(() =>
        beginAccountSecurityOperation("principal-a", "passkey"),
      ).toThrow(/already in progress/i);
      abortAccountSecurityOperationForPrincipal("principal-b");
      expect(accountSecurityOperationIsCurrent(first, "principal-a")).toBe(
        true,
      );
    } finally {
      finishAccountSecurityOperation(first);
    }

    const second = beginAccountSecurityOperation("principal-a", "session");
    abortAccountSecurityOperationForPrincipal("principal-a");
    expect(accountSecurityOperationIsCurrent(second, "principal-a")).toBe(
      false,
    );
  });
});
