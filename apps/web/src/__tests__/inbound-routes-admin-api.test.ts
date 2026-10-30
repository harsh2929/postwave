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

import { ApiError } from "@/lib/api";
import {
  InboundRouteContractError,
  InboundRouteInputError,
  clearInboundRouteSecretVault,
  createInboundRouteStrict,
  duplicateInboundRouteDraft,
  getInboundEmailEndpointStrict,
  inboundRouteMatchesDraft,
  inboundRouteWriteFingerprint,
  listInboundRoutesStrict,
  previewInboundRoutesStrict,
  rotateInboundEmailEndpointStrict,
  updateInboundRouteStrict,
  type InboundRouteDraft,
} from "@/lib/inbound-routes-admin-api";

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ROUTE_ID = "00000000-0000-4000-8000-000000000002";
const ENDPOINT_ID = "00000000-0000-4000-8000-000000000003";
const SECRET = `iem_${"a".repeat(48)}`;

function route(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTE_ID,
    name: "Support route",
    priority: 100,
    stop_on_match: true,
    enabled: false,
    match_recipient: "support@*",
    match_subject_prefix: "Re:",
    match_from_domain: "example.com",
    actions: [
      {
        kind: "webhook",
        url: "https://hooks.example.test/inbound",
        extra: { custom: "preserved" },
        has_stored_hmac_secret: true,
      },
    ],
    last_matched_at: "2026-08-30T10:00:00Z",
    match_count: 7,
    action_retry_max: 2,
    action_retry_backoff_seconds: 5,
    updated_at: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

const draft: InboundRouteDraft = {
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
      preserveHmacFromIndex: 0,
    },
  ],
  actionRetryMax: 2,
  actionRetryBackoffSeconds: 5,
};

function endpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: ENDPOINT_ID,
    tenantId: TENANT_ID,
    slug: "0123456789abcdef",
    secretConfigured: true,
    rotationRequired: false,
    secretRotatedAt: "2026-08-30T10:00:00Z",
    createdAt: "2026-08-29T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearInboundRouteSecretVault(TENANT_ID);
});

