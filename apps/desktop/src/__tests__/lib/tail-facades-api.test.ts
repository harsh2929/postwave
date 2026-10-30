import { describe, expect, it } from "vitest";

import {
  agentRoutinesApi,
  analyticsNlqApi,
  reportingApi,
  reviewsApi,
  segmentInsightsApi,
  serviceSuiteApi,
  smsBroadcastsApi,
  voiceRoadmapApi,
} from "../../lib/api-client";
import { createAgentRoutinesApi } from "../../lib/api/agent-routines";
import { createAnalyticsNlqApi } from "../../lib/api/analytics-nlq";
import { createReportingApi } from "../../lib/api/reporting";
import { createReviewsApi } from "../../lib/api/reviews";
import { createSegmentInsightsApi } from "../../lib/api/segment-insights";
import { createServiceSuiteApi } from "../../lib/api/service-suite";
import { createSmsBroadcastsApi } from "../../lib/api/sms-broadcasts";
import { createVoiceRoadmapApi } from "../../lib/api/voice-roadmap";
import type { ApiResult } from "../../lib/api/result";

type TailRequester = Parameters<typeof createReportingApi>[0];
type TailRequestOptions = Parameters<TailRequester>[2];
type SegmentDependencies = Parameters<typeof createSegmentInsightsApi>[1];

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: TailRequestOptions;
}

function recordingRequester(): {
  calls: RequestCall[];
  request: TailRequester;
} {
  const calls: RequestCall[] = [];
  const request: TailRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: TailRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return { data: {} as T };
  };
  return { calls, request };
}

const LLM_OPTIONS = { timeoutMs: 60_000, maxAttempts: 1 };

function positionPathSegment(position: number): string | null {
  return Number.isSafeInteger(position) && position >= 1
    ? String(position)
    : null;
}

function segmentDependencies(): SegmentDependencies {
  const controller = new AbortController();
  return {
    apiUrl: (path) => `https://api.example.test${path}`,
    createDownloadController: () => ({
      signal: controller.signal,
      dispose: () => undefined,
    }),
    errorFromResponse: async () => ({ message: "download failed" }),
    getApiKey: () => null,
    nativeFetch: async () => new Response(new Blob(["csv"])),
    normalizeApiKey: () => null,
    transportError: () => ({ message: "transport failed" }),
  };
}

const REPORTING_OPERATIONS = [
  "blockedProducts",
  "metricRegistry",
  "preview",
  "listDefinitions",
  "getDefinition",
  "upsertDefinition",
  "runDefinition",
  "listRuns",
  "getRun",
] as const;

const REVIEWS_OPERATIONS = [
  "catalog",
  "list",
  "get",
  "update",
  "approve",
  "reject",
  "reply",
  "productSummary",
  "listWidgets",
  "createWidget",
  "widgetEmbed",
] as const;

const SERVICE_SUITE_OPERATIONS = [
  "catalog",
  "config",
  "updateConfig",
  "listConversations",
  "getConversation",
  "listMessages",
  "listTickets",
  "postInternalNote",
  "assign",
  "setStatus",
  "listMacros",
] as const;

const AGENT_ROUTINE_OPERATIONS = [
  "list",
  "create",
  "get",
  "update",
  "remove",
  "run",
  "listRuns",
  "runByApproval",
] as const;

const ANALYTICS_NLQ_OPERATIONS = ["query", "anomalyBrief"] as const;
const VOICE_ROADMAP_OPERATIONS = [
  "getStepVariant",
  "listStuckParticipants",
  "generateTemplate",
] as const;
const SMS_BROADCAST_OPERATIONS = [
  "list",
  "create",
  "get",
  "update",
  "remove",
  "send",
  "cancel",
  "progress",
] as const;
const SEGMENT_INSIGHT_OPERATIONS = [
  "overlap",
  "growth",
  "growthReport",
  "growthReportCSV",
] as const;

