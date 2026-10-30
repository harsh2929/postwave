import { describe, expect, it } from "vitest";

import {
  compileSegmentFromText,
  createInboundTrigger,
  createLookalikeAudience,
  createMergeFieldSchema,
  createSavedSegment,
  createSegmentFolder,
  deleteInboundTrigger,
  deleteLookalikeAudience,
  deleteMergeFieldSchema,
  deleteSavedSegment,
  deleteSegmentFolder,
  getABResults,
  getABWeightHistory,
  getLookalikeAudience,
  getSegmentAIProcessingDisclosure,
  getSubscriberMergeFields,
  getSubscriberSendTimes,
  getSubscribersViewPrefs,
  listInboundTriggers,
  listLookalikeAudienceMembers,
  listMergeFieldSchema,
  listSavedSegments,
  listSegmentFolders,
  listSubscriberAttributeHistory,
  listSubscriberHistory,
  LOOKALIKE_DEFAULT_SIZE as FACADE_LOOKALIKE_DEFAULT_SIZE,
  LOOKALIKE_MAX_SIZE as FACADE_LOOKALIKE_MAX_SIZE,
  LOOKALIKE_MIN_SIZE as FACADE_LOOKALIKE_MIN_SIZE,
  patchMergeFieldSchema,
  patchSavedSegment,
  patchSegmentFolder,
  patchSubscriberMergeFields,
  previewCompiledSegment,
  previewSavedSegment,
  previewSavedSegmentDetail,
  putSubscribersViewPrefs,
  setSubscriberRating,
  updateInboundTrigger,
} from "../../lib/api-client";
import {
  createAudienceSegmentationMethods,
  LOOKALIKE_DEFAULT_SIZE,
  LOOKALIKE_MAX_SIZE,
  LOOKALIKE_MIN_SIZE,
  type AudienceSegmentationRequestOptions,
  type AudienceSegmentationRequester,
} from "../../lib/api/audience-segmentation";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AudienceSegmentationRequestOptions | undefined;
}

function recordingRequester(responses: ApiResult<unknown>[] = []): {
  calls: RequestCall[];
  request: AudienceSegmentationRequester;
} {
  const calls: RequestCall[] = [];
  const request: AudienceSegmentationRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AudienceSegmentationRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  return { calls, request };
}

const LLM_OPTIONS = { timeoutMs: 60_000, maxAttempts: 1 } as const;

const METHOD_NAMES = [
  "getABResults",
  "getABWeightHistory",
  "listInboundTriggers",
  "createInboundTrigger",
  "updateInboundTrigger",
  "deleteInboundTrigger",
  "listMergeFieldSchema",
  "createMergeFieldSchema",
  "patchMergeFieldSchema",
  "deleteMergeFieldSchema",
  "getSubscriberMergeFields",
  "patchSubscriberMergeFields",
  "listSavedSegments",
  "createSavedSegment",
  "patchSavedSegment",
  "deleteSavedSegment",
  "createLookalikeAudience",
  "getLookalikeAudience",
  "listLookalikeAudienceMembers",
  "deleteLookalikeAudience",
  "listSegmentFolders",
  "createSegmentFolder",
  "patchSegmentFolder",
  "deleteSegmentFolder",
  "previewSavedSegment",
  "previewSavedSegmentDetail",
  "previewCompiledSegment",
  "getSegmentAIProcessingDisclosure",
  "compileSegmentFromText",
  "getSubscribersViewPrefs",
  "putSubscribersViewPrefs",
  "getSubscriberSendTimes",
  "setSubscriberRating",
  "listSubscriberHistory",
  "listSubscriberAttributeHistory",
] as const;

const COMPOSED_METHODS = {
  getABResults,
  getABWeightHistory,
  listInboundTriggers,
  createInboundTrigger,
  updateInboundTrigger,
  deleteInboundTrigger,
  listMergeFieldSchema,
  createMergeFieldSchema,
  patchMergeFieldSchema,
  deleteMergeFieldSchema,
  getSubscriberMergeFields,
  patchSubscriberMergeFields,
  listSavedSegments,
  createSavedSegment,
  patchSavedSegment,
  deleteSavedSegment,
  createLookalikeAudience,
  getLookalikeAudience,
  listLookalikeAudienceMembers,
  deleteLookalikeAudience,
  listSegmentFolders,
  createSegmentFolder,
  patchSegmentFolder,
  deleteSegmentFolder,
  previewSavedSegment,
  previewSavedSegmentDetail,
  previewCompiledSegment,
  getSegmentAIProcessingDisclosure,
  compileSegmentFromText,
  getSubscribersViewPrefs,
  putSubscribersViewPrefs,
  getSubscriberSendTimes,
  setSubscriberRating,
  listSubscriberHistory,
  listSubscriberAttributeHistory,
};

