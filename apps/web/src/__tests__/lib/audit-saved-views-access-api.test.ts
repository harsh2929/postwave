// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  auditAccessRequesterKey,
  auditFiltersFromSavedSnapshot,
  auditFiltersToSavedSnapshot,
  auditSavedViewDraftError,
  canManageAuditSavedViews,
  canReadRawAudit,
  createAuditAccessRequest,
  createAuditSavedView,
  deleteAuditSavedView,
  getAuditCapabilities,
  listAuditAccessRequests,
  listAuditSavedViews,
  normalizeAccessRequestNote,
  resolveAuditAccessRequest,
  sameAuditSavedViewRevision,
  updateAuditSavedView,
} from "@/lib/audit-saved-views-access-api";

const USER = "11111111-1111-7111-8111-111111111111";
const VIEW = "22222222-2222-4222-8222-222222222222";
const CREATED = "2026-08-30T10:00:00Z";
const UPDATED = "2026-08-30T10:01:00Z";
const RESOLVED = "2026-08-30T10:02:00Z";

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    userId: USER,
    userEmail: "viewer@example.test",
    note: "Review the campaign export evidence",
    status: "pending",
    createdAt: CREATED,
    ...overrides,
  };
}

function savedView(overrides: Record<string, unknown> = {}) {
  return {
    id: VIEW,
    name: "Monthly export review",
    description: "Exports in August",
    filters: {
      actorType: "human",
      actorLabel: "",
      actionQuery: "export",
      resourceType: "",
      resourceId: "",
      days: 0,
      category: "all",
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
    },
    createdAt: CREATED,
    updatedAt: UPDATED,
    createdBy: USER,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("audit capabilities and access requests", () => {
  it("strictly reconciles the audit-scope subset before granting UI capabilities", async () => {
    mocks.get.mockResolvedValue({
      scopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
      auditScopes: ["audit:read", "audit:read_pii", "audit:execute_actions"],
      isAdmin: true,
    });
    const capabilities = await getAuditCapabilities();
    expect(canReadRawAudit(capabilities)).toBe(true);
    expect(canManageAuditSavedViews(capabilities)).toBe(true);

    mocks.get.mockResolvedValue({
      scopes: ["audit:read"],
      auditScopes: ["audit:read", "audit:read_pii"],
      isAdmin: false,
    });
    await expect(getAuditCapabilities()).rejects.toThrow(/inconsistent/u);
  });

  it("bounds a viewer note by UTF-8 bytes and exact-binds the receipt to the session", async () => {
    expect(() => normalizeAccessRequestNote("é".repeat(501))).toThrow(
      /1,000 UTF-8 bytes/u,
    );
    mocks.post.mockResolvedValue({ request: request() });
    await expect(
      createAuditAccessRequest({
        note: " Review the campaign export evidence ",
        expectedUserId: USER,
        expectedEmail: "viewer@example.test",
      }),
    ).resolves.toMatchObject({ status: "pending", userId: USER });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit/access-requests",
      { note: "Review the campaign export evidence" },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );

    mocks.post.mockResolvedValue({
      request: request({ userId: "44444444-4444-4444-8444-444444444444" }),
    });
    await expect(
      createAuditAccessRequest({
        note: "",
        expectedUserId: USER,
        expectedEmail: "viewer@example.test",
      }),
    ).rejects.toThrow(/did not match this session/u);
  });

  it("rejects duplicate or cross-status review rows", async () => {
    mocks.get.mockResolvedValue({ items: [request(), request()] });
    await expect(listAuditAccessRequests("pending")).rejects.toThrow(/repeated/u);

    mocks.get.mockResolvedValue({ items: [request({ status: "denied" })] });
    await expect(listAuditAccessRequests("pending")).rejects.toThrow(
      /crossed the requested status/u,
    );
  });

  it("binds an admin decision to pending status, requester, creation time, and terminal readback", async () => {
    const parsed = request();
    mocks.get.mockResolvedValue({ items: [parsed] });
    const [pending] = await listAuditAccessRequests("pending");
    expect(pending).toBeDefined();
    if (!pending) return;
    mocks.patch.mockResolvedValue({
      request: request({ status: "approved", resolvedAt: RESOLVED }),
      grantVerified: true,
    });
    await expect(resolveAuditAccessRequest(pending, "approved")).resolves.toEqual({
      request: expect.objectContaining({ status: "approved", resolvedAt: RESOLVED }),
      grantVerified: true,
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/audit/access-requests/${pending.id}`,
      {
        status: "approved",
        expectedStatus: "pending",
        expectedRequesterKey: `user:${USER}`,
        expectedCreatedAt: CREATED,
      },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );

    mocks.patch.mockResolvedValue({
      request: request({ status: "approved", resolvedAt: RESOLVED }),
      grantVerified: false,
    });
    await expect(resolveAuditAccessRequest(pending, "approved")).rejects.toThrow(
      /did not match/u,
    );
  });

  it("uses a stable actor binding for API-key review rows", async () => {
    mocks.get.mockResolvedValue({
      items: [
        request({ userId: undefined, userEmail: undefined, actorLabel: "api-key:ops" }),
      ],
    });
    const [item] = await listAuditAccessRequests("pending");
    expect(item && auditAccessRequesterKey(item)).toBe("actor:api-key:ops");
  });
});

describe("shared audit saved views", () => {
  it("strictly parses bounded, unique, newest-first shared rows", async () => {
    mocks.get.mockResolvedValue({ views: [savedView()] });
    const result = await listAuditSavedViews();
    expect(result[0]).toMatchObject({
      id: VIEW,
      filters: { actionQuery: "export", since: "2026-08-01T00:00:00Z" },
    });
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/audit/saved-views", {
      signal: undefined,
    });

    mocks.get.mockResolvedValue({
      views: [savedView(), savedView({ name: "Duplicate identity" })],
    });
    await expect(listAuditSavedViews()).rejects.toThrow(/duplicates/u);
  });

  it("maps desktop relative/category snapshots and preserves exact web bounds", () => {
    expect(
      auditFiltersFromSavedSnapshot(
        { actorType: "user" as never, days: 7, category: "destructive" },
        Date.parse("2026-08-30T12:00:00Z"),
      ),
    ).toMatchObject({
      actorType: "human",
      action: "delete",
      since: "2026-08-23T00:00:00.000Z",
    });

    const wire = auditFiltersToSavedSnapshot({
      actorType: "agent",
      action: "audit.read",
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
    });
    expect(wire).toMatchObject({
      actorType: "agent",
      actionQuery: "audit.read",
      days: 0,
      category: "all",
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
    });
  });

  it("validates UTF-8 limits before online-only create", async () => {
    expect(
      auditSavedViewDraftError({
        name: "é".repeat(129),
        description: "",
        filters: {},
      }),
    ).toMatch(/name/u);
    expect(
      auditSavedViewDraftError({
        name: "Safe",
        description: "Monthly review",
        filters: {},
      }),
    ).toBeNull();

    mocks.post.mockResolvedValue(
      savedView({ name: "Safe", description: "Monthly review", filters: {} }),
    );
    await expect(
      createAuditSavedView({
        name: " Safe ",
        description: " Monthly review ",
        filters: {},
      }),
    ).resolves.toMatchObject({ name: "Safe" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/audit/saved-views",
      { name: "Safe", description: "Monthly review", filters: {} },
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });

  it("sends atomic revision preconditions for update and delete", async () => {
    mocks.get.mockResolvedValue({ views: [savedView()] });
    const [current] = await listAuditSavedViews();
    expect(current).toBeDefined();
    if (!current) return;
    const updated = { ...savedView(), name: "Renamed", updatedAt: RESOLVED };
    mocks.patch.mockResolvedValue(updated);
    const receipt = await updateAuditSavedView(current, {
      name: "Renamed",
      description: current.description,
      filters: current.filters,
    });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/audit/saved-views/${VIEW}`,
      expect.objectContaining({ expectedUpdatedAt: UPDATED, name: "Renamed" }),
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
    expect(sameAuditSavedViewRevision(receipt, { ...receipt })).toBe(true);

    mocks.delete.mockResolvedValue({ ok: true });
    await deleteAuditSavedView(receipt);
    expect(mocks.delete).toHaveBeenCalledWith(
      expect.stringContaining(`expected_updated_at=${encodeURIComponent(RESOLVED)}`),
      { requireOnline: true, maxAttempts: 1, signal: undefined },
    );
  });
});