describe("inbound route admin contracts", () => {
  it("loads a bounded abortable catalogue and redacts stored HMAC plaintext", async () => {
    const signal = new AbortController().signal;
    apiMocks.get.mockResolvedValueOnce({ routes: [route()] });
    const rows = await listInboundRoutesStrict({ tenantId: TENANT_ID, signal });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actions[0]).toMatchObject({
      kind: "webhook",
      hasStoredHmacSecret: true,
      extra: { custom: "preserved" },
    });
    expect(JSON.stringify(rows)).not.toContain("stored-secret");
    expect(apiMocks.get).toHaveBeenCalledWith("/api/v1/inbound-routes", {
      requireOnline: true,
      maxAttempts: 1,
      signal,
    });
  });

  it("fails closed on duplicate, oversized, and unsafe catalogue data", async () => {
    apiMocks.get.mockResolvedValueOnce({ routes: [route(), route()] });
    await expect(
      listInboundRoutesStrict({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/duplicate/i);

    apiMocks.get.mockResolvedValueOnce({
      routes: Array.from({ length: 501 }, (_, index) => ({
        ...route(),
        id: `00000000-0000-4000-8${String(index).padStart(3, "0").slice(-3)}-000000000002`,
      })),
    });
    await expect(
      listInboundRoutesStrict({ tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);

    apiMocks.get.mockResolvedValueOnce({
      routes: [route({ actions: [{ kind: "webhook", url: "https://x.test", extra: { constructor: "unsafe" } }] })],
    });
    await expect(
      listInboundRoutesStrict({ tenantId: TENANT_ID }),
    ).rejects.toBeInstanceOf(InboundRouteContractError);
  });

  it("uses an opaque server-side preservation marker for an exact update", async () => {
    apiMocks.get.mockResolvedValueOnce({ routes: [route()] });
    const [decoded] = await listInboundRoutesStrict({ tenantId: TENANT_ID });
    expect(decoded && inboundRouteMatchesDraft(decoded, draft)).toBe(true);

    let captured: unknown;
    apiMocks.patch.mockImplementationOnce((_path, body) => {
      captured = structuredClone(body);
      return Promise.resolve(undefined);
    });
    await updateInboundRouteStrict({
      tenantId: TENANT_ID,
      routeId: ROUTE_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft,
      idempotencyKey: "route-update-operation",
    });
    expect(captured).toMatchObject({
      expected_updated_at: "2026-08-30T10:00:00Z",
      actions: [
        {
          kind: "webhook",
          extra: { custom: "preserved" },
          preserve_hmac_from_index: 0,
        },
      ],
    });
    expect(JSON.stringify(captured)).not.toContain("stored-secret");
    expect(JSON.stringify(captured)).not.toContain("hmac_secret");
  });

  it("rejects raw HMAC extras but permits an explicit revision-bound replacement", async () => {
    await expect(
      updateInboundRouteStrict({
        tenantId: TENANT_ID,
        routeId: ROUTE_ID,
        expectedUpdatedAt: "2026-08-30T10:00:00Z",
        draft: {
          ...draft,
          actions: [
            {
              kind: "webhook",
              url: "https://hooks.example.test/inbound",
              extra: { hmac_secret: "smuggled-through-extras" },
            },
          ],
        },
        idempotencyKey: "route-update-raw-secret",
      }),
    ).rejects.toThrow(/dedicated replacement field/i);
    expect(apiMocks.patch).not.toHaveBeenCalled();

    let replacementWire: unknown;
    apiMocks.patch.mockImplementationOnce((_path, body) => {
      replacementWire = structuredClone(body);
      return Promise.resolve(undefined);
    });
    await updateInboundRouteStrict({
      tenantId: TENANT_ID,
      routeId: ROUTE_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft: {
        ...draft,
        actions: [
          {
            kind: "webhook",
            url: "https://hooks.example.test/inbound",
            hmacSecret: "intentional-replacement",
          },
        ],
      },
      idempotencyKey: "route-update-explicit-secret",
    });
    expect(replacementWire).toMatchObject({
      expected_updated_at: "2026-08-30T10:00:00Z",
      actions: [
        {
          kind: "webhook",
          extra: { hmac_secret: "intentional-replacement" },
        },
      ],
    });
  });

  it("fails closed if a catalogue response contains HMAC plaintext", async () => {
    apiMocks.get.mockResolvedValueOnce({
      routes: [
        route({
          actions: [
            {
              kind: "webhook",
              url: "https://hooks.example.test/inbound",
              extra: { hmac_secret: "must-not-reach-browser" },
            },
          ],
        }),
      ],
    });
    await expect(
      listInboundRoutesStrict({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/unexpectedly exposed/i);
  });

  it("creates with explicit idempotency and rejects unsafe operation keys", async () => {
    const createDraft = { ...draft, actions: [] };
    await expect(
      createInboundRouteStrict({
        tenantId: TENANT_ID,
        draft: createDraft,
        idempotencyKey: "unsafe\noperation",
      }),
    ).rejects.toBeInstanceOf(InboundRouteInputError);
    expect(apiMocks.post).not.toHaveBeenCalled();

    apiMocks.post.mockResolvedValueOnce({ id: ROUTE_ID });
    await expect(
      createInboundRouteStrict({
        tenantId: TENANT_ID,
        draft: createDraft,
        idempotencyKey: "route-create-operation",
      }),
    ).resolves.toBe(ROUTE_ID);
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/inbound-routes",
      expect.objectContaining({ enabled: false, actions: [] }),
      expect.objectContaining({
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "route-create-operation",
      }),
    );
  });

  it("duplicates as disabled and strips stored action secrets", async () => {
    apiMocks.get.mockResolvedValueOnce({ routes: [route()] });
    const source = (await listInboundRoutesStrict({ tenantId: TENANT_ID }))[0]!;
    const copy = duplicateInboundRouteDraft(source);
    expect(copy.enabled).toBe(false);
    expect(copy.actions[0]).not.toHaveProperty("preserveHmacFromIndex");
    expect(copy.actions[0]).not.toHaveProperty("hmacSecret");
  });

  it("keeps duplicate names inside the UTF-8 byte contract", async () => {
    apiMocks.get.mockResolvedValueOnce({
      routes: [route({ name: "📨".repeat(30) })],
    });
    const source = (await listInboundRoutesStrict({ tenantId: TENANT_ID }))[0]!;
    const copy = duplicateInboundRouteDraft(source);
    expect(new TextEncoder().encode(copy.name).byteLength).toBeLessThanOrEqual(120);
    expect(copy.name).toMatch(/ \(copy\)$/);
  });

  it("uses a non-idempotent read-only preview POST and rejects contradictory emptiness", async () => {
    const signal = new AbortController().signal;
    apiMocks.post.mockResolvedValueOnce({
      matches: [{ route: route(), reason: "recipient matched" }],
      evaluated: 1,
      stopped_at_route_id: ROUTE_ID,
    });
    const result = await previewInboundRoutesStrict({
      tenantId: TENANT_ID,
      recipient: "support@example.test",
      signal,
    });
    expect(result.matches[0]?.route.actions[0]?.hasStoredHmacSecret).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stored-secret");
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/api/v1/inbound-routes/preview",
      { recipient: "support@example.test", subject: "", from: "" },
      expect.objectContaining({ idempotencyKey: null, signal }),
    );

    apiMocks.post.mockResolvedValueOnce({ matches: [], evaluated: 1, no_matches: false });
    await expect(
      previewInboundRoutesStrict({ tenantId: TENANT_ID, recipient: "x@y.test" }),
    ).rejects.toThrow(/contradictory/i);
  });

  it("treats endpoint 404 as verified absence and enforces tenant-bound shown-once rotation", async () => {
    apiMocks.get.mockRejectedValueOnce(new ApiError("not found", 404));
    await expect(
      getInboundEmailEndpointStrict({ tenantId: TENANT_ID }),
    ).resolves.toBeNull();

    apiMocks.get.mockResolvedValueOnce(
      endpoint({ tenantId: "00000000-0000-4000-8000-000000000099" }),
    );
    await expect(
      getInboundEmailEndpointStrict({ tenantId: TENANT_ID }),
    ).rejects.toThrow(/another workspace/i);

    apiMocks.post.mockResolvedValueOnce(endpoint({ secret: SECRET }));
    await expect(
      rotateInboundEmailEndpointStrict({
        tenantId: TENANT_ID,
        idempotencyKey: "endpoint-rotate-operation",
      }),
    ).resolves.toMatchObject({ tenantId: TENANT_ID, secret: SECRET });
    expect(apiMocks.post).toHaveBeenLastCalledWith(
      "/api/v1/inbound-emails/endpoint/rotate",
      undefined,
      expect.objectContaining({ idempotencyKey: "endpoint-rotate-operation" }),
    );
  });

  it("hashes exact write input without retaining plaintext in the fingerprint", async () => {
    const withSecret: InboundRouteDraft = {
      ...draft,
      actions: [
        {
          kind: "webhook",
          url: "https://hooks.example.test/inbound",
          hmacSecret: "new-draft-secret",
        },
      ],
    };
    const first = await inboundRouteWriteFingerprint({
      tenantId: TENANT_ID,
      draft: withSecret,
    });
    const second = await inboundRouteWriteFingerprint({
      tenantId: TENANT_ID,
      draft: withSecret,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toContain("new-draft-secret");
  });
});