function createMethods(request: AudienceSegmentationRequester) {
  return createAudienceSegmentationMethods(request, {
    llmRequestOptions: LLM_OPTIONS,
  });
}

describe("audience segmentation API extraction contracts", () => {
  it("retains all 35 named methods and three runtime constant identities", () => {
    const { request } = recordingRequester();
    const created = createMethods(request);

    expect(Object.keys(created)).toEqual(METHOD_NAMES);
    expect(Object.keys(COMPOSED_METHODS)).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof created[name]).toBe("function");
      expect(typeof COMPOSED_METHODS[name]).toBe("function");
      expect(created[name].name).toBe(name);
      expect(COMPOSED_METHODS[name].name).toBe(name);
    }

    expect(FACADE_LOOKALIKE_MIN_SIZE).toBe(LOOKALIKE_MIN_SIZE);
    expect(FACADE_LOOKALIKE_MAX_SIZE).toBe(LOOKALIKE_MAX_SIZE);
    expect(FACADE_LOOKALIKE_DEFAULT_SIZE).toBe(LOOKALIKE_DEFAULT_SIZE);
    expect([
      LOOKALIKE_MIN_SIZE,
      LOOKALIKE_MAX_SIZE,
      LOOKALIKE_DEFAULT_SIZE,
    ]).toEqual([100, 10_000, 1_000]);
  });

  it("preserves A/B readers and inbound-trigger routes, bodies, and encoding", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);
    const input = {
      name: "High-value buyer",
      active: true,
      match_jsonpath: "$.event.type",
      match_operator: "equals" as const,
      match_value: "purchase",
      email_jsonpath: "$.customer.email",
      action_type: "start_automation" as const,
      action_target_id: "automation/one",
    };

    await methods.getABResults("campaign/one", "reply_rate");
    await methods.getABWeightHistory("campaign/one");
    await methods.listInboundTriggers("webhook/one");
    await methods.createInboundTrigger("webhook/one", input);
    await methods.updateInboundTrigger("webhook/one", "trigger/one", {
      active: false,
      match_operator: "contains",
      match_value: "paid",
    });
    await methods.deleteInboundTrigger("webhook/one", "trigger/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/campaigns/campaign%2Fone/ab-results?metric=reply_rate",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/campaigns/campaign%2Fone/ab-weight-history",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/webhook%2Fone/triggers",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/webhook%2Fone/triggers",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/webhook%2Fone/triggers/trigger%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            active: false,
            match_operator: "contains",
            match_value: "paid",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-webhooks/webhook%2Fone/triggers/trigger%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves every merge-field schema and subscriber-value contract", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);
    const input = {
      key: "FNAME",
      label: "First name",
      type: "text" as const,
      default_value: "Friend",
      required: true,
      position: 1,
    };

    await methods.listMergeFieldSchema();
    await methods.createMergeFieldSchema(input);
    await methods.patchMergeFieldSchema("F/NAME", {
      label: "Given name",
      required: false,
      position: 2,
    });
    await methods.deleteMergeFieldSchema("F/NAME");
    await methods.getSubscriberMergeFields("subscriber/one");
    await methods.patchSubscriberMergeFields("subscriber/one", {
      FNAME: "Ada",
      REGION: "IN",
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/merge-fields/schema",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/merge-fields/schema",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/merge-fields/schema/F%2FNAME",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            label: "Given name",
            required: false,
            position: 2,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/merge-fields/schema/F%2FNAME",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/merge-fields",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/merge-fields",
        init: {
          method: "PATCH",
          body: JSON.stringify({ FNAME: "Ada", REGION: "IN" }),
        },
        opts: undefined,
      },
    ]);
  });

  it("rejects malformed merge-field success envelopes at the API boundary", async () => {
    const { request } = recordingRequester([
      {
        data: {
          items: [
            {
              tenant_id: "tenant-1",
              key: "FNAME",
              label: "First name",
              type: "text",
              default_value: "",
              required: false,
              position: 0,
              value_count: 0,
              created_at: "not-a-date",
              updated_at: "2026-07-18T10:00:00Z",
            },
          ],
        },
      },
      { data: { ok: false } },
      {
        data: {
          subscriber_id: "subscriber-one",
          values: { FNAME: { nested: true } },
        },
      },
    ]);
    const methods = createMethods(request);

    const listResult = await methods.listMergeFieldSchema();
    const deleteResult = await methods.deleteMergeFieldSchema("FNAME");
    const valuesResult =
      await methods.getSubscriberMergeFields("subscriber-one");

    for (const result of [listResult, deleteResult, valuesResult]) {
      const invalidResult = result as ApiErr;
      if (!invalidResult.error) {
        throw new Error("Malformed merge-field envelope was accepted");
      }
      expect(invalidResult.error.code).toBe("invalid_merge_field_contract");
      expect(invalidResult.error.kind).toBe("parse");
      expect(invalidResult.retryability).toBe("manual");
    }
  });

  it("rejects subscriber merge-field responses for a different profile", async () => {
    const { request } = recordingRequester([
      {
        data: {
          subscriber_id: "subscriber-other",
          values: { FNAME: "Mallory" },
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          values: { FNAME: "Mallory" },
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          aggregate_best_send_hour: null,
          channels: [],
        },
      },
      {
        data: { subscriber_id: "subscriber-other", rating: 4 },
      },
      {
        data: {
          subscriber_id: "subscriber-one",
          items: [
            {
              id: "history-1",
              tenant_id: "tenant-1",
              subscriber_id: "subscriber-other",
              kind: "updated",
              at: "2026-07-18T10:00:00Z",
              payload: {},
            },
          ],
        },
      },
      {
        data: {
          items: [
            {
              id: "attribute-1",
              subscriber_id: "subscriber-other",
              field_name: "status",
              old_value: "enabled",
              new_value: "blocklisted",
              source: "manual",
              changed_at: "2026-07-18T10:00:00Z",
            },
          ],
        },
      },
    ]);
    const methods = createMethods(request);

    const results = [
      await methods.getSubscriberMergeFields("subscriber-one"),
      await methods.patchSubscriberMergeFields("subscriber-one", {
        FNAME: "Ada",
      }),
      await methods.getSubscriberSendTimes("subscriber-one"),
      await methods.setSubscriberRating("subscriber-one", 4),
      await methods.listSubscriberHistory("subscriber-one"),
      await methods.listSubscriberAttributeHistory("subscriber-one"),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });

  it("preserves saved-segment and lookalike routes, payloads, and paging", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);
    const segmentInput = {
      name: "Recent buyers",
      description: "Purchased this month",
      predicate_json: {
        filters: { status: "enabled", tags: ["buyer"] },
      },
      visibility_scope: "workspace" as const,
      folder_id: "folder/one",
    };

    await methods.listSavedSegments();
    await methods.createSavedSegment(segmentInput);
    await methods.patchSavedSegment("segment/one", {
      name: "Recent VIP buyers",
      touch: true,
      is_pinned: true,
      pin_order: 2,
      visibility_scope: "personal",
      folder_id: "",
    });
    await methods.deleteSavedSegment("segment/one");
    await methods.createLookalikeAudience({
      name: "Buyers lookalike",
      seed_segment_id: "segment/one",
      size: 1_500,
      confidence_threshold: 0.75,
      data_use_acknowledged: true,
    });
    await methods.getLookalikeAudience("model/one");
    await methods.listLookalikeAudienceMembers("model/one", {
      page: 2,
      perPage: 50,
    });
    await methods.deleteLookalikeAudience("model/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/segments/saved",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/segments/saved",
        init: { method: "POST", body: JSON.stringify(segmentInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/segments/saved/segment%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            name: "Recent VIP buyers",
            touch: true,
            is_pinned: true,
            pin_order: 2,
            visibility_scope: "personal",
            folder_id: "",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/segments/saved/segment%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audiences/lookalike",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Buyers lookalike",
            seed_segment_id: "segment/one",
            size: 1_500,
            confidence_threshold: 0.75,
            data_use_acknowledged: true,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audiences/lookalike/model%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audiences/lookalike/model%2Fone/members?page=2&per_page=50",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audiences/lookalike/model%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("rejects lookalike identity mismatches and requires explicit PII opt-in", async () => {
    const base = {
      id: "model-other",
      name: "Audience",
      seed_segment_id: "segment-other",
      size_requested: 100,
      member_count: 1,
      seed_count: 50,
      confidence_threshold: 0.8,
      model_version: "first-party-v1",
      status: "ready" as const,
      payload: {},
    };
    const { calls, request } = recordingRequester([
      { data: base },
      { data: { ...base, seed_segment_id: "segment/one" } },
      {
        data: {
          items: [
            {
              subscriber_id: "subscriber-1",
              email: "private@example.com",
              similarity_score: 0.9,
              rank: 1,
              features: { email_domain: "example.com" },
            },
          ],
          total: 1,
          page: 1,
          per_page: 10,
          pii_included: false,
        },
      },
      {
        data: {
          items: [],
          total: 0,
          page: 1,
          per_page: 10,
          pii_included: true,
        },
      },
    ]);
    const methods = createMethods(request);

    const created = await methods.createLookalikeAudience({
      seed_segment_id: "segment/one",
      data_use_acknowledged: true,
    });
    const fetched = await methods.getLookalikeAudience("model/one");
    const leaked = await methods.listLookalikeAudienceMembers("model/one", {
      perPage: 10,
    });
    const optedIn = await methods.listLookalikeAudienceMembers("model/one", {
      perPage: 10,
      includePII: true,
    });

    expect(created.error?.code).toBe("subscriber_response_identity_mismatch");
    expect(fetched.error?.code).toBe("subscriber_response_identity_mismatch");
    expect(leaked.error?.code).toBe("invalid_subscriber_response_contract");
    expect(optedIn.error).toBeUndefined();
    expect(calls.at(-1)?.path).toBe(
      "/api/v1/audiences/lookalike/model%2Fone/members?per_page=10&include_pii=true",
    );
  });

  it("preserves folder and saved-preview methods including explicit GET", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);

    await methods.listSegmentFolders();
    await methods.createSegmentFolder("VIP & buyers");
    await methods.patchSegmentFolder("folder/one", "Updated");
    await methods.deleteSegmentFolder("folder/one");
    await methods.previewSavedSegment("segment/one");
    await methods.previewSavedSegmentDetail("segment/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/segment-folders",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/segment-folders",
        init: {
          method: "POST",
          body: JSON.stringify({ name: "VIP & buyers" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/segment-folders/folder%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({ name: "Updated" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/segment-folders/folder%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/segments/saved/segment%2Fone/preview",
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: "/api/v1/segments/saved/segment%2Fone/preview",
        init: { method: "GET", cache: "no-store" },
        opts: undefined,
      },
    ]);
  });

  it("preserves rules/AI compiler policies and subscriber view preferences", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);
    const prefs = {
      columns: ["email", "status"],
      widths: { email: 320 },
      sort: "email",
      order: "asc" as const,
    };

    await methods.compileSegmentFromText("buyers in the last 7 days");
    await methods.compileSegmentFromText("high intent readers", {
      engine: "ai",
      aiProcessingAcknowledged: true,
    });
    await methods.getSubscribersViewPrefs();
    await methods.putSubscribersViewPrefs(prefs);

    expect(calls).toEqual([
      {
        path: "/api/v1/segments/compile-from-text",
        init: {
          method: "POST",
          body: JSON.stringify({ text: "buyers in the last 7 days" }),
        },
        opts: {},
      },
      {
        path: "/api/v1/segments/compile-from-text?engine=ai",
        init: {
          method: "POST",
          body: JSON.stringify({
            text: "high intent readers",
            ai_processing_acknowledged: true,
          }),
        },
        opts: LLM_OPTIONS,
      },
      {
        path: "/api/v1/me/prefs/subscribers_view",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/me/prefs/subscribers_view",
        init: { method: "PUT", body: JSON.stringify(prefs) },
        opts: undefined,
      },
    ]);
  });

  it("loads and strictly validates the AI-processing disclosure before use", async () => {
    const disclosure = {
      available: true,
      ai_processing: {
        provider: "anthropic",
        model: "claude-test",
        data_categories: [
          "operator_supplied_segment_description",
          "segment_predicate_catalog",
        ],
        retention: "not_declared",
        residency: "not_declared",
      },
    };
    const controller = new AbortController();
    const { calls, request } = recordingRequester([
      { data: disclosure },
      { data: { available: true, ai_processing: {} } },
    ]);
    const methods = createMethods(request);

    await expect(
      methods.getSegmentAIProcessingDisclosure({
        signal: controller.signal,
      }),
    ).resolves.toEqual({ data: disclosure });
    await expect(
      methods.getSegmentAIProcessingDisclosure(),
    ).resolves.toMatchObject({ error: { kind: "parse" } });
    expect(calls[0]).toEqual({
      path: "/api/v1/segments/compile-from-text",
      init: { method: "GET", cache: "no-store" },
      opts: { signal: controller.signal },
    });
  });

  it("fails closed on an engine switch or missing AI-processing disclosure", async () => {
    const ast = {
      op: "condition" as const,
      field: "status",
      comparator: "equals" as const,
      value: "enabled",
    };
    const { request } = recordingRequester([
      { data: { ast, engine_used: "ai" } },
      { data: { ast, engine_used: "ai" } },
      {
        data: {
          ast,
          engine_used: "ai",
          ai_processing: {
            data_categories: [
              "operator_supplied_segment_description",
              "segment_predicate_catalog",
            ],
            retention: "not_declared",
            residency: "not_declared",
          },
        },
      },
    ]);
    const methods = createMethods(request);

    const switched = await methods.compileSegmentFromText("active readers", {
      engine: "rules",
    });
    const undisclosed = await methods.compileSegmentFromText("active readers", {
      engine: "ai",
      aiProcessingAcknowledged: true,
    });
    const disclosed = await methods.compileSegmentFromText("active readers", {
      engine: "ai",
      aiProcessingAcknowledged: true,
    });

    expect(switched).toMatchObject({ error: { kind: "parse" } });
    expect(undisclosed).toMatchObject({ error: { kind: "parse" } });
    expect(disclosed).toMatchObject({ data: { engine_used: "ai" } });
  });

  it("does not transmit an AI prompt without explicit processing acknowledgement", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);

    const result = await methods.compileSegmentFromText(
      "private.person@example.test",
      { engine: "ai" },
    );

    expect(result).toMatchObject({ error: { kind: "parse" } });
    expect(calls).toHaveLength(0);
  });

  it("rejects divergent AST aliases and malformed compiler presentation fields", async () => {
    const ast = {
      op: "condition" as const,
      field: "status",
      comparator: "equals" as const,
      value: "enabled",
    };
    const { request } = recordingRequester([
      {
        data: {
          ast,
          query_ast: { ...ast, value: "disabled" },
          engine_used: "rules",
        },
      },
      {
        data: {
          ast,
          engine_used: "rules",
          suggested_name: { unsafe: true },
        },
      },
      {
        data: {
          ast,
          engine_used: "rules",
          nutrition_facts: {
            predicates: "status",
            time_windows: [],
            source: "rules",
          },
        },
      },
    ]);
    const methods = createMethods(request);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        methods.compileSegmentFromText("active readers"),
      ).resolves.toMatchObject({ error: { kind: "parse" } });
    }
  });

  it("forwards cancellation and validates aggregate-only compiled previews", async () => {
    const controller = new AbortController();
    const ast = {
      op: "condition" as const,
      field: "status",
      comparator: "equals" as const,
      value: "enabled",
    };
    const validPreview = {
      count: 24,
      workspace_total: 100,
      workspace_percentage: 24,
      generated_at: "2026-07-18T12:00:00Z",
      archive_scope: "active_only" as const,
      applied_exclusions: ["archived_profiles"],
    };
    const { calls, request } = recordingRequester([
      { data: {} },
      { data: validPreview },
      { data: { count: 24 } },
    ]);
    const methods = createMethods(request);

    await methods.compileSegmentFromText("active readers", {
      engine: "rules",
      signal: controller.signal,
    });
    const valid = await methods.previewCompiledSegment(ast, {
      signal: controller.signal,
      targetChannel: "email",
    });
    const invalid = await methods.previewCompiledSegment(ast);

    expect(valid).toEqual({ data: validPreview });
    expect(invalid).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      },
    });
    expect(calls[0]?.opts).toEqual({ signal: controller.signal });
    expect(calls[1]).toEqual({
      path: "/api/v1/segments/preview",
      init: {
        method: "POST",
        body: JSON.stringify({
          queryAst: ast,
          include_archived: false,
          target_channel: "email",
        }),
        cache: "no-store",
      },
      opts: { signal: controller.signal },
    });
    expect(calls[2]?.init).not.toHaveProperty("sql");
  });

  it("preserves send-time, rating, history, and attribute-history contracts", async () => {
    const { calls, request } = recordingRequester();
    const methods = createMethods(request);

    await methods.getSubscriberSendTimes("subscriber/one");
    await methods.setSubscriberRating("subscriber/one", 5);
    await methods.listSubscriberHistory("subscriber/one", {
      limit: 25,
      before: "2026-07-15T10:00:00Z",
    });
    await methods.listSubscriberAttributeHistory("subscriber/one", {
      limit: 10,
      before: "2026-07-14T09:30:00Z",
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber%2Fone/send-times",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/rating",
        init: {
          method: "PATCH",
          body: JSON.stringify({ rating: 5 }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/history?limit=25&before=2026-07-15T10%3A00%3A00Z",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/attribute-history?limit=10&before=2026-07-14T09%3A30%3A00Z",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("keeps unavailable collection capabilities distinct from verified empty data", async () => {
    const skippedStatuses = [404, 501];
    for (const status of skippedStatuses) {
      const unavailable: ApiResult<unknown> = {
        error: {
          message: "not available",
          kind: "http",
          status,
        },
      };
      const folders = recordingRequester([unavailable]);
      await expect(
        createMethods(folders.request).listSegmentFolders(),
      ).resolves.toEqual(unavailable);

      // Missing saved-segment routes are an unavailable capability, never an
      // honestly empty reusable-view library.
      const savedSegments = recordingRequester([unavailable]);
      await expect(
        createMethods(savedSegments.request).listSavedSegments(),
      ).resolves.toEqual(unavailable);
    }

    // A missing schema route is an unavailable capability, never an empty
    // schema. Presenting it as empty would allow operators to create a field
    // against an unknown server state.
    for (const status of skippedStatuses) {
      const unavailable: ApiResult<unknown> = {
        error: { message: "not available", kind: "http", status },
      };
      const { request } = recordingRequester([unavailable]);
      await expect(
        createMethods(request).listMergeFieldSchema(),
      ).resolves.toEqual(unavailable);
    }

    const serverError: ApiResult<unknown> = {
      error: { message: "server failed", kind: "http", status: 500 },
    };
    for (const method of [
      "listMergeFieldSchema",
      "listSavedSegments",
      "listSegmentFolders",
    ] as const) {
      const { request } = recordingRequester([serverError]);
      await expect(createMethods(request)[method]()).resolves.toEqual(
        serverError,
      );
    }

    const missingPrefs = recordingRequester([
      { error: { message: "missing", kind: "http", status: 404 } },
    ]);
    await expect(
      createMethods(missingPrefs.request).getSubscribersViewPrefs(),
    ).resolves.toEqual({ data: {} });

    const unauthorized: ApiResult<unknown> = {
      error: { message: "expired", kind: "http", status: 401 },
    };
    const unauthorizedPrefs = recordingRequester([unauthorized]);
    await expect(
      createMethods(unauthorizedPrefs.request).getSubscribersViewPrefs(),
    ).resolves.toEqual(unauthorized);

    const missingTimes = recordingRequester([
      { error: { message: "missing", kind: "http", status: 404 } },
    ]);
    await expect(
      createMethods(missingTimes.request).getSubscriberSendTimes(
        "subscriber/one",
      ),
    ).resolves.toEqual({
      data: {
        subscriber_id: "subscriber/one",
        aggregate_best_send_hour: null,
        channels: [],
      },
    });

    const failedTimes = recordingRequester([serverError]);
    await expect(
      createMethods(failedTimes.request).getSubscriberSendTimes(
        "subscriber/one",
      ),
    ).resolves.toEqual(serverError);
  });
});
