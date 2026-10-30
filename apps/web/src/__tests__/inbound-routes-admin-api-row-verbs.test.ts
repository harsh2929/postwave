// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: apiMocks,
}));

import {
  InboundRouteContractError,
  InboundRouteInputError,
  inboundRouteEnabledDraft,
  listInboundRouteMatchesStrict,
  reorderInboundRoutesStrict,
  updateInboundRouteStrict,
  type InboundRoute,
} from "@/lib/inbound-routes-admin-api";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ROUTE_ID = "00000000-0000-4000-8000-000000000002";
const OTHER_ID = "00000000-0000-4000-8000-000000000003";

function route(overrides: Partial<InboundRoute> = {}): InboundRoute {
  return {
    id: ROUTE_ID,
    name: "Support route",
    priority: 100,
    stopOnMatch: true,
    enabled: false,
    matchRecipient: "support@*",
    matchSubjectPrefix: "Re:",
    matchFromDomain: "example.com",
    actions: [
      {
        kind: "webhook",
        url: "https://hooks.example.test/inbound",
        extra: { custom: "preserved" },
        hasStoredHmacSecret: true,
        sourceIndex: 0,
      },
      {
        kind: "tag",
        tag: "vip",
        extra: {},
        hasStoredHmacSecret: false,
        sourceIndex: 1,
      },
    ],
    lastMatchedAt: "2026-08-30T10:00:00Z",
    matchCount: 7,
    actionRetryMax: 2,
    actionRetryBackoffSeconds: 5,
    updatedAt: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

function wireMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    route_id: ROUTE_ID,
    inbound_email_id: 99,
    recipient: "support@example.test",
    subject: "Re: invoice 42",
    from_email: "customer@example.test",
    matched_at: "2026-08-30T09:30:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("row-level enable switch (deliverability-28)", () => {
  it("PATCHes the full reviewed definition with only enabled flipped, preserving stored HMAC by index", async () => {
    apiMocks.patch.mockResolvedValue(undefined);
    const draft = inboundRouteEnabledDraft(route(), true);
    expect(draft.enabled).toBe(true);
    expect(draft.actions[0]).not.toHaveProperty("hmacSecret");
    expect(inboundRouteEnabledDraft(route({ enabled: true }), false).enabled).toBe(
      false,
    );

    await updateInboundRouteStrict({
      tenantId: TENANT_ID,
      routeId: ROUTE_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft,
      idempotencyKey: "inbound-route-toggle-1",
    });

    expect(apiMocks.patch).toHaveBeenCalledTimes(1);
    expect(apiMocks.patch).toHaveBeenCalledWith(
      `/api/v1/inbound-routes/${ROUTE_ID}`,
      {
        name: "Support route",
        priority: 100,
        stop_on_match: true,
        enabled: true,
        match_recipient: "support@*",
        match_subject_prefix: "Re:",
        match_from_domain: "example.com",
        actions: [
          {
            kind: "webhook",
            url: "https://hooks.example.test/inbound",
            extra: { custom: "preserved" },
            preserve_hmac_from_index: 0,
          },
          { kind: "tag", tag: "vip" },
        ],
        action_retry_max: 2,
        action_retry_backoff_seconds: 5,
        expected_updated_at: "2026-08-30T10:00:00Z",
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "inbound-route-toggle-1",
      },
    );
  });

  it("keeps the revision lock for a route without actions by sending an explicit clear", async () => {
    apiMocks.patch.mockResolvedValue(undefined);
    await updateInboundRouteStrict({
      tenantId: TENANT_ID,
      routeId: ROUTE_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft: inboundRouteEnabledDraft(route({ actions: [] }), true),
      idempotencyKey: "inbound-route-toggle-2",
    });
    expect(apiMocks.patch.mock.calls[0]?.[1]).toMatchObject({
      enabled: true,
      actions: [],
      clear_actions: true,
      expected_updated_at: "2026-08-30T10:00:00Z",
    });
  });
});