const inventoryCases: Array<{
  name: string;
  create: (request: TailRequester) => object;
  facade: object;
  operations: readonly string[];
}> = [
  {
    name: "reporting",
    create: createReportingApi,
    facade: reportingApi,
    operations: REPORTING_OPERATIONS,
  },
  {
    name: "reviews",
    create: createReviewsApi,
    facade: reviewsApi,
    operations: REVIEWS_OPERATIONS,
  },
  {
    name: "service suite",
    create: createServiceSuiteApi,
    facade: serviceSuiteApi,
    operations: SERVICE_SUITE_OPERATIONS,
  },
  {
    name: "agent routines",
    create: createAgentRoutinesApi,
    facade: agentRoutinesApi,
    operations: AGENT_ROUTINE_OPERATIONS,
  },
  {
    name: "analytics NLQ",
    create: (request) => createAnalyticsNlqApi(request, LLM_OPTIONS),
    facade: analyticsNlqApi,
    operations: ANALYTICS_NLQ_OPERATIONS,
  },
  {
    name: "voice roadmap",
    create: (request) =>
      createVoiceRoadmapApi(request, {
        llmRequestOptions: LLM_OPTIONS,
        sequencePositionPathSegment: positionPathSegment,
      }),
    facade: voiceRoadmapApi,
    operations: VOICE_ROADMAP_OPERATIONS,
  },
  {
    name: "SMS broadcasts",
    create: createSmsBroadcastsApi,
    facade: smsBroadcastsApi,
    operations: SMS_BROADCAST_OPERATIONS,
  },
  {
    name: "segment insights",
    create: (request) =>
      createSegmentInsightsApi(request, segmentDependencies()),
    facade: segmentInsightsApi,
    operations: SEGMENT_INSIGHT_OPERATIONS,
  },
];

