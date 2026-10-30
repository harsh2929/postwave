import { describe, expect, it } from "vitest";

import {
  listsExtendedApi,
  PUSH_PLATFORMS as FACADE_PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS as FACADE_PUSH_SUPPRESSION_REASONS,
  pushSuppressionsApi,
  segmentsExtendedApi,
  SMS_SUPPRESSION_REASONS as FACADE_SMS_SUPPRESSION_REASONS,
  smsQuietHoursApi,
  smsSuppressionsApi,
  subscriberSubscriptionTypesApi,
  subscriptionTypesApi,
  SUPPRESSION_REASONS_X1 as FACADE_SUPPRESSION_REASONS_X1,
  suppressionsConvergedApi,
} from "../../lib/api-client";
import {
  createListsAndSuppressionsApis,
  PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
  SMS_SUPPRESSION_REASONS,
  SUPPRESSION_REASONS_X1,
  type SubscriptionType,
  type SuppressionEntry,
} from "../../lib/api/lists-and-suppressions";
import type { ApiRequesterOptions, ApiResult } from "../../lib/api/result";

type DomainRequester = Parameters<typeof createListsAndSuppressionsApis>[0];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  options?: ApiRequesterOptions;
}

function recordingRequester(responses: ApiResult<unknown>[] = []): {
  calls: RequestCall[];
  request: DomainRequester;
} {
  const calls: RequestCall[] = [];
  const request: DomainRequester = async <T>(
    path: string,
    init?: RequestInit,
    options?: ApiRequesterOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, ...(options ? { options } : {}) });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  return { calls, request };
}

const DOMAIN_OPERATIONS = {
  suppressionsConvergedApi: ["list", "get", "add", "remove"],
  subscriptionTypesApi: ["list", "get", "create", "update", "remove"],
  subscriberSubscriptionTypesApi: ["list", "optOut", "optIn"],
  listsExtendedApi: [
    "get",
    "patch",
    "members",
    "addMembers",
    "removeMember",
    "suppressions",
  ],
  segmentsExtendedApi: ["previewCount", "recompute"],
  smsSuppressionsApi: ["list", "add", "remove"],
  pushSuppressionsApi: ["list", "add", "remove", "bulkImport", "bulkRemove"],
  smsQuietHoursApi: ["list", "create", "update", "remove"],
} as const;

const COMPOSED_FACADES = {
  suppressionsConvergedApi,
  subscriptionTypesApi,
  subscriberSubscriptionTypesApi,
  listsExtendedApi,
  segmentsExtendedApi,
  smsSuppressionsApi,
  pushSuppressionsApi,
  smsQuietHoursApi,
};

function suppression(email: string): SuppressionEntry {
  return {
    id: email,
    email,
    reason: "manual_unsubscribe",
    source: "manual",
    created_at: "2026-07-15T00:00:00Z",
  };
}

