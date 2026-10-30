import { describe, expect, it } from "vitest";

import {
  analyticsIntegrationsApi,
  leadIntegrationsApi,
  loyaltyIntegrationsApi,
  reviewIntegrationsApi,
  subscriptionIntegrationsApi,
  supportIntegrationsApi,
} from "../../lib/api-client";
import { createAnalyticsIntegrationsApi } from "../../lib/api/analytics-integrations";
import { createLeadIntegrationsApi } from "../../lib/api/lead-integrations";
import { createLoyaltyIntegrationsApi } from "../../lib/api/loyalty-integrations";
import { createReviewIntegrationsApi } from "../../lib/api/review-integrations";
import { createSubscriptionIntegrationsApi } from "../../lib/api/subscription-integrations";
import {
  createSupportIntegrationsApi,
  decodeSupportIntegrationList,
  decodeSupportProviderCatalog,
} from "../../lib/api/support-integrations";
import type { ApiResult } from "../../lib/api/result";

type NativeProviderRequester = Parameters<typeof createLeadIntegrationsApi>[0];
type NativeProviderRequestOptions = Parameters<NativeProviderRequester>[2];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: NativeProviderRequestOptions;
}

interface NativeIntegrationCreateInput {
  provider: string;
  name?: string;
  status?: string;
  scopes?: string[];
  credentials_ref?: string;
  settings?: Record<string, unknown>;
}

interface ProviderCleanupAcknowledgementInput {
  completed_actions?: string[];
  notes?: string;
  acknowledged_by?: string;
}

