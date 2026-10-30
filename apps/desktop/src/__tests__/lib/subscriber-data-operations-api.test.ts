import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createSubscriberDataOperationsMethods,
  type SubscriberDataOperationsDependencies,
  type SubscriberDataOperationsRequester,
  type SubscriberDataOperationsRequestOptions,
} from "../../lib/api/subscriber-data-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: SubscriberDataOperationsRequestOptions | undefined;
}

interface NativeCall {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

const METHOD_NAMES = [
  "downloadSubscriberDataExport",
  "downloadSubscriberConsentReceipt",
  "createSarRequest",
  "listDsarStoreResponses",
  "getDsarExport",
  "reconfirmSubscriberJurisdiction",
  "exportSubscribersCSV",
  "suppressSubscriber",
  "getSubscriberEngagement",
  "getSubscriberEngagementBatch",
  "listSubscriberDuplicates",
  "startSubscriberDuplicateScan",
  "listSubscriberDuplicateScanPairs",
  "mergeSubscribers",
  "bulkMergeSubscribers",
  "listSubscriberFederatedLinks",
  "createSubscriberFederatedLink",
  "deleteSubscriberFederatedLink",
  "identifySubscriber",
  "previewSubscriberImport",
  "patchSubscriberImport",
  "confirmSubscriberImport",
  "getSubscriberImport",
  "cancelSubscriberImport",
  "getImportRemapOptions",
  "subscriberImportProgressUrlAuthed",
  "listSubscriberImportTemplates",
  "saveSubscriberImportTemplate",
  "deleteSubscriberImportTemplate",
  "bulkTagSubscribers",
  "bulkUntagSubscribers",
  "bulkUnsubscribeSubscribers",
  "bulkDeleteSubscribers",
  "bulkRecoverSubscribers",
  "bulkResubscribeSubscribers",
  "bulkAddToListSubscribers",
  "bulkSetCustomFieldSubscribers",
  "bulkUpdateMergeFieldSubscribers",
  "bulkGrantConsentSubscribers",
  "bulkRevokeConsentSubscribers",
  "bulkExportSubscribersBySegment",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(
  options: {
    responses?: ApiResult<unknown>[];
    nativeResponses?: Array<Response | Error>;
    apiKey?: string | null;
    normalizedApiKey?: string | null;
  } = {},
) {
  const calls: RequestCall[] = [];
  const nativeCalls: NativeCall[] = [];
  const streamPaths: string[] = [];
  const controllerParents: Array<AbortSignal | null | undefined> = [];
  const controllerSignals: AbortSignal[] = [];
  const normalizedKeys: Array<string | null | undefined> = [];
  const state = { disposeCount: 0, errorResponseCount: 0 };
  const responses = [...(options.responses ?? [])];
  const nativeResponses = [...(options.nativeResponses ?? [])];

  const request: SubscriberDataOperationsRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: SubscriberDataOperationsRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };

  const dependencies: SubscriberDataOperationsDependencies = {
    request,
    createDownloadController: (parent) => {
      controllerParents.push(parent);
      const controller = new AbortController();
      controllerSignals.push(controller.signal);
      return {
        signal: controller.signal,
        dispose: () => {
          state.disposeCount += 1;
        },
      };
    },
    normalizeApiKey: (key) => {
      normalizedKeys.push(key);
      return "normalizedApiKey" in options
        ? (options.normalizedApiKey ?? null)
        : "normalized-key";
    },
    getApiKey: () =>
      "apiKey" in options ? (options.apiKey ?? null) : "raw-key",
    nativeAwareFetch: async (input, init) => {
      nativeCalls.push({ input, init });
      const next = nativeResponses.shift();
      if (next instanceof Error) throw next;
      return next ?? new Response("download", { status: 200 });
    },
    apiUrl: (path) => `https://api.example.test${path}`,
    errorFromResponse: async (response) => {
      state.errorResponseCount += 1;
      return {
        kind: "http",
        status: response.status,
        message: `HTTP ${response.status}`,
      };
    },
    transportError: (error) => ({
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    }),
    buildStreamUrl: async (path) => {
      streamPaths.push(path);
      return `stream:${path}`;
    },
    nativeClientHeaders: { "X-Postwave-Client": "desktop" },
  };

  return {
    calls,
    controllerParents,
    controllerSignals,
    methods: createSubscriberDataOperationsMethods(dependencies),
    nativeCalls,
    normalizedKeys,
    state,
    streamPaths,
  };
}

describe("subscriber data operations API extraction contracts", () => {
  it("retains the exact ordered subscriber-operation inventory on the factory and facade", () => {
    const {
      calls,
      controllerParents,
      methods,
      nativeCalls,
      normalizedKeys,
      state,
      streamPaths,
    } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(controllerParents).toEqual([]);
    expect(normalizedKeys).toEqual([]);
    expect(streamPaths).toEqual([]);
    expect(state).toEqual({ disposeCount: 0, errorResponseCount: 0 });
  });

  it("preserves the explicit Moosewave-only erasure discriminator", async () => {
    const { calls, methods } = createHarness();
    const body = {
      kind: "erase" as const,
      email: "erase-me@example.com",
      fanout_enabled: false,
      notes: "verified request",
    };

    await methods.createSarRequest(body);

    expect(calls).toEqual([
      {
        path: "/api/v1/sar/requests",
        init: { method: "POST", body: JSON.stringify(body) },
        opts: { requireOnline: true },
      },
    ]);
  });

  it("preserves portable downloads, SAR fan-out, DSAR aliasing, and jurisdiction policy", async () => {
    const dataSignal = new AbortController().signal;
    const consentSignal = new AbortController().signal;
    const aliasSignal = new AbortController().signal;
    const {
      calls,
      controllerParents,
      controllerSignals,
      methods,
      nativeCalls,
      state,
    } = createHarness({
      nativeResponses: [
        new Response("data-zip", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="data.zip"',
          },
        }),
        new Response("consent-zip", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="consent.zip"',
            "X-Postwave-Consent-Receipt-ID": "receipt-42",
          },
        }),
        new Response("alias-zip", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="alias.zip"',
          },
        }),
      ],
    });

    await expect(
      methods.downloadSubscriberDataExport("subscriber/one", {
        signal: dataSignal,
      }),
    ).resolves.toMatchObject({ data: { filename: "data.zip" } });
    await expect(
      methods.downloadSubscriberConsentReceipt("subscriber/two", {
        signal: consentSignal,
      }),
    ).resolves.toMatchObject({
      data: {
        filename: "consent.zip",
        consentReceiptId: "receipt-42",
      },
    });
    const sarBody = {
      kind: "access" as const,
      email: "ada@example.com",
      fanout_enabled: true,
      notes: "portable request",
    };
    await methods.createSarRequest(sarBody);
    await methods.listDsarStoreResponses("sar/one");
    await expect(
      methods.getDsarExport("subscriber/three", { signal: aliasSignal }),
    ).resolves.toMatchObject({ data: { filename: "alias.zip" } });
    const reconfirmBody = {
      decision: "declined" as const,
      regime: "gdpr" as const,
      privacy_policy_version: "2026-07",
      captured_text: "I decline",
      expected_jurisdiction_changed_at: "2026-07-18T10:00:00.123456Z",
      expected_subscriber_version: '"subscriber:subscriber-four:v1"',
    };
    await methods.reconfirmSubscriberJurisdiction(
      "subscriber/four",
      reconfirmBody,
    );

    expect(controllerParents).toEqual([dataSignal, consentSignal, aliasSignal]);
    expect(state).toEqual({ disposeCount: 3, errorResponseCount: 0 });
    expect(nativeCalls).toHaveLength(3);
    expect(nativeCalls.map((call) => call.input)).toEqual([
      "https://api.example.test/api/v1/subscribers/subscriber%2Fone/data-export.zip",
      "https://api.example.test/api/v1/subscribers/subscriber%2Ftwo/consent-receipt.zip",
      "https://api.example.test/api/v1/subscribers/subscriber%2Fthree/data-export.zip",
    ]);
    for (const [index, call] of nativeCalls.entries()) {
      expect(call.init).toMatchObject({
        method: "GET",
        headers: {
          Accept: "application/zip",
          Authorization: "Bearer normalized-key",
        },
        mode: "cors",
        credentials: "include",
        cache: "no-store",
        signal: controllerSignals[index],
      });
    }
    expect(calls).toEqual([
      {
        path: "/api/v1/sar/requests",
        init: { method: "POST", body: JSON.stringify(sarBody) },
        opts: { requireOnline: true },
      },
      {
        path: "/api/v1/sar/requests/sar%2Fone/store-responses",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Ffour/jurisdiction-reconfirm",
        init: { method: "PATCH", body: JSON.stringify(reconfirmBody) },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("binds jurisdiction evidence to an exact reviewed revision and accepts only a fresh matching response revision", async () => {
    const expectedVersion = '"subscriber:subscriber-1:v17"';
    const body = {
      decision: "accepted" as const,
      regime: "law25" as const,
      privacy_policy_version: "privacy-2026-07-19",
      captured_text: "I agree to receive marketing email.",
      expected_jurisdiction_changed_at: "2026-07-19T12:34:56.123456Z",
      expected_subscriber_version: expectedVersion,
    };
    const { calls, methods } = createHarness({
      responses: [
        {
          data: {
            id: "subscriber-1",
            email: "private@example.test",
            status: "enabled",
            version: '"subscriber:subscriber-1:v18"',
            jurisdiction_reconfirm_required: false,
          },
          serverVersion: '"subscriber:subscriber-1:v18"',
        },
        {
          data: {
            id: "subscriber-1",
            email: "private@example.test",
            status: "enabled",
            version: expectedVersion,
            jurisdiction_reconfirm_required: false,
          },
          serverVersion: expectedVersion,
        },
        {
          data: {
            id: "subscriber-1",
            email: "private@example.test",
            status: "enabled",
            version: '"subscriber:subscriber-1:v19"',
            jurisdiction_reconfirm_required: false,
          },
          serverVersion: '"subscriber:subscriber-1:v20"',
        },
      ],
    });

    await expect(
      methods.reconfirmSubscriberJurisdiction("subscriber-1", body),
    ).resolves.toMatchObject({
      data: { version: '"subscriber:subscriber-1:v18"' },
      serverVersion: '"subscriber:subscriber-1:v18"',
    });
    for (let index = 0; index < 2; index += 1) {
      await expect(
        methods.reconfirmSubscriberJurisdiction("subscriber-1", body),
      ).resolves.toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_subscriber_response_contract",
        },
      });
    }
    expect(calls).toHaveLength(3);
  });

  it("fails closed before transport when jurisdiction evidence lacks an exact strong subscriber revision", async () => {
    const { calls, methods } = createHarness();
    const base = {
      decision: "declined" as const,
      regime: "gdpr" as const,
      privacy_policy_version: "privacy-2026-07-19",
      captured_text: "I do not agree to receive marketing email.",
      expected_jurisdiction_changed_at: "2026-07-19T12:34:56.123456Z",
    };

    for (const expected_subscriber_version of [
      "",
      "*",
      'W/"subscriber:subscriber-1:v17"',
      '"subscriber:subscriber-1:v17", "subscriber:subscriber-1:v18"',
      '"campaign:subscriber-1:v17"',
    ]) {
      await expect(
        methods.reconfirmSubscriberJurisdiction("subscriber-1", {
          ...base,
          expected_subscriber_version,
        }),
      ).resolves.toMatchObject({
        error: {
          status: 428,
          code: "precondition_required",
        },
        retryability: "not-retryable",
      });
    }
    expect(calls).toEqual([]);
  });

  it("preserves filtered CSV export, authentication, truncation, and disposal", async () => {
    const signal = new AbortController().signal;
    const {
      controllerParents,
      controllerSignals,
      methods,
      nativeCalls,
      state,
    } = createHarness({
      nativeResponses: [
        new Response("csv", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="audience.csv"',
            "X-Postwave-Truncated": "true",
            "X-Postwave-Exported-Rows": "10000",
          },
        }),
      ],
    });

    await expect(
      methods.exportSubscribersCSV({
        limit: 10_000,
        status: "enabled",
        q: "Ada & Grace",
        includeArchived: true,
        sort: "created_at",
        order: "asc",
        signal,
      }),
    ).resolves.toMatchObject({
      data: {
        filename: "audience.csv",
        truncated: true,
        exportedRows: 10_000,
      },
    });

    expect(controllerParents).toEqual([signal]);
    expect(state).toEqual({ disposeCount: 1, errorResponseCount: 0 });
    expect(nativeCalls).toEqual([
      {
        input:
          "https://api.example.test/api/v1/subscribers/export.csv?limit=10000&status=enabled&q=Ada+%26+Grace&include_archived=true&sort=created_at&order=asc",
        init: {
          method: "GET",
          headers: {
            Accept: "text/csv",
            Authorization: "Bearer normalized-key",
          },
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: controllerSignals[0],
        },
      },
    ]);
  });

  it("does not send a non-positive limit and distrusts malformed row receipts", async () => {
    const { methods, nativeCalls } = createHarness({
      nativeResponses: [
        new Response("email\n", {
          status: 200,
          headers: { "X-Postwave-Exported-Rows": "not-a-count" },
        }),
      ],
    });

    await expect(
      methods.exportSubscribersCSV({ limit: 0 }),
    ).resolves.toMatchObject({
      data: { exportedRows: null, truncated: false },
    });
    expect(nativeCalls[0]?.input).toBe(
      "https://api.example.test/api/v1/subscribers/export.csv",
    );
  });

  it("preserves suppression, engagement, dedupe, merge, federation, and identify transports", async () => {
    const { calls, methods } = createHarness();
    const merge = {
      primary_id: "primary",
      duplicate_id: "duplicate",
      primary_version: '"subscriber:primary:v1"',
      duplicate_version: '"subscriber:duplicate:v1"',
    };
    const bulkMerge = { pairs: [merge] };
    const federation = {
      parent_tenant_id: "tenant/parent",
      master_subscriber_id: "master/one",
      match_type: "manual" as const,
      match_key: "crm:42",
    };
    const identify = {
      external_id: "crm/42",
      email: "ada@example.com",
      traits: { plan: "pro" },
    };

    await methods.suppressSubscriber("subscriber/one");
    await methods.getSubscriberEngagement("subscriber/one");
    await methods.getSubscriberEngagementBatch(["subscriber/one", 2]);
    await methods.listSubscriberDuplicates({ kind: "plus_alias", limit: 25 });
    await methods.mergeSubscribers(merge);
    await methods.bulkMergeSubscribers(bulkMerge);
    await methods.listSubscriberFederatedLinks("subscriber/one");
    const federationVersion = `"subscriber:subscriber-one:v1"`;
    await methods.createSubscriberFederatedLink(
      "subscriber/one",
      federation,
      federationVersion,
    );
    await methods.deleteSubscriberFederatedLink(
      "subscriber/one",
      "master/one",
      federationVersion,
    );
    await methods.identifySubscriber(identify);

    const root = "/api/v1/subscribers/subscriber%2Fone";
    expect(calls).toEqual([
      {
        path: `${root}/suppress`,
        init: {
          method: "POST",
          body: JSON.stringify({ reason: "manual" }),
        },
        opts: undefined,
      },
      { path: `${root}/engagement`, init: undefined, opts: undefined },
      {
        path: "/api/v1/subscribers/engagement?ids=subscriber%2Fone%2C2",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/duplicates?kind=plus_alias&limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/merge",
        init: { method: "POST", body: JSON.stringify(merge) },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
      {
        path: "/api/v1/subscribers/merge/bulk",
        init: { method: "POST", body: JSON.stringify(bulkMerge) },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
      { path: `${root}/federated-links`, init: undefined, opts: undefined },
      {
        path: `${root}/federated-links`,
        init: {
          method: "POST",
          headers: { "If-Match": federationVersion },
          body: JSON.stringify(federation),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${root}/federated-links/master%2Fone`,
        init: {
          method: "DELETE",
          headers: { "If-Match": federationVersion },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/subscribers/identify",
        init: { method: "POST", body: JSON.stringify(identify) },
        opts: { requireOnline: true, maxAttempts: 1 },
      },
    ]);
  });

  it("starts a complete duplicate scan and pages only its verified manifest", async () => {
    const scan = {
      scan_id: "scan-1",
      status: "complete",
      subscriber_count: 2105,
      candidate_count: 51,
      created_at: "2026-07-18T12:00:00Z",
      completed_at: "2026-07-18T12:00:01Z",
      expires_at: "2026-07-19T12:00:00Z",
      complete: true,
    };
    const controller = new AbortController();
    const { calls, methods } = createHarness({
      responses: [
        { data: scan },
        {
          data: {
            scan,
            count: 51,
            complete: true,
            pairs: [
              {
                kind: "plus_alias",
                primary_id: "primary-1",
                primary_email: "primary@example.test",
                duplicate_id: "duplicate-1",
                duplicate_email: "duplicate+source@example.test",
                confidence: 0.9,
                primary_updated_at: "2026-07-18T11:00:00Z",
                duplicate_updated_at: "2026-07-18T11:01:00Z",
                stale: false,
                evidence: [
                  {
                    kind: "plus_alias",
                    confidence: 0.9,
                    reason: "Plus normalization matches.",
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    await expect(
      methods.startSubscriberDuplicateScan({ signal: controller.signal }),
    ).resolves.toEqual({ data: scan });
    await expect(
      methods.listSubscriberDuplicateScanPairs("scan-1", {
        cursor: "50",
        limit: 50,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ data: { count: 51, complete: true } });
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/duplicate-scans",
        init: { method: "POST" },
        opts: {
          requireOnline: true,
          timeoutMs: 120_000,
          signal: controller.signal,
        },
      },
      {
        path: "/api/v1/subscribers/duplicate-scans/scan-1/pairs?cursor=50&limit=50",
        init: undefined,
        opts: { signal: controller.signal },
      },
    ]);
  });

  it("fails closed on a cross-scan or incomplete duplicate manifest", async () => {
    const { methods } = createHarness({
      responses: [
        {
          data: {
            scan: {
              scan_id: "different-scan",
              status: "complete",
              subscriber_count: 2,
              candidate_count: 1,
              created_at: "2026-07-18T12:00:00Z",
              expires_at: "2026-07-19T12:00:00Z",
              complete: true,
            },
            count: 1,
            complete: true,
            pairs: [],
          },
        },
      ],
    });
    await expect(
      methods.listSubscriberDuplicateScanPairs("scan-1"),
    ).resolves.toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      },
      retryability: "manual",
    });
  });

  it("rejects truncated or skipped duplicate-scan pages", async () => {
    const scan = {
      scan_id: "scan-1",
      status: "complete",
      subscriber_count: 3,
      candidate_count: 2,
      created_at: "2026-07-18T12:00:00Z",
      completed_at: "2026-07-18T12:00:01Z",
      expires_at: "2026-07-19T12:00:00Z",
      complete: true,
    };
    const pair = {
      kind: "plus_alias",
      primary_id: "primary-1",
      primary_email: "primary@example.test",
      duplicate_id: "duplicate-1",
      duplicate_email: "duplicate@example.test",
      confidence: 0.9,
      primary_updated_at: "2026-07-18T11:00:00Z",
      duplicate_updated_at: "2026-07-18T11:01:00Z",
      stale: false,
      evidence: [
        {
          kind: "plus_alias",
          confidence: 0.9,
          reason: "Plus normalization matches.",
        },
      ],
    };
    const { methods } = createHarness({
      responses: [
        {
          data: { scan, count: 2, complete: true, pairs: [pair] },
        },
        {
          data: {
            scan,
            count: 2,
            complete: true,
            pairs: [pair],
            next_cursor: "2",
          },
        },
      ],
    });

    for (let index = 0; index < 2; index += 1) {
      await expect(
        methods.listSubscriberDuplicateScanPairs("scan-1"),
      ).resolves.toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_subscriber_response_contract",
        },
      });
    }
  });

  it("rejects mismatched detail, engagement, merge, and federation identities", async () => {
    const { methods } = createHarness({
      responses: [
        { data: { id: "subscriber-other", email: "other@example.com" } },
        {
          data: {
            subscriber_id: "subscriber-other",
            email: "other@example.com",
            score: 20,
            counts: { sends: 0, opens: 0, clicks: 0, replies: 0 },
            window_days: 30,
            computed_at: "2026-07-18T10:00:00Z",
          },
        },
        {
          data: {
            primary_id: "primary-other",
            duplicate_id: "duplicate",
            events_moved: 0,
            suppressions_moved: 0,
            tags_merged: 0,
            custom_fields_merged: 0,
            primary_version: '"subscriber:primary-other:v2"',
          },
          serverVersion: '"subscriber:primary-other:v2"',
        },
        {
          data: {
            items: [
              {
                id: "link-1",
                child_subscriber_id: "subscriber-other",
                parent_tenant_id: "tenant-parent",
                master_subscriber_id: "master-1",
              },
            ],
            subscriber_version: '"subscriber:subscriber-1:v1"',
          },
          serverVersion: '"subscriber:subscriber-1:v1"',
        },
        {
          data: {
            id: "link-2",
            child_subscriber_id: "subscriber-1",
            parent_tenant_id: "tenant-other",
            master_subscriber_id: "master-1",
            subscriber_version: '"subscriber:subscriber-1:v2"',
          },
          serverVersion: '"subscriber:subscriber-1:v2"',
        },
      ],
    });

    const results = [
      await methods.reconfirmSubscriberJurisdiction("subscriber-1", {
        decision: "accepted",
        regime: "gdpr",
        privacy_policy_version: "privacy-2026-07",
        captured_text: "I consent to email marketing.",
        expected_jurisdiction_changed_at: "2026-07-18T10:00:00.123456Z",
        expected_subscriber_version: '"subscriber:subscriber-1:v1"',
      }),
      await methods.getSubscriberEngagement("subscriber-1"),
      await methods.mergeSubscribers({
        primary_id: "primary",
        duplicate_id: "duplicate",
        primary_version: '"subscriber:primary:v1"',
        duplicate_version: '"subscriber:duplicate:v1"',
      }),
      await methods.listSubscriberFederatedLinks("subscriber-1"),
      await methods.createSubscriberFederatedLink(
        "subscriber-1",
        {
          parent_tenant_id: "tenant-parent",
          master_subscriber_id: "master-1",
        },
        '"subscriber:subscriber-1:v1"',
      ),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });

  it("accepts only internally consistent currency-safe engagement reports", async () => {
    const valid = {
      subscriber_id: "subscriber-1",
      email: "reader@example.com",
      score: 72,
      counts: {
        sends: 10,
        opens: 6,
        clicks: 2,
        replies: 1,
        revenue_cents: 12_345,
        revenue_cents_saturated: false,
        revenue_currency: "USD",
        revenue_by_currency: [
          {
            currency: "USD",
            conversions: 2,
            revenue_cents: 12_345,
            revenue_cents_saturated: false,
          },
        ],
        mixed_currency: false,
        unclassified_monetary_conversions: 0,
      },
      window_days: 90,
      computed_at: "2026-07-19T10:00:00Z",
    };
    const controller = new AbortController();
    const { calls, methods } = createHarness({ responses: [{ data: valid }] });

    await expect(
      methods.getSubscriberEngagement("subscriber-1", {
        signal: controller.signal,
      }),
    ).resolves.toEqual({ data: valid });
    expect(calls[0]?.opts).toEqual({ signal: controller.signal });

    const malformed = [
      { ...valid, counts: { ...valid.counts, sends: -1 } },
      {
        ...valid,
        counts: { ...valid.counts, revenue_currency: "usd" },
      },
      {
        ...valid,
        counts: { ...valid.counts, mixed_currency: true },
      },
      {
        ...valid,
        counts: {
          ...valid.counts,
          revenue_by_currency: [
            ...valid.counts.revenue_by_currency,
            ...valid.counts.revenue_by_currency,
          ],
          mixed_currency: true,
        },
      },
      { ...valid, computed_at: "not-a-date" },
    ];
    for (const data of malformed) {
      const harness = createHarness({ responses: [{ data }] });
      const result = (await harness.methods.getSubscriberEngagement(
        "subscriber-1",
      )) as ApiErr;
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      });
    }
  });

  it("preserves import lifecycle, remap, progress, and template transports", async () => {
    const { calls, methods, streamPaths } = createHarness();
    const importId = "018f07e2-7b1a-7000-8000-000000000001";
    const file = new File(["email\nada@example.com"], "audience.csv", {
      type: "text/csv",
    });
    const patch = {
      configuration_revision: 0,
      mapping: {
        path: "imports/tenant/source.csv",
        headers: ["email"],
        columns: [{ index: 0, name: "email", kind: "email" as const }],
        rows: 1,
      },
      on_existing: "update" as const,
      consent_scope_acknowledged: false,
      tags: ["imported"],
      auto_create_properties: true,
      schedule_type: "immediate" as const,
      schedule_cron: "" as const,
      scheduled_at: "" as const,
      drip_hours_interval: 0 as const,
      drip_hours_total: 0 as const,
    };
    const template = {
      name: "Conference import",
      mapping: patch.mapping,
      source_hint: "conference",
    };

    await methods.previewSubscriberImport(file, {
      idempotencyKey: "preview-flight-1",
    });
    await methods.patchSubscriberImport(importId, patch);
    await methods.confirmSubscriberImport(importId, { dry_run: true });
    await methods.getSubscriberImport(importId);
    await methods.cancelSubscriberImport(importId);
    await methods.getImportRemapOptions();
    await expect(
      methods.subscriberImportProgressUrlAuthed(importId),
    ).resolves.toBe(`stream:/api/v1/subscriber-imports/${importId}/progress`);
    await methods.listSubscriberImportTemplates();
    await methods.saveSubscriberImportTemplate(template);
    await methods.deleteSubscriberImportTemplate("template/one");

    expect(streamPaths).toEqual([
      `/api/v1/subscriber-imports/${importId}/progress`,
    ]);
    expect(calls).toHaveLength(9);
    expect(calls[0]?.path).toBe("/api/v1/subscriber-imports/preview");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      "Idempotency-Key": "preview-flight-1",
    });
    expect(calls[0]?.opts).toEqual({
      requireOnline: true,
      signal: undefined,
      timeoutMs: 300_000,
      maxAttempts: 1,
    });
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    expect((calls[0]?.init?.body as FormData).get("file")).toBe(file);
    expect(calls.slice(1)).toEqual([
      {
        path: `/api/v1/subscriber-imports/${importId}`,
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: {
          requireOnline: true,
          signal: undefined,
          timeoutMs: 60_000,
          maxAttempts: 1,
        },
      },
      {
        path: `/api/v1/subscriber-imports/${importId}/confirm`,
        init: {
          method: "POST",
          body: JSON.stringify({ dry_run: true }),
        },
        opts: {
          requireOnline: true,
          signal: undefined,
          timeoutMs: 300_000,
          maxAttempts: 1,
        },
      },
      {
        path: `/api/v1/subscriber-imports/${importId}`,
        init: undefined,
        opts: {
          requireOnline: true,
          signal: undefined,
          timeoutMs: 60_000,
          maxAttempts: 1,
        },
      },
      {
        path: `/api/v1/subscriber-imports/${importId}/cancel`,
        init: { method: "POST", body: "{}" },
        opts: {
          requireOnline: true,
          signal: undefined,
          timeoutMs: 60_000,
          maxAttempts: 1,
        },
      },
      {
        path: "/api/v1/subscriber-imports/remap-options",
        init: undefined,
        opts: {
          requireOnline: true,
          signal: undefined,
          timeoutMs: 60_000,
          maxAttempts: 1,
        },
      },
      {
        path: "/api/v1/subscriber-import-templates",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscriber-import-templates",
        init: { method: "POST", body: JSON.stringify(template) },
        opts: undefined,
      },
      {
        path: "/api/v1/subscriber-import-templates/template%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves every bulk mutation and the native segmented CSV export", async () => {
    const signal = new AbortController().signal;
    const {
      calls,
      controllerParents,
      controllerSignals,
      methods,
      nativeCalls,
      state,
    } = createHarness({
      nativeResponses: [
        new Response("bulk-csv", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="segment.csv"',
          },
        }),
      ],
    });
    const ids = ["subscriber-one", "subscriber-two"];
    const consentProvenance = {
      source: "double_optin",
      channel: "email",
      legal_basis: "consent",
      occurred_at: "2026-07-01T10:30:00.000Z",
      jurisdiction: "GB",
      evidence: "receipt:consent-123",
      reason: "Reviewed the double opt-in receipt.",
      policy_version: "privacy-2026-07",
    } as const;
    const operations = [
      [methods.bulkTagSubscribers, { subscriber_ids: ids, tag: "vip" }],
      [methods.bulkUntagSubscribers, { subscriber_ids: ids, tag: "old" }],
      [methods.bulkUnsubscribeSubscribers, { subscriber_ids: ids }],
      [methods.bulkDeleteSubscribers, { subscriber_ids: ids }],
      [methods.bulkRecoverSubscribers, { recovery_token: "recover/one" }],
      [
        methods.bulkResubscribeSubscribers,
        { subscriber_ids: ids, ...consentProvenance },
      ],
      [
        methods.bulkAddToListSubscribers,
        { subscriber_ids: ids, list_id: "list/one" },
      ],
      [
        methods.bulkSetCustomFieldSubscribers,
        {
          subscriber_ids: ids,
          key: "plan",
          value: "pro",
          remove: false,
        },
      ],
      [
        methods.bulkUpdateMergeFieldSubscribers,
        { subscriber_ids: ids, key: "FNAME", remove: true },
      ],
      [
        methods.bulkGrantConsentSubscribers,
        {
          subscriber_ids: ids,
          category: "marketing",
          ...consentProvenance,
        },
      ],
      [
        methods.bulkRevokeConsentSubscribers,
        {
          subscriber_ids: ids,
          category: "email_tracking",
          ...consentProvenance,
        },
      ],
    ] as const;

    for (const [operation, input] of operations) {
      await operation(input as never);
    }
    const exportInput = {
      subscriber_ids: ids,
      segment_id: "segment/one",
      limit: 100,
      signal,
    };
    await expect(
      methods.bulkExportSubscribersBySegment(exportInput),
    ).resolves.toMatchObject({ data: { filename: "segment.csv" } });

    const routes = [
      "/api/v1/subscribers/bulk/tag",
      "/api/v1/subscribers/bulk/untag",
      "/api/v1/subscribers/bulk/unsubscribe",
      "/api/v1/subscribers/bulk/delete",
      "/api/v1/subscribers/bulk/recover",
      "/api/v1/subscribers/bulk/resubscribe",
      "/api/v1/subscribers/bulk/add-to-list",
      "/api/v1/subscribers/bulk/set-custom-field",
      "/api/v1/subscribers/bulk/update-merge-field",
      "/api/v1/subscribers/bulk/grant-consent",
      "/api/v1/subscribers/bulk/revoke-consent",
    ];
    expect(calls).toEqual(
      operations.map(([, input], index) => ({
        path: routes[index],
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      })),
    );
    expect(controllerParents).toEqual([signal]);
    expect(state).toEqual({ disposeCount: 1, errorResponseCount: 0 });
    expect(nativeCalls).toEqual([
      {
        input:
          "https://api.example.test/api/v1/subscribers/bulk/export-by-segment",
        init: {
          method: "POST",
          headers: {
            Accept: "text/csv",
            "Content-Type": "application/json",
            "X-Postwave-Client": "desktop",
            Authorization: "Bearer normalized-key",
          },
          body: JSON.stringify({
            subscriber_ids: ids,
            segment_id: "segment/one",
            limit: 100,
          }),
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: controllerSignals[0],
        },
      },
    ]);
  });

  it("preserves HTTP and transport error passthrough while always disposing downloads", async () => {
    const { methods, nativeCalls, normalizedKeys, state } = createHarness({
      apiKey: null,
      normalizedApiKey: null,
      nativeResponses: [
        new Response("denied", { status: 403 }),
        new Error("native transport unavailable"),
      ],
    });

    await expect(methods.exportSubscribersCSV()).resolves.toEqual({
      error: { kind: "http", status: 403, message: "HTTP 403" },
    });
    await expect(
      methods.bulkExportSubscribersBySegment({ subscriber_ids: ["one"] }),
    ).resolves.toEqual({
      error: { kind: "network", message: "native transport unavailable" },
    });

    expect(state).toEqual({ disposeCount: 2, errorResponseCount: 1 });
    expect(normalizedKeys).toEqual([null, null]);
    expect(nativeCalls).toHaveLength(2);
    expect(nativeCalls[0]?.init?.headers).toEqual({ Accept: "text/csv" });
    expect(nativeCalls[1]?.init?.headers).toEqual({
      Accept: "text/csv",
      "Content-Type": "application/json",
      "X-Postwave-Client": "desktop",
    });
  });
});