describe("reorder (deliverability-29)", () => {
  it("POSTs the complete ordered id list and checks the acknowledged count", async () => {
    apiMocks.post.mockResolvedValue({ ok: true, count: 2 });
    await reorderInboundRoutesStrict({
      routeIds: [OTHER_ID, ROUTE_ID],
      idempotencyKey: "inbound-route-reorder-1",
    });
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/inbound-routes/reorder",
      { route_ids: [OTHER_ID, ROUTE_ID] },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "inbound-route-reorder-1",
      },
    );
  });

  it("refuses a receipt that does not acknowledge every id", async () => {
    apiMocks.post.mockResolvedValue({ ok: true, count: 1 });
    await expect(
      reorderInboundRoutesStrict({
        routeIds: [OTHER_ID, ROUTE_ID],
        idempotencyKey: "inbound-route-reorder-2",
      }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);
    apiMocks.post.mockResolvedValue({ ok: false, count: 2 });
    await expect(
      reorderInboundRoutesStrict({
        routeIds: [OTHER_ID, ROUTE_ID],
        idempotencyKey: "inbound-route-reorder-3",
      }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);
  });

  it("refuses duplicate, empty, or malformed lists before any request", async () => {
    await expect(
      reorderInboundRoutesStrict({
        routeIds: [ROUTE_ID, ROUTE_ID],
        idempotencyKey: "inbound-route-reorder-4",
      }),
    ).rejects.toBeInstanceOf(InboundRouteInputError);
    await expect(
      reorderInboundRoutesStrict({
        routeIds: [],
        idempotencyKey: "inbound-route-reorder-5",
      }),
    ).rejects.toBeInstanceOf(InboundRouteInputError);
    await expect(
      reorderInboundRoutesStrict({
        routeIds: [ROUTE_ID, "not-a-route"],
        idempotencyKey: "inbound-route-reorder-6",
      }),
    ).rejects.toBeInstanceOf(InboundRouteInputError);
    expect(apiMocks.post).not.toHaveBeenCalled();
  });
});

describe("match history (deliverability-32)", () => {
  it("GETs the route's matches with the requested limit and decodes them", async () => {
    apiMocks.get.mockResolvedValue({
      matches: [wireMatch(), wireMatch({ id: 6, inbound_email_id: null, subject: "" })],
      count: 2,
    });
    const matches = await listInboundRouteMatchesStrict({
      routeId: ROUTE_ID,
      limit: 50,
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    expect(apiMocks.get).toHaveBeenCalledWith(
      `/api/v1/inbound-routes/${ROUTE_ID}/matches`,
      expect.objectContaining({
        query: { limit: 50 },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
    expect(matches).toEqual([
      {
        id: 7,
        routeId: ROUTE_ID,
        inboundEmailId: 99,
        recipient: "support@example.test",
        subject: "Re: invoice 42",
        fromEmail: "customer@example.test",
        matchedAt: "2026-08-30T09:30:00Z",
      },
      {
        id: 6,
        routeId: ROUTE_ID,
        recipient: "support@example.test",
        subject: "",
        fromEmail: "customer@example.test",
        matchedAt: "2026-08-30T09:30:00Z",
      },
    ]);
  });

  it("defaults to the newest 50 and refuses an out-of-range limit before any request", async () => {
    apiMocks.get.mockResolvedValue({ matches: [], count: 0 });
    await expect(
      listInboundRouteMatchesStrict({ routeId: ROUTE_ID }),
    ).resolves.toEqual([]);
    expect(apiMocks.get.mock.calls[0]?.[1]).toMatchObject({
      query: { limit: 50 },
    });
    await expect(
      listInboundRouteMatchesStrict({ routeId: ROUTE_ID, limit: 0 }),
    ).rejects.toBeInstanceOf(InboundRouteInputError);
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
  });

  it("refuses another route's history and a contradictory count", async () => {
    apiMocks.get.mockResolvedValue({
      matches: [wireMatch({ route_id: OTHER_ID })],
      count: 1,
    });
    await expect(
      listInboundRouteMatchesStrict({ routeId: ROUTE_ID }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);
    apiMocks.get.mockResolvedValue({ matches: [wireMatch()], count: 3 });
    await expect(
      listInboundRouteMatchesStrict({ routeId: ROUTE_ID }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);
  });
});