function subscriptionType(id: string): SubscriptionType {
  return {
    id,
    tenant_id: "tenant_1",
    name: "Product updates",
    description: "Product news",
    channel: "email",
    is_default: false,
    is_internal: false,
    sort_order: 1,
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

describe("lists and suppressions API extraction contracts", () => {
  it("retains every sub-facade operation and runtime constant identity", () => {
    const { request } = recordingRequester();
    const created = createListsAndSuppressionsApis(request);

    expect(Object.keys(created)).toEqual(Object.keys(DOMAIN_OPERATIONS));
    for (const name of Object.keys(
      DOMAIN_OPERATIONS,
    ) as (keyof typeof DOMAIN_OPERATIONS)[]) {
      expect(Object.keys(created[name])).toEqual(DOMAIN_OPERATIONS[name]);
      expect(Object.keys(COMPOSED_FACADES[name])).toEqual(
        DOMAIN_OPERATIONS[name],
      );
    }

    expect(FACADE_SUPPRESSION_REASONS_X1).toBe(SUPPRESSION_REASONS_X1);
    expect(FACADE_SMS_SUPPRESSION_REASONS).toBe(SMS_SUPPRESSION_REASONS);
    expect(FACADE_PUSH_SUPPRESSION_REASONS).toBe(PUSH_SUPPRESSION_REASONS);
    expect(FACADE_PUSH_PLATFORMS).toBe(PUSH_PLATFORMS);
  });

  it("preserves converged suppression request paths, bodies, and encoding", async () => {
    const { calls, request } = recordingRequester();
    const { suppressionsConvergedApi: api } =
      createListsAndSuppressionsApis(request);

    await api.list({
      page: 2,
      size: 50,
      email: "A+B@example.test",
      q: "active & exact",
    });
    await api.add({
      email: "A+B@example.test",
      reason: "manual_unsubscribe",
      channel: "email",
      scope: "marketing",
    });
    await api.remove("A+B/path@example.test");

    expect(calls).toEqual([
      {
        path: "/api/v1/deliverability/suppressions?page=2&size=50&email=A%2BB%40example.test&q=active+%26+exact",
        init: undefined,
      },
      {
        path: "/api/v1/deliverability/suppressions",
        init: {
          method: "POST",
          body: JSON.stringify({
            email: "A+B@example.test",
            reason: "manual_unsubscribe",
            channel: "email",
            scope: "marketing",
          }),
        },
      },
      {
        path: "/api/v1/deliverability/suppressions/A%2BB%2Fpath%40example.test",
        init: { method: "DELETE" },
      },
    ]);
  });

  it("keeps exact-filter get behavior, honest misses, and the legacy scan", async () => {
    const exact = suppression("Target@example.test");
    const exactRecorder = recordingRequester([
      { data: { items: [exact], total: 1, page: 1, size: 1 } },
    ]);
    const exactResult = await createListsAndSuppressionsApis(
      exactRecorder.request,
    ).suppressionsConvergedApi.get("  Target@example.test  ");

    expect(exactResult).toEqual({ data: exact });
    expect(exactRecorder.calls).toEqual([
      {
        path: "/api/v1/deliverability/suppressions?size=1&email=Target%40example.test",
        init: undefined,
      },
    ]);

    const missingRecorder = recordingRequester([
      { data: { items: [], total: 0, page: 1, size: 1 } },
    ]);
    const missing = await createListsAndSuppressionsApis(
      missingRecorder.request,
    ).suppressionsConvergedApi.get("missing@example.test");
    expect(missing).toEqual({
      error: {
        message: "no suppression for email",
        kind: "http",
        status: 404,
        code: "not_found",
      },
    });

    const legacy = suppression("legacy@example.test");
    const legacyRecorder = recordingRequester([
      {
        error: {
          message: "unknown email parameter",
          kind: "http",
          status: 400,
        },
      },
      { data: { items: [legacy], total: 1, page: 1, size: 200 } },
    ]);
    const legacyResult = await createListsAndSuppressionsApis(
      legacyRecorder.request,
    ).suppressionsConvergedApi.get("LEGACY@example.test");

    expect(legacyResult).toEqual({ data: legacy });
    expect(legacyRecorder.calls).toEqual([
      {
        path: "/api/v1/deliverability/suppressions?size=1&email=LEGACY%40example.test",
        init: undefined,
      },
      {
        path: "/api/v1/deliverability/suppressions?page=1&size=200",
        init: undefined,
      },
    ]);
  });

  it("never turns an exhausted legacy lookup budget into a false 404", async () => {
    const fullPage = Array.from({ length: 200 }, (_, index) =>
      suppression(`other-${index}@example.test`),
    );
    const { calls, request } = recordingRequester([
      {
        error: { message: "unsupported", kind: "http", status: 400 },
      },
      ...Array.from({ length: 5 }, (_, index) => ({
        data: {
          items: fullPage,
          total: 2_000,
          page: index + 1,
          size: 200,
        },
      })),
    ]);

    const result = await createListsAndSuppressionsApis(
      request,
    ).suppressionsConvergedApi.get("never-reached@example.test");

    expect(result.error?.code).toBe("scan_truncated");
    expect(result.error?.message).toContain("scanned 1000 of 2000");
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)?.path).toBe(
      "/api/v1/deliverability/suppressions?page=5&size=200",
    );
  });

  it("passes upstream errors through exact lookups, legacy scans, and type lists", async () => {
    const exactFailure: ApiResult<unknown> = {
      error: {
        message: "service unavailable",
        kind: "http",
        status: 503,
        code: "unavailable",
      },
    };
    const exactRecorder = recordingRequester([exactFailure]);
    const exactResult = await createListsAndSuppressionsApis(
      exactRecorder.request,
    ).suppressionsConvergedApi.get("reader@example.test");
    expect(exactResult).toEqual(exactFailure);
    expect(exactRecorder.calls).toHaveLength(1);

    const scanFailure: ApiResult<unknown> = {
      error: { message: "offline", kind: "network" },
    };
    const scanRecorder = recordingRequester([
      {
        error: { message: "unsupported", kind: "http", status: 400 },
      },
      scanFailure,
    ]);
    const scanResult = await createListsAndSuppressionsApis(
      scanRecorder.request,
    ).suppressionsConvergedApi.get("reader@example.test");
    expect(scanResult).toEqual(scanFailure);
    expect(scanRecorder.calls).toHaveLength(2);

    const typeFailure: ApiResult<unknown> = {
      error: { message: "timed out", kind: "timeout" },
    };
    const typeRecorder = recordingRequester([typeFailure]);
    const typeResult = await createListsAndSuppressionsApis(
      typeRecorder.request,
    ).subscriptionTypesApi.get("type_1");
    expect(typeResult).toEqual(typeFailure);
    expect(typeRecorder.calls).toEqual([
      { path: "/api/v1/subscription-types", init: undefined },
    ]);
  });

  it("preserves subscription-type and subscriber opt-out contracts", async () => {
    const { calls, request } = recordingRequester();
    const { subscriptionTypesApi: types, subscriberSubscriptionTypesApi } =
      createListsAndSuppressionsApis(request);

    await types.list({ channel: "sms" });
    await types.create({
      name: "Alerts",
      description: "Important alerts",
      channel: "sms",
      is_default: true,
      sort_order: 2,
    });
    await types.update("type/one", { name: "Renamed", sort_order: 3 });
    await types.remove("type/one");
    await subscriberSubscriptionTypesApi.list("subscriber/one");
    await subscriberSubscriptionTypesApi.optOut("subscriber/one", "type/one", {
      channel: "sms",
      source: "admin",
      source_event_id: "event_1",
    });
    await subscriberSubscriptionTypesApi.optIn("subscriber/one", "type/one", {
      channel: "sms",
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/subscription-types?channel=sms",
        init: undefined,
      },
      {
        path: "/api/v1/subscription-types",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Alerts",
            description: "Important alerts",
            channel: "sms",
            is_default: true,
            sort_order: 2,
          }),
        },
      },
      {
        path: "/api/v1/subscription-types/type%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({ name: "Renamed", sort_order: 3 }),
        },
      },
      {
        path: "/api/v1/subscription-types/type%2Fone",
        init: { method: "DELETE" },
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/subscription-types",
        init: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/subscription-types/type%2Fone/opt-out",
        init: {
          method: "POST",
          body: JSON.stringify({
            channel: "sms",
            source: "admin",
            source_event_id: "event_1",
          }),
        },
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/subscription-types/type%2Fone/opt-out?channel=sms",
        init: { method: "DELETE" },
      },
    ]);
  });

  it("keeps subscription-type singleton lookup success and honest misses", async () => {
    const expected = subscriptionType("type_1");
    const foundRecorder = recordingRequester([{ data: [expected] }]);
    const found = await createListsAndSuppressionsApis(
      foundRecorder.request,
    ).subscriptionTypesApi.get("type_1");
    expect(found).toEqual({ data: expected });
    expect(foundRecorder.calls).toEqual([
      { path: "/api/v1/subscription-types", init: undefined },
    ]);

    const missingRecorder = recordingRequester([{ data: [expected] }]);
    const missing = await createListsAndSuppressionsApis(
      missingRecorder.request,
    ).subscriptionTypesApi.get("type_2");
    expect(missing).toEqual({
      error: {
        message: "subscription type not found",
        kind: "http",
        status: 404,
        code: "not_found",
      },
    });
  });

  it("preserves list and segment routes, query order, bodies, and encoding", async () => {
    const { calls, request } = recordingRequester();
    const { listsExtendedApi: lists, segmentsExtendedApi: segments } =
      createListsAndSuppressionsApis(request);

    await lists.get("list/one");
    await lists.patch("list/one", {
      name: "VIP list",
      tags: ["vip", "active"],
    });
    await lists.members("list/one", {
      query: "reader & vip",
      status: "enabled",
      page: 2,
      perPage: 25,
    });
    await lists.addMembers("list/one", ["sub_1", "sub_2"]);
    await lists.removeMember("list/one", "subscriber/two");
    await lists.suppressions("list/one", { page: 3, perPage: 50 });
    await segments.previewCount({ queryAst: { op: "and" }, text: "VIP" });
    await segments.recompute("segment/one");

    expect(calls).toEqual([
      { path: "/api/v1/lists/list%2Fone", init: undefined },
      {
        path: "/api/v1/lists/list%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            name: "VIP list",
            tags: ["vip", "active"],
          }),
        },
      },
      {
        path: "/api/v1/lists/list%2Fone/subscribers?query=reader+%26+vip&status=enabled&page=2&per_page=25",
        init: undefined,
      },
      {
        path: "/api/v1/lists/list%2Fone/subscribers",
        init: {
          method: "POST",
          body: JSON.stringify({ subscriber_ids: ["sub_1", "sub_2"] }),
        },
      },
      {
        path: "/api/v1/lists/list%2Fone/subscribers/subscriber%2Ftwo",
        init: { method: "DELETE" },
      },
      {
        path: "/api/v1/lists/list%2Fone/suppressions?page=3&per_page=50",
        init: undefined,
      },
      {
        path: "/api/v1/segments/preview-count",
        init: {
          method: "POST",
          body: JSON.stringify({ queryAst: { op: "and" }, text: "VIP" }),
        },
      },
      {
        path: "/api/v1/segments/segment%2Fone/recompute",
        init: { method: "POST" },
      },
    ]);
  });

  it("retains local list member batch guards without issuing requests", async () => {
    const { calls, request } = recordingRequester();
    const { listsExtendedApi: lists } = createListsAndSuppressionsApis(request);

    await expect(lists.addMembers("list_1", [])).resolves.toEqual({
      data: { added: 0, skipped: 0 },
    });
    const tooMany = await lists.addMembers(
      "list_1",
      Array.from({ length: 1_001 }, (_, index) => `sub_${index}`),
    );

    expect(tooMany).toEqual({
      error: {
        kind: "invalid_config",
        message: "addMembers accepts at most 1000 subscriber ids per call.",
      },
    });
    expect(calls).toEqual([]);
  });

  it("preserves SMS, push, and quiet-hours transport contracts", async () => {
    const tenantId = "00000000-0000-0000-0000-000000000001";
    const suppressionId = "11111111-1111-4111-8111-111111111111";
    const manualId = "22222222-2222-4222-8222-222222222222";
    const snapshotAt = "2026-08-28T10:00:00Z";
    const { calls, request } = recordingRequester([
      {
        data: {
          tenantId,
          items: [
            {
              id: suppressionId,
              phone_e164: "+12025550118",
              reason: "stop_keyword",
              source: "twilio",
              reversible: false,
              locked_reason: "carrier_or_system_authority",
              created_at: "2026-08-28T09:00:00Z",
            },
          ],
          total: 1,
          snapshotAt,
        },
      },
      { data: { tenantId, items: [], total: 0, snapshotAt } },
      {
        data: {
          id: manualId,
          phone_e164: "+12025550119",
          reason: "manual",
          source: "manual",
          reversible: true,
          created_at: "2026-08-28T09:30:00Z",
        },
      },
      { data: { ok: true, tenantId, id: manualId } },
    ]);
    const {
      smsSuppressionsApi: sms,
      pushSuppressionsApi: push,
      smsQuietHoursApi: quiet,
    } = createListsAndSuppressionsApis(request, {
      getTenantId: () => tenantId,
      getApiIdentityGeneration: () => 7,
    });

    const abort = new AbortController();
    await sms.list({
      reason: "stop_keyword",
      phone: "+12025550118",
      signal: abort.signal,
    });
    await sms.list({ reason: "manual", limit: 25 });
    await sms.add({ phone: "+12025550119", reason: "manual" });
    await sms.remove(manualId);
    await push.list({ platform: "web", reason: "user_opt_out" });
    await push.add({
      device_token: "fcm-token-with-enough-entropy-123",
      platform: "fcm",
      reason: "manual",
    });
    await push.remove("33333333-3333-4333-8333-333333333333", {
      expected_version: 4,
    });
    const policyAbort = new AbortController();
    await quiet.list({ signal: policyAbort.signal });
    await quiet.create(
      {
        label: "Tenant overnight",
        country_code: "",
        start_minute: 1_260,
        end_minute: 480,
        days: [1, 2, 3, 4, 5],
        timezone: "America/New_York",
        enabled: true,
      },
      { signal: policyAbort.signal },
    );
    await quiet.update(
      "quiet/id",
      {
        enabled: false,
        label: "Paused",
        expected_updated_at: "2026-08-28T09:00:00Z",
      },
      { signal: policyAbort.signal },
    );
    await quiet.remove(
      "quiet/id",
      { expected_updated_at: "2026-08-28T09:01:00Z" },
      { signal: policyAbort.signal },
    );

    expect(calls).toEqual([
      {
        path: "/api/v1/sms/suppressions/query",
        init: {
          method: "POST",
          body: JSON.stringify({
            phone: "+12025550118",
            reason: "stop_keyword",
          }),
          signal: abort.signal,
        },
        options: { idempotencyKey: null, requireOnline: true },
      },
      {
        path: "/api/v1/sms/suppressions?reason=manual&limit=25",
        init: undefined,
      },
      {
        path: "/api/v1/sms/suppressions",
        init: {
          method: "POST",
          body: JSON.stringify({ phone: "+12025550119", reason: "manual" }),
        },
      },
      {
        path: `/api/v1/sms/suppressions/${manualId}`,
        init: { method: "DELETE" },
      },
      {
        path: "/api/v1/push/suppressions?platform=web&reason=user_opt_out&limit=50",
        init: undefined,
      },
      {
        path: "/api/v1/push/suppressions",
        init: {
          method: "POST",
          body: JSON.stringify({
            device_token: "fcm-token-with-enough-entropy-123",
            platform: "fcm",
            reason: "manual",
          }),
        },
        options: { requireOnline: true },
      },
      {
        path: "/api/v1/push/suppressions/33333333-3333-4333-8333-333333333333",
        init: {
          method: "DELETE",
          body: JSON.stringify({ expected_version: 4 }),
        },
        options: { requireOnline: true },
      },
      {
        path: "/api/v1/sms/quiet-hours",
        init: { signal: policyAbort.signal },
      },
      {
        path: "/api/v1/sms/quiet-hours",
        init: {
          method: "POST",
          body: JSON.stringify({
            label: "Tenant overnight",
            country_code: "",
            start_minute: 1_260,
            end_minute: 480,
            days: [1, 2, 3, 4, 5],
            timezone: "America/New_York",
            enabled: true,
          }),
          signal: policyAbort.signal,
        },
      },
      {
        path: "/api/v1/sms/quiet-hours/quiet%2Fid",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            enabled: false,
            label: "Paused",
            expected_updated_at: "2026-08-28T09:00:00Z",
          }),
          signal: policyAbort.signal,
        },
      },
      {
        path: "/api/v1/sms/quiet-hours/quiet%2Fid",
        init: {
          method: "DELETE",
          body: JSON.stringify({
            expected_updated_at: "2026-08-28T09:01:00Z",
          }),
          signal: policyAbort.signal,
        },
      },
    ]);
  });

  it("fails closed on malformed private suppression pages and invalid local inputs", async () => {
    const tenantId = "00000000-0000-0000-0000-000000000001";
    const validRow = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      phone_e164: "+12025550118",
      reason: "manual",
      source: "manual",
      reversible: true,
      created_at: "2026-08-28T09:00:00Z",
    };
    const validPage = {
      tenantId,
      items: [validRow],
      total: 1,
      snapshotAt: "2026-08-28T10:00:00Z",
    };
    const invalidPages = [
      { ...validPage, items: [{ ...validRow, id: validRow.id.toUpperCase() }] },
      {
        ...validPage,
        items: [{ ...validRow, created_at: "2026-02-30T09:00:00Z" }],
      },
      { ...validPage, total: Number.MAX_SAFE_INTEGER + 1 },
      { ...validPage, nextCursor: "v1.bad\ncontrol" },
      { ...validPage, snapshotAt: "2026-08-28T10:00:00+14:30" },
    ];

    for (const page of invalidPages) {
      const { request } = recordingRequester([{ data: page }]);
      const api = createListsAndSuppressionsApis(request, {
        getTenantId: () => tenantId,
        getApiIdentityGeneration: () => 3,
      }).smsSuppressionsApi;
      await expect(api.list({ limit: 25 })).resolves.toMatchObject({
        error: { code: "invalid_sms_suppression_response" },
      });
    }

    for (const exactPage of [
      { ...validPage, total: 2 },
      { ...validPage, total: 2, nextCursor: "v1.more_exact_rows" },
    ]) {
      const { request: exactRequest } = recordingRequester([
        { data: exactPage },
      ]);
      const exactApi = createListsAndSuppressionsApis(exactRequest, {
        getTenantId: () => tenantId,
        getApiIdentityGeneration: () => 3,
      }).smsSuppressionsApi;
      await expect(
        exactApi.list({ phone: validRow.phone_e164 }),
      ).resolves.toMatchObject({
        error: { code: "invalid_sms_suppression_response" },
      });
    }

    const { calls, request } = recordingRequester();
    const api = createListsAndSuppressionsApis(request, {
      getTenantId: () => tenantId,
      getApiIdentityGeneration: () => 3,
    }).smsSuppressionsApi;
    await expect(api.list({ phone: "+1202" })).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_request" },
    });
    await expect(api.list({ cursor: "" })).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_request" },
    });
    await expect(api.list({ cursor: "v1.non_ascii_é" })).resolves.toMatchObject(
      { error: { code: "invalid_sms_suppression_request" } },
    );
    await expect(
      api.list({
        phone: "+12025550118",
        cursor: "v1.encrypted_cursor_token",
      }),
    ).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_request" },
    });
    await expect(
      api.list({ phone: "+12025550118", limit: 1 }),
    ).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_request" },
    });
    await expect(api.remove(validRow.id.toUpperCase())).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_request" },
    });
    expect(calls).toEqual([]);

    const { request: badDeleteRequest } = recordingRequester([
      {
        data: {
          ok: true,
          tenantId: "00000000-0000-0000-0000-000000000002",
          id: validRow.id,
        },
      },
    ]);
    const badDeleteApi = createListsAndSuppressionsApis(badDeleteRequest, {
      getTenantId: () => tenantId,
      getApiIdentityGeneration: () => 3,
    }).smsSuppressionsApi;
    await expect(badDeleteApi.remove(validRow.id)).resolves.toMatchObject({
      error: { code: "invalid_sms_suppression_response" },
    });
  });

  it("discards list and mutation receipts after an A-to-B-to-A identity epoch race", async () => {
    const tenantA = "00000000-0000-0000-0000-000000000001";
    const tenantB = "00000000-0000-0000-0000-000000000002";
    const row = {
      id: "11111111-1111-4111-8111-111111111111",
      phone_e164: "+12025550118",
      reason: "manual",
      source: "manual",
      reversible: true,
      created_at: "2026-08-28T09:00:00Z",
    };
    let tenant = tenantA;
    let generation = 1;
    let resolveList!: (result: ApiResult<unknown>) => void;
    const listPending = new Promise<ApiResult<unknown>>((resolve) => {
      resolveList = resolve;
    });
    const listRequest = (<T>() =>
      listPending as Promise<ApiResult<T>>) as DomainRequester;
    const listApi = createListsAndSuppressionsApis(listRequest, {
      getTenantId: () => tenant,
      getApiIdentityGeneration: () => generation,
    }).smsSuppressionsApi;
    const resultPending = listApi.list({ limit: 25 });
    tenant = tenantB;
    generation = 2;
    tenant = tenantA;
    generation = 3;
    resolveList({
      data: {
        tenantId: tenantA,
        items: [row],
        total: 1,
        snapshotAt: "2026-08-28T10:00:00Z",
      },
    });
    await expect(resultPending).resolves.toMatchObject({
      error: { code: "identity_changed" },
    });

    let resolveMutation!: (result: ApiResult<unknown>) => void;
    const mutationPending = new Promise<ApiResult<unknown>>((resolve) => {
      resolveMutation = resolve;
    });
    const mutationRequest = (<T>() =>
      mutationPending as Promise<ApiResult<T>>) as DomainRequester;
    const mutationApi = createListsAndSuppressionsApis(mutationRequest, {
      getTenantId: () => tenant,
      getApiIdentityGeneration: () => generation,
    }).smsSuppressionsApi;
    const addPending = mutationApi.add({
      phone: row.phone_e164,
      reason: "manual",
    });
    tenant = tenantB;
    generation = 4;
    tenant = tenantA;
    generation = 5;
    resolveMutation({ data: row });
    await expect(addPending).resolves.toMatchObject({
      error: { code: "identity_changed" },
    });
  });
});