describe("tail facade extraction contracts", () => {
  for (const { name, create, facade, operations } of inventoryCases) {
    it(`retains the complete ${name} factory and composed inventory`, () => {
      const { request } = recordingRequester();

      expect(Object.keys(create(request))).toEqual(operations);
      expect(Object.keys(facade)).toEqual(operations);
    });
  }

  it("preserves every reporting transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createReportingApi(request);
    const reportRequest = {
      name: "Revenue by campaign",
      metrics: [{ key: "revenue", alias: "gross" }],
      dimensions: ["campaign"],
    };

    await api.blockedProducts();
    await api.metricRegistry();
    await api.preview(reportRequest);
    await api.listDefinitions("active/ready");
    await api.getDefinition("definition/one");
    await api.upsertDefinition(reportRequest);
    await api.runDefinition("definition/one");
    await api.listRuns();
    await api.getRun("run/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/reporting/blocked-products",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/metric-registry",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/preview",
        init: { method: "POST", body: JSON.stringify(reportRequest) },
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/definitions?status=active%2Fready",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/definitions/definition%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/definitions",
        init: { method: "POST", body: JSON.stringify(reportRequest) },
        opts: undefined,
      },
      {
        path: "/api/v1/reporting/definitions/definition%2Fone/runs",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      { path: "/api/v1/reporting/runs", init: undefined, opts: undefined },
      {
        path: "/api/v1/reporting/runs/run%2Fone",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves every reviews transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createReviewsApi(request);
    const patch = { status: "approved", featured: true };
    const widget = {
      name: "Product reviews",
      widget_type: "carousel",
      language: "en-US",
    };

    await api.catalog();
    await api.list({ status: "pending review", productId: "product/one" });
    await api.get("review/one");
    await api.update("review/one", patch);
    await api.approve("review/one");
    await api.reject("review/two");
    await api.reply("review/one", "Thanks for your feedback");
    await api.productSummary("product/one");
    await api.listWidgets();
    await api.createWidget(widget);
    await api.widgetEmbed("widget/one", "html/js");

    expect(calls).toEqual([
      { path: "/api/v1/reviews/catalog", init: undefined, opts: undefined },
      {
        path: "/api/v1/reviews?status=pending+review&product_id=product%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/review%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/review%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/review%2Fone/approve",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/review%2Ftwo/reject",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/review%2Fone/reply",
        init: {
          method: "POST",
          body: JSON.stringify({ body: "Thanks for your feedback" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/products/product%2Fone/summary",
        init: undefined,
        opts: undefined,
      },
      { path: "/api/v1/reviews/widgets", init: undefined, opts: undefined },
      {
        path: "/api/v1/reviews/widgets",
        init: { method: "POST", body: JSON.stringify(widget) },
        opts: undefined,
      },
      {
        path: "/api/v1/reviews/widgets/widget%2Fone/embed/html%2Fjs",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("threads cancellation through every Reviews read without changing URLs", async () => {
    const { calls, request } = recordingRequester();
    const api = createReviewsApi(request);
    const controller = new AbortController();
    const signal = controller.signal;

    await api.catalog({ signal });
    await api.list({ status: "pending", productId: "product/one", signal });
    await api.get("review/one", { signal });
    await api.productSummary("product/one", { signal });
    await api.listWidgets({ signal });
    await api.widgetEmbed("widget/one", "iframe", { signal });

    expect(calls).toEqual([
      {
        path: "/api/v1/reviews/catalog",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/reviews?status=pending&product_id=product%2Fone",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/reviews/review%2Fone",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/reviews/products/product%2Fone/summary",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/reviews/widgets",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/reviews/widgets/widget%2Fone/embed/iframe",
        init: undefined,
        opts: { signal },
      },
    ]);
  });

  it("preserves every service-suite transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createServiceSuiteApi(request);
    const configReplacement = {
      status: "paused",
      order_history_enabled: true,
      favorites_enabled: false,
      coupons_enabled: false,
      recommendations_enabled: false,
      customer_agent_enabled: false,
      storefronts: [],
      content_blocks: [],
      personalization_rules: {},
      support_settings: {},
      styling: {},
      metadata: {},
    };
    const replyInput = {
      body_text: "How can I help?",
    };
    const resourceVersion = "2026-08-24T00:00:00Z";

    await api.catalog();
    await api.config();
    await api.updateConfig(configReplacement, resourceVersion);
    await api.listConversations({ status: "needs review" });
    await api.getConversation("conversation/one");
    await api.listMessages("conversation/one");
    await api.listTickets({
      status: "open",
      conversationId: "conversation/one",
      cursor: "ticket&cursor=private@example.test",
      limit: 100,
    });
    await api.postInternalNote(
      "conversation/one",
      replyInput,
      "helpdesk-note-key",
    );
    await api.assign(
      "conversation/one",
      {
        action: "assign_self",
        reason: "specialist",
      },
      resourceVersion,
    );
    await api.setStatus(
      "conversation/one",
      "pending/customer",
      resourceVersion,
    );
    await api.listMacros({
      cursor: "macro&cursor=private@example.test",
      limit: 100,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/service-suite/catalog",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/config",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/config",
        init: {
          method: "PUT",
          headers: { "If-Match": `"${resourceVersion}"` },
          body: JSON.stringify(configReplacement),
        },
        opts: { maxAttempts: 1 },
      },
      {
        path: "/api/v1/service-suite/conversations?status=needs+review",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/conversations/conversation%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/conversations/conversation%2Fone/messages",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/tickets?status=open&conversation_id=conversation%2Fone&cursor=ticket%26cursor%3Dprivate%40example.test&limit=100",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/service-suite/conversations/conversation%2Fone/internal-notes",
        init: {
          method: "POST",
          headers: { "Idempotency-Key": "helpdesk-note-key" },
          body: JSON.stringify(replyInput),
        },
        opts: { maxAttempts: 1 },
      },
      {
        path: "/api/v1/service-suite/conversations/conversation%2Fone/assign",
        init: {
          method: "POST",
          headers: { "If-Match": `"${resourceVersion}"` },
          body: JSON.stringify({
            action: "assign_self",
            reason: "specialist",
          }),
        },
        opts: { maxAttempts: 1 },
      },
      {
        path: "/api/v1/service-suite/conversations/conversation%2Fone/status",
        init: {
          method: "POST",
          headers: { "If-Match": `"${resourceVersion}"` },
          body: JSON.stringify({ status: "pending/customer" }),
        },
        opts: { maxAttempts: 1 },
      },
      {
        path: "/api/v1/service-suite/macros?cursor=macro%26cursor%3Dprivate%40example.test&limit=100",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("allows the absent version only for first Hub replacement", async () => {
    const { calls, request } = recordingRequester();
    const api = createServiceSuiteApi(request);
    const replacement = {
      status: "draft",
      order_history_enabled: false,
      favorites_enabled: false,
      coupons_enabled: false,
      recommendations_enabled: false,
      customer_agent_enabled: false,
      storefronts: [],
      content_blocks: [],
      personalization_rules: {},
      support_settings: {},
      styling: {},
      metadata: {},
    };

    await api.updateConfig(replacement, "absent");
    expect(calls[0]).toMatchObject({
      path: "/api/v1/service-suite/config",
      init: { headers: { "If-Match": '"absent"' } },
    });
    expect(() =>
      api.assign(
        "11111111-1111-4111-8111-111111111111",
        { action: "unassign" },
        "absent",
      ),
    ).toThrow("A verified service-suite resource version is required.");
    expect(() =>
      api.setStatus("11111111-1111-4111-8111-111111111111", "open", "absent"),
    ).toThrow("A verified service-suite resource version is required.");
  });

  it("rejects poisoned service-suite cursors before transport", async () => {
    const { calls, request } = recordingRequester();
    const api = createServiceSuiteApi(request);
    const results = await Promise.all([
      api.listConversations({ cursor: "conversation\tprivate" }),
      api.listMessages("conversation/one", { cursor: "message\nprivate" }),
      api.listTickets({ cursor: "ticket\rprivate" }),
      api.listMacros({ cursor: "macro\u0085private" }),
      api.listConversations({ cursor: "conversation\u202eprivate" }),
    ]);

    expect(calls).toEqual([]);
    for (const result of results) {
      expect(result).toEqual({
        error: expect.objectContaining({
          code: "helpdesk_cursor_invalid",
          kind: "invalid_config",
        }),
        retryability: "not-retryable",
      });
    }
  });

  it("preserves every agent-routine transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createAgentRoutinesApi(request);
    const createInput = {
      name: "Weekly digest",
      prompt: "Draft the weekly digest",
      kind: "draft_campaign" as const,
      schedule: "weekly" as const,
    };
    const patch = { enabled: false, schedule: "manual" as const };

    await api.list();
    await api.create(createInput);
    await api.get("routine/one");
    await api.update("routine/one", patch);
    await api.remove("routine/one");
    await api.run("routine/one");
    await api.listRuns("routine/one");
    await api.runByApproval("approval/one");

    expect(calls).toEqual([
      { path: "/api/v1/agent-routines", init: undefined, opts: undefined },
      {
        path: "/api/v1/agent-routines",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/agent-routines/routine%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/agent-routines/routine%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/agent-routines/routine%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/agent-routines/routine%2Fone/run",
        init: { method: "POST", body: "{}" },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/agent-routines/routine%2Fone/runs",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/agent-routines/runs/by-approval/approval%2Fone",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves every analytics-NLQ transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createAnalyticsNlqApi(request, LLM_OPTIONS);
    const anomalyInput = {
      metric: "revenue" as const,
      window_days: 30,
      context: "Summer launch",
    };

    await api.query("Top campaigns by revenue?");
    await api.anomalyBrief(anomalyInput);

    expect(calls).toEqual([
      {
        path: "/api/v1/analytics/nlq",
        init: {
          method: "POST",
          body: JSON.stringify({ question: "Top campaigns by revenue?" }),
        },
        opts: LLM_OPTIONS,
      },
      {
        path: "/api/v1/analytics/anomaly-brief",
        init: { method: "POST", body: JSON.stringify(anomalyInput) },
        opts: LLM_OPTIONS,
      },
    ]);
  });

  it("threads caller cancellation through analytics NLQ without changing the LLM request policy", async () => {
    const { calls, request } = recordingRequester();
    const api = createAnalyticsNlqApi(request, LLM_OPTIONS);
    const controller = new AbortController();

    await api.query("Top campaigns by revenue?", {
      signal: controller.signal,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/analytics/nlq",
        init: {
          method: "POST",
          body: JSON.stringify({ question: "Top campaigns by revenue?" }),
        },
        opts: { ...LLM_OPTIONS, signal: controller.signal },
      },
    ]);
  });

  it("preserves every voice-roadmap transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createVoiceRoadmapApi(request, {
      llmRequestOptions: LLM_OPTIONS,
      sequencePositionPathSegment: positionPathSegment,
    });
    const templateInput = {
      brief: "Announce the summer release",
      kind: "announcement" as const,
      tone: "confident",
    };

    await api.getStepVariant("sequence/one", 2, "subscriber_vip_123");
    await api.listStuckParticipants("sequence/one", { days: 14 });
    await api.generateTemplate(templateInput);

    expect(calls).toEqual([
      {
        path: "/api/v1/voice/sequences/sequence%2Fone/steps/2/variant",
        init: {
          method: "POST",
          body: JSON.stringify({ subscriber_id: "subscriber_vip_123" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/voice/sequences/sequence%2Fone/stuck?days=14",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/voice/templates/generate",
        init: { method: "POST", body: JSON.stringify(templateInput) },
        opts: LLM_OPTIONS,
      },
    ]);
  });

  it("rejects invalid voice positions before transport", async () => {
    const { calls, request } = recordingRequester();
    const api = createVoiceRoadmapApi(request, {
      llmRequestOptions: LLM_OPTIONS,
      sequencePositionPathSegment: positionPathSegment,
    });

    const result = await api.getStepVariant("sequence/one", 0, "subscriber_1");

    expect(result).toEqual({
      error: {
        kind: "invalid_config",
        message: "Sequence step position must be a positive integer.",
      },
    });
    expect(calls).toEqual([]);
  });

  it("rejects email-shaped subscriber identifiers before transport", async () => {
    const { calls, request } = recordingRequester();
    const api = createVoiceRoadmapApi(request, {
      llmRequestOptions: LLM_OPTIONS,
      sequencePositionPathSegment: positionPathSegment,
    });

    const result = await api.getStepVariant(
      "sequence/one",
      1,
      "reader@example.test",
    );

    expect(result.error?.kind).toBe("invalid_config");
    expect(calls).toEqual([]);
  });

  it("preserves every SMS-broadcast transport contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createSmsBroadcastsApi(request);
    const createInput = {
      name: "Flash sale",
      body: "20% off today",
      list_ids: ["list/one"],
    };
    const patch = { scheduled_at: "2026-07-20T10:00:00Z" };

    await api.list();
    await api.create(createInput);
    await api.get("broadcast/one");
    await api.update("broadcast/one", patch);
    await api.remove("broadcast/one");
    await api.send("broadcast/one");
    await api.cancel("broadcast/one");
    await api.progress("broadcast/one");

    expect(calls).toEqual([
      { path: "/api/v1/sms/broadcasts", init: undefined, opts: undefined },
      {
        path: "/api/v1/sms/broadcasts",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone/send",
        init: { method: "POST", body: "{}" },
        opts: { requireOnline: true, timeoutMs: 30_000 },
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone/cancel",
        init: { method: "POST", body: "{}" },
        opts: { requireOnline: true },
      },
      {
        path: "/api/v1/sms/broadcasts/broadcast%2Fone/progress",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves every requester-backed segment-insights contract", async () => {
    const { calls, request } = recordingRequester();
    const api = createSegmentInsightsApi(request, segmentDependencies());

    await api.overlap("segment/a", "segment b");
    await api.growth("segment/one", { days: 30 });
    await api.growthReport("segment/one", { days: 14 });

    expect(calls).toEqual([
      {
        path: "/api/v1/segments/overlap?a=segment%2Fa&b=segment+b",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/segments/segment%2Fone/growth?days=30",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/segments/segment%2Fone/growth/report?days=14",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
