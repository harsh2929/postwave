// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals-api";
import type { MeResponse } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  getApproval: vi.fn(),
  rejectApproval: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/approvals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approvals-api")>()),
  getApproval: mocks.getApproval,
  rejectApproval: mocks.rejectApproval,
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));

import {
  recordVerifiedRejection,
  type RejectionAttempt,
} from "@/lib/approval-rejection";

const identity: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

const pending: Approval = {
  id: "approval-1",
  tenantId: "tenant-1",
  resourceType: "campaign",
  resourceId: "campaign-1",
  requestedByUserId: "requester-1",
  status: "pending",
  requestedAt: "2026-09-04T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};

const rejected: Approval = {
  ...pending,
  status: "rejected",
  decidedAt: "2026-09-04T00:05:00Z",
  decidedByUserId: identity.user_id,
  notes: "Needs changes",
};

function attempt(): RejectionAttempt {
  return {
    fingerprint: "frozen-intent",
    idempotencyKey: "018f47f2-stable-rejection",
    requestStarted: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.whoamiFresh.mockResolvedValue(identity);
});

describe("verified approval rejection", () => {
  it.each([
    ["tenant", { tenantId: "tenant-2" }],
    ["status", { status: "approved" as const }],
    ["decision timestamp", { decidedAt: null }],
    ["decider", { decidedByUserId: "user-2" }],
    ["notes", { notes: "Different reason" }],
  ])(
    "rejects a %s-mismatched stored decision receipt",
    async (_name, patch) => {
      mocks.getApproval
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce({ ...rejected, ...patch });
      mocks.rejectApproval.mockResolvedValue({ ok: true });

      await expect(
        recordVerifiedRejection({
          approval: pending,
          identity,
          notes: "Needs changes",
          attempt: attempt(),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("exact stored decision could not be verified");

      expect(mocks.rejectApproval).toHaveBeenCalledOnce();
      expect(mocks.rejectApproval).toHaveBeenCalledWith(
        pending.id,
        "Needs changes",
        expect.objectContaining({
          idempotencyKey: "018f47f2-stable-rejection",
          signal: expect.any(AbortSignal),
        }),
      );
    },
  );

  it("does not accept an explicit false mutation acknowledgement", async () => {
    mocks.getApproval.mockResolvedValueOnce(pending);
    mocks.rejectApproval.mockResolvedValue({ ok: false });

    await expect(
      recordVerifiedRejection({
        approval: pending,
        identity,
        notes: "Needs changes",
        attempt: attempt(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("outcome is unknown");
    expect(mocks.getApproval).toHaveBeenCalledOnce();
  });

  it("reconciles a terminal mutation race instead of offering a blind retry", async () => {
    const decidedElsewhere: Approval = {
      ...pending,
      status: "approved",
      decidedByUserId: "user-2",
    };
    mocks.getApproval
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(decidedElsewhere);
    mocks.rejectApproval.mockRejectedValue(
      new ApiError("approval already decided", 409, undefined, {
        code: "not_pending",
      }),
    );

    await expect(
      recordVerifiedRejection({
        approval: pending,
        identity,
        notes: "Needs changes",
        attempt: attempt(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "ApprovalTargetChangedError",
      latest: decidedElsewhere,
      reason: "no-longer-actionable",
    });
    expect(mocks.getApproval).toHaveBeenCalledTimes(2);
  });

  it("stops after an aborted in-flight mutation even if transport resolves", async () => {
    const mutation = deferred<{ ok: boolean }>();
    const controller = new AbortController();
    mocks.getApproval.mockResolvedValueOnce(pending);
    mocks.rejectApproval.mockReturnValueOnce(mutation.promise);

    const result = recordVerifiedRejection({
      approval: pending,
      identity,
      notes: "Needs changes",
      attempt: attempt(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.rejectApproval).toHaveBeenCalledOnce());
    controller.abort();
    mutation.resolve({ ok: true });

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.getApproval).toHaveBeenCalledOnce();
  });

  it("does not publish a late readback after its signal was aborted", async () => {
    const readback = deferred<Approval>();
    const controller = new AbortController();
    mocks.getApproval
      .mockResolvedValueOnce(pending)
      .mockReturnValueOnce(readback.promise);
    mocks.rejectApproval.mockResolvedValue({ ok: true });

    const result = recordVerifiedRejection({
      approval: pending,
      identity,
      notes: "Needs changes",
      attempt: attempt(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.getApproval).toHaveBeenCalledTimes(2));
    controller.abort();
    readback.resolve(rejected);

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
