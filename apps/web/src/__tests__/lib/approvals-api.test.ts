// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the approvals inbox client helpers (node env).

import { beforeEach, describe, it, expect, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import {
  approveApproval,
  createDelegation,
  getApproval,
  getEscalationPolicy,
  isSameApprovalTarget,
  listApprovals,
  listDelegations,
  rejectApproval,
  revokeDelegation,
  requesterLabel,
  isActionable,
  statusVariant,
  updateEscalationPolicy,
  type Approval,
} from "@/lib/approvals-api";

beforeEach(() => {
  apiMocks.delete.mockReset();
  apiMocks.get.mockReset();
  apiMocks.post.mockReset();
  apiMocks.put.mockReset();
});

function approval(over: Partial<Approval>): Approval {
  return {
    id: "a1",
    tenantId: "t",
    resourceType: "campaign",
    resourceId: "c1",
    status: "pending",
    requestedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    ...over,
  };
}

describe("requesterLabel", () => {
  it("prefers actor label, falls back to user id then actor type", () => {
    expect(requesterLabel(approval({ requestedByActorLabel: "Ada" }))).toBe(
      "Ada",
    );
    expect(requesterLabel(approval({ requestedByUserId: "user_9" }))).toBe(
      "user_9",
    );
    expect(requesterLabel(approval({ requestedByActorType: "api_key" }))).toBe(
      "api_key",
    );
    expect(requesterLabel(approval({}))).toBe("Unknown");
  });
});

describe("isActionable", () => {
  it("requires pending, recognized resource, and a live review window", () => {
    expect(isActionable(approval({ status: "pending" }))).toBe(true);
    expect(isActionable(approval({ status: "approved" }))).toBe(false);
    expect(isActionable(approval({ status: "rejected" }))).toBe(false);
    expect(isActionable(approval({ expiresAt: "2020-01-01T00:00:00Z" }))).toBe(
      false,
    );
    expect(isActionable(approval({ resourceType: "unverified" }))).toBe(false);
  });
});

describe("statusVariant", () => {
  it("maps statuses to badge variants", () => {
    expect(statusVariant("approved")).toBe("success");
    expect(statusVariant("pending")).toBe("warning");
    expect(statusVariant("rejected")).toBe("destructive");
    expect(statusVariant("expired")).toBe("secondary");
  });
});

describe("protected approvals transport", () => {
  it("makes list and exact reads online-only, single-attempt, and abortable", async () => {
    const controller = new AbortController();
    apiMocks.get
      .mockResolvedValueOnce({ approvals: [] })
      .mockRejectedValueOnce(new Error("transport stopped after path capture"));

    await listApprovals("all", 200, {
      expectedTenantId: "t",
      signal: controller.signal,
    });
    await expect(
      getApproval("approval/with/slash", {
        expectedTenantId: "t",
        signal: controller.signal,
      }),
    ).rejects.toThrow("transport stopped");

    const options = {
      cache: "no-store",
      maxAttempts: 1,
      requireOnline: true,
      signal: controller.signal,
    };
    expect(apiMocks.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/approvals?limit=200",
      options,
    );
    expect(apiMocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/approvals/approval%2Fwith%2Fslash",
      options,
    );
  });

  it("decodes bounded canonical records and fails closed on unknown states", async () => {
    apiMocks.get
      .mockResolvedValueOnce({
        approvals: [approval({})],
        items: [approval({})],
      })
      .mockResolvedValueOnce({
        ...approval({}),
        resourceType: "future_resource",
        status: "future_status",
      });

    await expect(
      listApprovals("all", 200, { expectedTenantId: "t" }),
    ).resolves.toEqual([approval({})]);
    await expect(
      getApproval("a1", { expectedTenantId: "t" }),
    ).resolves.toMatchObject({
      id: "a1",
      resourceType: "unverified",
      status: "unverified",
    });
  });

  it.each([
    [
      "foreign-tenant",
      { approvals: [approval({ tenantId: "other" })] },
      "foreign-tenant",
    ],
    [
      "invalid date",
      { approvals: [approval({ expiresAt: "2026-02-31T00:00:00Z" })] },
      "invalid-record",
    ],
    [
      "duplicate IDs",
      { approvals: [approval({}), approval({ resourceId: "c2" })] },
      "duplicate-identity",
    ],
    [
      "conflicting aliases",
      {
        approvals: [approval({})],
        items: [approval({ resourceId: "c2" })],
      },
      "conflicting-list-keys",
    ],
    [
      "oversized list",
      {
        approvals: Array.from({ length: 201 }, (_, index) =>
          approval({ id: `a${index}` }),
        ),
      },
      "too-many-records",
    ],
    [
      "oversized record",
      {
        approvals: [
          {
            ...approval({}),
            ...Object.fromEntries(
              Array.from({ length: 33 }, (_, index) => [`extra${index}`, true]),
            ),
          },
        ],
      },
      "invalid-record",
    ],
  ])("rejects %s", async (_label, response, reason) => {
    apiMocks.get.mockResolvedValueOnce(response);
    await expect(
      listApprovals("all", 200, { expectedTenantId: "t" }),
    ).rejects.toMatchObject({ name: "ApprovalContractError", reason });
  });

  it("rejects a detail response whose identity differs from the requested path", async () => {
    apiMocks.get.mockResolvedValueOnce(approval({ id: "a2" }));
    await expect(
      getApproval("a1", { expectedTenantId: "t" }),
    ).rejects.toMatchObject({
      name: "ApprovalContractError",
      reason: "identity-mismatch",
    });
  });

  it("encodes every dynamic mutation segment exactly once and preserves one stable key", async () => {
    const controller = new AbortController();
    const options = {
      idempotencyKey: " 018f47f2-approval-intent ",
      signal: controller.signal,
    };
    const transportOptions = {
      idempotencyKey: "018f47f2-approval-intent",
      signal: controller.signal,
      maxAttempts: 1,
      requireOnline: true,
    };
    apiMocks.post.mockResolvedValue({ ok: true });
    apiMocks.delete.mockResolvedValue({ ok: true });

    await approveApproval("approval/%2Fchild", "audit note", options);
    await rejectApproval("approval/%2Fchild", "reason", options);
    await revokeDelegation("delegation/%2Fchild", options);

    expect(apiMocks.post).toHaveBeenNthCalledWith(
      1,
      "/api/v1/approvals/approval%2F%252Fchild/approve",
      { notes: "audit note" },
      transportOptions,
    );
    expect(apiMocks.post).toHaveBeenNthCalledWith(
      2,
      "/api/v1/approvals/approval%2F%252Fchild/reject",
      { notes: "reason" },
      transportOptions,
    );
    expect(apiMocks.delete).toHaveBeenCalledWith(
      "/api/v1/approvals/delegations/delegation%2F%252Fchild",
      transportOptions,
    );
  });

  it("keeps dormant governance reads and writes fail-safe at the client boundary", async () => {
    const controller = new AbortController();
    const options = {
      idempotencyKey: "018f47f2-governance-intent",
      signal: controller.signal,
    };
    apiMocks.get
      .mockResolvedValueOnce({ delegations: [] })
      .mockResolvedValueOnce({
        escalateAfterHours: 24,
        notifyOwners: true,
      });
    apiMocks.post.mockResolvedValue({ id: "delegation-1" });
    apiMocks.put.mockResolvedValue({
      escalateAfterHours: 24,
      notifyOwners: true,
    });

    await listDelegations({ signal: controller.signal });
    await getEscalationPolicy({ signal: controller.signal });
    await createDelegation({ fromUserId: "from", toUserId: "to" }, options);
    await updateEscalationPolicy(
      { escalateAfterHours: 24, notifyOwners: true },
      options,
    );

    const readOptions = {
      cache: "no-store",
      maxAttempts: 1,
      requireOnline: true,
      signal: controller.signal,
    };
    expect(apiMocks.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/approvals/delegations",
      readOptions,
    );
    expect(apiMocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/approvals/escalation-policy",
      readOptions,
    );
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/approvals/delegations",
      { fromUserId: "from", toUserId: "to" },
      { ...options, maxAttempts: 1, requireOnline: true },
    );
    expect(apiMocks.put).toHaveBeenCalledWith(
      "/api/v1/approvals/escalation-policy",
      { escalateAfterHours: 24, notifyOwners: true },
      { ...options, maxAttempts: 1, requireOnline: true },
    );
    expect(() =>
      updateEscalationPolicy(
        { escalateAfterHours: null, notifyOwners: false },
        { idempotencyKey: "" },
      ),
    ).toThrow("idempotency key is required");
  });
});

describe("isSameApprovalTarget", () => {
  it("binds every stable principal and resource field", () => {
    const opened = approval({
      id: "approval-1",
      tenantId: "tenant-1",
      requestedByActorLabel: "Ada",
      requestedByActorType: "user",
      requestedByApiKeyId: "key-1",
      requestedByUserId: "user-2",
      expiresAt: "2026-06-28T12:00:00.000Z",
      contentHash: "revision-1",
      consumedAt: null,
    });
    expect(
      isSameApprovalTarget(opened, { ...opened, status: "rejected" }),
    ).toBe(true);
    expect(
      isSameApprovalTarget(opened, {
        ...opened,
        resourceId: "different-resource",
      }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, { ...opened, tenantId: "other-tenant" }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, {
        ...opened,
        requestedByUserId: "other-requester",
      }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, { ...opened, contentHash: "revision-2" }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, {
        ...opened,
        expiresAt: "2026-06-29T12:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, {
        ...opened,
        requestedByApiKeyId: "key-2",
      }),
    ).toBe(false);
    expect(
      isSameApprovalTarget(opened, {
        ...opened,
        consumedAt: "2026-06-27T12:03:00.000Z",
      }),
    ).toBe(false);
  });
});