interface ManagedNativeIntegrationsApi {
  providers(): Promise<unknown>;
  list(): Promise<unknown>;
  create(input: NativeIntegrationCreateInput): Promise<unknown>;
  sync(id: string, input?: Record<string, unknown>): Promise<unknown>;
  backfill(id: string, input?: Record<string, unknown>): Promise<unknown>;
  ingest(id: string, input: Record<string, unknown>): Promise<unknown>;
  pause(id: string): Promise<unknown>;
  disconnect(id: string): Promise<unknown>;
  acknowledgeProviderCleanup?(
    id: string,
    input: ProviderCleanupAcknowledgementInput,
  ): Promise<unknown>;
  runs(id: string, limit?: number): Promise<unknown>;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: NativeProviderRequester;
} {
  const calls: RequestCall[] = [];
  const request: NativeProviderRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: NativeProviderRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const STANDARD_OPERATIONS = [
  "providers",
  "list",
  "create",
  "sync",
  "backfill",
  "ingest",
  "pause",
  "disconnect",
  "runs",
] as const;

const CLEANUP_OPERATIONS = [
  "providers",
  "list",
  "create",
  "sync",
  "backfill",
  "ingest",
  "pause",
  "disconnect",
  "acknowledgeProviderCleanup",
  "runs",
] as const;

const EXECUTION_OPTIONS = {
  timeoutMs: 60_000,
  maxAttempts: 1,
  requireOnline: true,
};

const CREATE_INPUT: NativeIntegrationCreateInput = {
  provider: "provider/x",
  name: "Primary source",
  scopes: ["objects:read"],
  credentials_ref: "cred_provider_prod",
  settings: { region: "us-east/1" },
};

const INGEST_INPUT = {
  email: "reader@example.test",
  event_name: "subscription/renewed",
  properties: { plan: "pro" },
};

const CLEANUP_INPUT: ProviderCleanupAcknowledgementInput = {
  completed_actions: ["deleted webhook"],
  notes: "Verified in provider console",
  acknowledged_by: "operator@example.test",
};

const inventoryCases: Array<{
  name: string;
  create: (request: NativeProviderRequester) => object;
  facade: object;
  operations: readonly string[];
}> = [
  {
    name: "lead",
    create: createLeadIntegrationsApi,
    facade: leadIntegrationsApi,
    operations: STANDARD_OPERATIONS,
  },
  {
    name: "review",
    create: createReviewIntegrationsApi,
    facade: reviewIntegrationsApi,
    operations: CLEANUP_OPERATIONS,
  },
  {
    name: "loyalty",
    create: createLoyaltyIntegrationsApi,
    facade: loyaltyIntegrationsApi,
    operations: CLEANUP_OPERATIONS,
  },
  {
    name: "subscription/shipping",
    create: createSubscriptionIntegrationsApi,
    facade: subscriptionIntegrationsApi,
    operations: CLEANUP_OPERATIONS,
  },
  {
    name: "support",
    create: createSupportIntegrationsApi,
    facade: supportIntegrationsApi,
    operations: STANDARD_OPERATIONS,
  },
  {
    name: "analytics/CDP",
    create: createAnalyticsIntegrationsApi,
    facade: analyticsIntegrationsApi,
    operations: STANDARD_OPERATIONS,
  },
];

async function exerciseManagedApi(
  api: ManagedNativeIntegrationsApi,
  acknowledgeCleanup: boolean,
): Promise<void> {
  const id = "native/one";
  await api.providers();
  await api.list();
  await api.create(CREATE_INPUT);
  await api.sync(id);
  await api.backfill(id);
  await api.ingest(id, INGEST_INPUT);
  await api.pause(id);
  await api.disconnect(id);
  if (acknowledgeCleanup) {
    if (!api.acknowledgeProviderCleanup) {
      throw new Error("Expected provider cleanup acknowledgement operation");
    }
    await api.acknowledgeProviderCleanup(id, CLEANUP_INPUT);
  }
  await api.runs(id);
}

function expectedManagedCalls(
  route: string,
  acknowledgeCleanup: boolean,
): RequestCall[] {
  const encodedID = "native%2Fone";
  const calls: RequestCall[] = [
    { path: `${route}/providers`, init: undefined, opts: undefined },
    { path: route, init: undefined, opts: undefined },
    {
      path: route,
      init: { method: "POST", body: JSON.stringify(CREATE_INPUT) },
      opts: undefined,
    },
    {
      path: `${route}/${encodedID}/sync`,
      init: { method: "POST", body: "{}" },
      opts: EXECUTION_OPTIONS,
    },
    {
      path: `${route}/${encodedID}/backfill`,
      init: { method: "POST", body: "{}" },
      opts: EXECUTION_OPTIONS,
    },
    {
      path: `${route}/${encodedID}/ingest`,
      init: { method: "POST", body: JSON.stringify(INGEST_INPUT) },
      opts: EXECUTION_OPTIONS,
    },
    {
      path: `${route}/${encodedID}/pause`,
      init: { method: "POST" },
      opts: undefined,
    },
    {
      path: `${route}/${encodedID}`,
      init: { method: "DELETE" },
      opts: undefined,
    },
  ];
  if (acknowledgeCleanup) {
    calls.push({
      path: `${route}/${encodedID}/provider-cleanup/acknowledge`,
      init: { method: "POST", body: JSON.stringify(CLEANUP_INPUT) },
      opts: undefined,
    });
  }
  calls.push({
    path: `${route}/${encodedID}/runs?limit=25`,
    init: undefined,
    opts: undefined,
  });
  return calls;
}

describe("native provider integration API factories", () => {
  for (const { name, create, facade, operations } of inventoryCases) {
    it(`retains the complete ${name} factory and composed facade inventory`, () => {
      const { request } = recordingRequester();

      expect(Object.keys(create(request))).toEqual(operations);
      expect(Object.keys(facade)).toEqual(operations);
    });
  }

  const managedCases: Array<{
    name: string;
    route: string;
    acknowledgeCleanup: boolean;
    create: (request: NativeProviderRequester) => ManagedNativeIntegrationsApi;
  }> = [
    {
      name: "lead",
      route: "/api/v1/lead-integrations",
      acknowledgeCleanup: false,
      create: createLeadIntegrationsApi,
    },
    {
      name: "review",
      route: "/api/v1/review-integrations",
      acknowledgeCleanup: true,
      create: createReviewIntegrationsApi,
    },
    {
      name: "loyalty",
      route: "/api/v1/loyalty-integrations",
      acknowledgeCleanup: true,
      create: createLoyaltyIntegrationsApi,
    },
    {
      name: "subscription/shipping",
      route: "/api/v1/subscription-integrations",
      acknowledgeCleanup: true,
      create: createSubscriptionIntegrationsApi,
    },
  ];

  for (const { name, route, acknowledgeCleanup, create } of managedCases) {
    it(`preserves every ${name} transport contract`, async () => {
      const { calls, request } = recordingRequester();

      await exerciseManagedApi(create(request), acknowledgeCleanup);

      expect(calls).toEqual(expectedManagedCalls(route, acknowledgeCleanup));
    });
  }

  it("holds every support effect and run locally before hostile input is inspected", async () => {
    const { calls, request } = recordingRequester();
    const api = createSupportIntegrationsApi(request);
    const hostileID = "%00/private@example.test/".padEnd(2_048, "x");
    const secretInput = new Proxy(
      {},
      {
        get() {
          throw new Error("held input was inspected");
        },
        ownKeys() {
          throw new Error("held input was enumerated");
        },
      },
    ) as NativeIntegrationCreateInput;
    const ingestSecret = new Proxy(
      {},
      {
        get() {
          throw new Error("held ingest was inspected");
        },
        ownKeys() {
          throw new Error("held ingest was enumerated");
        },
      },
    ) as Record<string, unknown>;

    const results = await Promise.all([
      api.create(secretInput),
      api.sync(hostileID, ingestSecret),
      api.backfill(hostileID, ingestSecret),
      api.ingest(hostileID, ingestSecret),
      api.pause(hostileID),
      api.disconnect(hostileID),
      api.runs(hostileID, Number.NaN),
    ]);

    expect(calls).toEqual([]);
    for (const result of results) {
      expect(result).toEqual({
        error: expect.objectContaining({
          status: 503,
          code: "support_integration_runtime_held",
          message: expect.stringContaining(
            "No support runtime request was sent",
          ),
        }),
        retryability: "not-retryable",
      });
    }
  });

  it("accepts only the exact static support-provider hold catalog", () => {
    const canonical = {
      items: [
        {
          key: "zendesk",
          name: "Zendesk",
          runtime_status: "held",
          hold_code: "support_integration_runtime_held",
        },
      ],
      complete: true,
      provenance: { tenant_bound: false, source: "static_server_catalog" },
    };

    expect(decodeSupportProviderCatalog(canonical)).toEqual(canonical);
    expect(
      decodeSupportProviderCatalog({
        ...canonical,
        items: [
          {
            ...canonical.items[0],
            auth_mode: "api_token",
            credentials_ref: "vault://private",
            scopes: ["tickets:read"],
          },
        ],
      }),
    ).toBeNull();
    expect(
      decodeSupportProviderCatalog({
        ...canonical,
        items: [{ ...canonical.items[0], runtime_status: "available" }],
      }),
    ).toBeNull();
    for (const name of [
      " Zendesk",
      "Zendesk ",
      "Trusted\nRuntime connected",
      "Trusted\tRuntime connected",
      "Trusted\u0085Runtime connected",
      "Trusted\u202eRuntime connected",
    ]) {
      expect(
        decodeSupportProviderCatalog({
          ...canonical,
          items: [{ ...canonical.items[0], name }],
        }),
      ).toBeNull();
    }
  });

  it("propagates cancellation through the static support catalog read", async () => {
    const signal = new AbortController().signal;
    const calls: RequestCall[] = [];
    const catalog = {
      items: [
        {
          key: "zendesk",
          name: "Zendesk",
          runtime_status: "held",
          hold_code: "support_integration_runtime_held",
        },
      ],
      complete: true,
      provenance: { tenant_bound: false, source: "static_server_catalog" },
    };
    const request: NativeProviderRequester = async <T>(
      path: string,
      init?: RequestInit,
      opts?: NativeProviderRequestOptions,
    ): Promise<ApiResult<T>> => {
      calls.push({ path, init, opts });
      return { data: catalog as T };
    };

    const result =
      await createSupportIntegrationsApi(request).providers(signal);

    expect(result.error).toBeUndefined();
    expect(calls).toEqual([
      {
        path: "/api/v1/support-integrations/providers",
        init: undefined,
        opts: { signal },
      },
    ]);
  });

  it("accepts only minimized tenant-bound support integration rows", () => {
    const canonical = {
      tenantId: "11111111-1111-4111-8111-111111111111",
      items: [
        {
          tenantId: "11111111-1111-4111-8111-111111111111",
          tenant_id: "11111111-1111-4111-8111-111111111111",
          id: "22222222-2222-4222-8222-222222222222",
          provider: "zendesk",
          name: "Historical Zendesk record",
          status: "paused",
          runtime_status: "held",
          hold_code: "support_integration_runtime_held",
          credential_configured: true,
          created_at: "2026-08-20T10:00:00.123456789Z",
          updated_at: "2026-08-21T10:00:00.123456789Z",
        },
      ],
      page: {
        has_more: false,
        next_cursor: null,
        as_of: "2026-08-25T10:00:00.123456789Z",
        consistency: "mutable_window",
        may_reorder: true,
      },
    };

    expect(decodeSupportIntegrationList(canonical)).toEqual(canonical);
    for (const poison of [
      { credentials_ref: "vault://private" },
      { settings: { secret: "private" } },
      { scopes: ["tickets:read"] },
      { sync_cursor: "cursor-private" },
      { error_message: "private provider body" },
    ]) {
      expect(
        decodeSupportIntegrationList({
          ...canonical,
          items: [{ ...canonical.items[0], ...poison }],
        }),
      ).toBeNull();
    }
    expect(
      decodeSupportIntegrationList({
        ...canonical,
        items: [
          {
            ...canonical.items[0],
            tenant_id: "33333333-3333-4333-8333-333333333333",
          },
        ],
      }),
    ).toBeNull();
    for (const name of [
      " Historical Zendesk record",
      "Historical Zendesk record ",
      "Trusted\nRuntime connected",
      "Trusted\tRuntime connected",
      "Trusted\u0085Runtime connected",
      "Trusted\u202eRuntime connected",
    ]) {
      expect(
        decodeSupportIntegrationList({
          ...canonical,
          items: [{ ...canonical.items[0], name }],
        }),
      ).toBeNull();
    }
    for (const next_cursor of [
      "poison\n",
      " padded",
      "padded ",
      "opaque&limit=100",
      "opaque=padding",
      "opaque/path",
    ]) {
      expect(
        decodeSupportIntegrationList({
          ...canonical,
          page: {
            ...canonical.page,
            has_more: true,
            next_cursor,
          },
        }),
      ).toBeNull();
    }
  });

  it("encodes bounded support list cursors and rejects cross-window pages", async () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const asOf = "2026-08-25T10:00:00.123456789Z";
    const cursor = "opaque_base64url-token_123";
    const page = (id: string, pageAsOf: string, hasMore: boolean): unknown => ({
      tenantId,
      items: [
        {
          tenantId,
          tenant_id: tenantId,
          id,
          provider: "zendesk",
          name: "Historical Zendesk record",
          status: "paused",
          runtime_status: "held",
          hold_code: "support_integration_runtime_held",
          credential_configured: true,
          created_at: "2026-08-20T10:00:00.123456789Z",
          updated_at: "2026-08-21T10:00:00.123456789Z",
        },
      ],
      page: {
        has_more: hasMore,
        next_cursor: hasMore ? cursor : null,
        as_of: pageAsOf,
        consistency: "mutable_window",
        may_reorder: true,
      },
    });
    const calls: RequestCall[] = [];
    let response: unknown = page(
      "22222222-2222-4222-8222-222222222222",
      asOf,
      true,
    );
    const request: NativeProviderRequester = async <T>(
      path: string,
      init?: RequestInit,
      opts?: NativeProviderRequestOptions,
    ): Promise<ApiResult<T>> => {
      calls.push({ path, init, opts });
      return { data: response as T };
    };
    const api = createSupportIntegrationsApi(request);
    const first = await api.list({ limit: 100 });
    expect(first.error).toBeUndefined();
    response = page("33333333-3333-4333-8333-333333333333", asOf, false);
    const second = await api.list({
      limit: 100,
      cursor,
      expectedWindow: { asOf, consistency: "mutable_window" },
    });
    expect(second.error).toBeUndefined();
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/v1/support-integrations?limit=100",
      `/api/v1/support-integrations?${new URLSearchParams({
        limit: "100",
        cursor,
      }).toString()}`,
    ]);

    response = page(
      "44444444-4444-4444-8444-444444444444",
      "2026-08-25T10:00:01.123456789Z",
      false,
    );
    const drift = await api.list({
      cursor,
      expectedWindow: { asOf, consistency: "mutable_window" },
    });
    expect(drift).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          code: "support_integration_projection_invalid",
          message: expect.stringContaining("changed its verified list window"),
        }),
      }),
    );
  });

  it("rejects unsafe support list options before transport", async () => {
    const { calls, request } = recordingRequester();
    const api = createSupportIntegrationsApi(request);
    const expectedWindow = {
      asOf: "2026-08-25T10:00:00.123456789Z",
      consistency: "mutable_window" as const,
    };

    for (const result of await Promise.all([
      api.list({ limit: 0 }),
      api.list({ limit: 101 }),
      api.list({ limit: 1.5 }),
      api.list({ cursor: "opaque-without-window" }),
      api.list({ cursor: "poison\n", expectedWindow }),
      api.list({ cursor: "poison\u0085", expectedWindow }),
      api.list({ cursor: " padded", expectedWindow }),
      api.list({ cursor: "padded ", expectedWindow }),
      api.list({ cursor: "opaque&limit=100", expectedWindow }),
      api.list({ cursor: "opaque=padding", expectedWindow }),
      api.list({ cursor: "opaque/path", expectedWindow }),
      api.list({ cursor: `opaque${"a".repeat(4091)}`, expectedWindow }),
      api.list({ cursor: "opaque\u202eright-to-left", expectedWindow }),
      api.list({
        cursor: 7 as unknown as string,
        expectedWindow,
      }),
      api.list({
        cursor: "opaque",
        expectedWindow: {
          ...expectedWindow,
          additive: "not-frozen",
        } as typeof expectedWindow,
      }),
      api.list({
        cursor: "opaque",
        expectedWindow: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("window must not escape validation");
            },
          },
        ) as typeof expectedWindow,
      }),
    ])) {
      expect(result).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({
            code: "support_integration_list_options_invalid",
          }),
          retryability: "not-retryable",
        }),
      );
    }
    expect(calls).toEqual([]);
  });

  it("preserves every analytics/CDP transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createAnalyticsIntegrationsApi(request);
    const id = "analytics/one";
    const analyticsCreateInput = {
      provider: "segment",
      name: "Primary CDP",
      credentials_ref: "cred_segment_prod",
      settings: { source_id: "source/one" },
    };
    const eventInput = {
      source_id: "source/one",
      email: "reader@example.test",
      event_name: "Product Viewed",
      properties: { product_id: "product/one" },
    };

    await api.providers();
    await api.list();
    await api.create(analyticsCreateInput);
    await api.sync(id);
    await api.backfill(id, { cursor: "cursor/one" });
    await api.ingest(id, eventInput);
    await api.pause(id);
    await api.disconnect(id);
    await api.runs(id, 7);

    expect(calls).toEqual([
      {
        path: "/api/v1/analytics-integrations/providers",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/analytics-integrations",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/analytics-integrations",
        init: { method: "POST", body: JSON.stringify(analyticsCreateInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone/sync",
        init: { method: "POST", body: "{}" },
        opts: EXECUTION_OPTIONS,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone/backfill",
        init: {
          method: "POST",
          body: JSON.stringify({ cursor: "cursor/one" }),
        },
        opts: EXECUTION_OPTIONS,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone/ingest",
        init: { method: "POST", body: JSON.stringify(eventInput) },
        opts: EXECUTION_OPTIONS,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone/pause",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/analytics-integrations/analytics%2Fone/runs?limit=7",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
