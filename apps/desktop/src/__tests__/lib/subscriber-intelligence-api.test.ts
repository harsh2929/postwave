import { describe, expect, it } from "vitest";

import {
  contactRatingsApi,
  customFieldsApi,
  eqScoreApi,
  leadScoringApi,
  lifecycleRollupApi,
  predictiveApi,
  subscriberNotesApi,
  triggerDelayApi,
  zeroCopyTriggersApi,
} from "../../lib/api-client";
import {
  createSubscriberIntelligenceApis,
  type SubscriberIntelligenceRequestOptions,
  type SubscriberIntelligenceRequester,
} from "../../lib/api/subscriber-intelligence";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: SubscriberIntelligenceRequestOptions | undefined;
}

function recordingRequester(responses: ApiResult<unknown>[] = []): {
  calls: RequestCall[];
  request: SubscriberIntelligenceRequester;
} {
  const calls: RequestCall[] = [];
  const request: SubscriberIntelligenceRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: SubscriberIntelligenceRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  return { calls, request };
}

const DOMAIN_OPERATIONS = {
  lifecycleRollupApi: ["distribution", "stages"],
  leadScoringApi: ["rules", "putRules"],
  contactRatingsApi: ["get", "recompute"],
  eqScoreApi: ["score"],
  subscriberNotesApi: [
    "list",
    "create",
    "update",
    "remove",
    "addAttachment",
    "removeAttachment",
  ],
  customFieldsApi: ["list", "create", "patch", "delete"],
  predictiveApi: [
    "catalog",
    "profiles",
    "profile",
    "rfmSegments",
    "clvDashboard",
    "recompute",
  ],
  zeroCopyTriggersApi: [
    "list",
    "create",
    "get",
    "update",
    "remove",
    "pollNow",
    "fires",
    "validate",
    "getAlerts",
    "putAlerts",
    "listDLQ",
    "retryDLQ",
  ],
  triggerDelayApi: ["getPreference", "putPreference"],
} as const;

const COMPOSED_FACADES = {
  lifecycleRollupApi,
  leadScoringApi,
  contactRatingsApi,
  eqScoreApi,
  subscriberNotesApi,
  customFieldsApi,
  predictiveApi,
  zeroCopyTriggersApi,
  triggerDelayApi,
};

describe("subscriber intelligence API extraction contracts", () => {
  it("retains all 9 facades and all 37 safe factory/composed operations", () => {
    const { request } = recordingRequester();
    const created = createSubscriberIntelligenceApis(request);

    expect(Object.keys(created)).toEqual(Object.keys(DOMAIN_OPERATIONS));
    expect(
      Object.values(DOMAIN_OPERATIONS).reduce(
        (total, operations) => total + operations.length,
        0,
      ),
    ).toBe(37);
    for (const name of Object.keys(
      DOMAIN_OPERATIONS,
    ) as (keyof typeof DOMAIN_OPERATIONS)[]) {
      expect(Object.keys(created[name])).toEqual(DOMAIN_OPERATIONS[name]);
      expect(Object.keys(COMPOSED_FACADES[name])).toEqual(
        DOMAIN_OPERATIONS[name],
      );
    }
  });

  it("preserves lifecycle, scoring, rating, and EQ transport contracts", async () => {
    const { calls, request } = recordingRequester();
    const {
      lifecycleRollupApi: lifecycle,
      leadScoringApi: scoring,
      contactRatingsApi: ratings,
      eqScoreApi: eq,
    } = createSubscriberIntelligenceApis(request);
    const rules = [
      { id: "rule_1", event_type: "clicked", weight: 12, note: "Buyer" },
    ];
    const expectedVersion = `sha256:${"a".repeat(64)}`;
    const scoreInput = {
      subject: "Welcome",
      html: "<h1>Hello</h1>",
      text: "Hello",
      from: "hello@example.test",
      campaign_id: "campaign/one",
      draft_label: "Version A",
    };

    await lifecycle.distribution();
    await lifecycle.stages();
    await scoring.rules();
    await scoring.putRules(rules, expectedVersion);
    await ratings.get("subscriber/one");
    await ratings.recompute(0);
    await eq.score(scoreInput);

    expect(calls).toEqual([
      {
        path: "/api/v1/lifecycle/distribution",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/lifecycle/stages",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/scoring/rules",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/scoring/rules",
        init: {
          method: "PUT",
          body: JSON.stringify({
            rules,
            expected_version: expectedVersion,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/contact-ratings/subscriber%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/contact-ratings/recompute?window=0",
        init: { method: "POST", body: "{}" },
        opts: { timeoutMs: 30_000, maxAttempts: 1 },
      },
      {
        path: "/api/v1/deliverability/eq-score",
        init: { method: "POST", body: JSON.stringify(scoreInput) },
        opts: undefined,
      },
    ]);
  });

  it("preserves every notes route and segmented attachment-key encoding", async () => {
    const { calls, request } = recordingRequester();
    const { subscriberNotesApi: notes } =
      createSubscriberIntelligenceApis(request);

    await notes.list("subscriber/one");
    await notes.create("subscriber/one", {
      body: "Plain note",
      markdown_body: "Hello @[Sam](user:user-1)",
      pinned: true,
    });
    await notes.update("subscriber/one", "note/one", {
      pinned: false,
      markdown_body: "Updated",
    });
    await notes.remove("subscriber/one", "note/one");
    await notes.addAttachment("subscriber/one", "note/one", {
      file_key: "tenant files/report Q3.pdf",
      filename: "report Q3.pdf",
      content_type: "application/pdf",
      size_bytes: 4_096,
    });
    await notes.removeAttachment(
      "subscriber/one",
      "note/one",
      "tenant files/report Q3.pdf",
    );

    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes",
        init: {
          method: "POST",
          body: JSON.stringify({
            body: "Plain note",
            markdown_body: "Hello @[Sam](user:user-1)",
            pinned: true,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes/note%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            pinned: false,
            markdown_body: "Updated",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes/note%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes/note%2Fone/attachments",
        init: {
          method: "POST",
          body: JSON.stringify({
            file_key: "tenant files/report Q3.pdf",
            filename: "report Q3.pdf",
            content_type: "application/pdf",
            size_bytes: 4_096,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/subscriber%2Fone/notes/note%2Fone/attachments/tenant%20files/report%20Q3.pdf",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("rejects mismatched note, subscriber, and attachment identities", async () => {
    const { request } = recordingRequester([
      {
        data: {
          notes: [
            {
              id: "note-1",
              subscriber_id: "subscriber-other",
              attachments: [],
            },
          ],
          count: 1,
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          note_id: "note-1",
          pinned: true,
        },
      },
      {
        data: {
          id: "attachment-1",
          subscriber_id: "subscriber-1",
          note_id: "note-other",
          file_key: "notes/private.pdf",
        },
      },
      {
        data: {
          id: "note-other",
          pinned: true,
        },
      },
      {
        data: {
          id: "attachment-2",
          subscriber_id: "subscriber-1",
          note_id: "note-1",
          file_key: "Notes/private.pdf",
        },
      },
    ]);
    const { subscriberNotesApi: notes } =
      createSubscriberIntelligenceApis(request);

    const results = [
      await notes.list("subscriber-1"),
      await notes.update("subscriber-1", "note-1", { pinned: true }),
      await notes.addAttachment("subscriber-1", "note-1", {
        file_key: "notes/private.pdf",
        filename: "private.pdf",
      }),
      await notes.update("subscriber-1", "note-1", { pinned: true }),
      await notes.addAttachment("subscriber-1", "note-1", {
        file_key: "notes/private.pdf",
        filename: "private.pdf",
      }),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });

  it("rejects duplicate attachment identities in a note response", async () => {
    const attachment = {
      id: "attachment-1",
      note_id: "note-1",
      file_key: "notes/private.pdf",
    };
    const { request } = recordingRequester([
      {
        data: {
          notes: [
            {
              id: "note-1",
              subscriber_id: "subscriber-1",
              attachments: [attachment, { ...attachment }],
            },
          ],
          count: 1,
        },
      },
    ]);
    const { subscriberNotesApi: notes } =
      createSubscriberIntelligenceApis(request);

    const result = (await notes.list("subscriber-1")) as ApiErr;
    expect(result.error.code).toBe("invalid_subscriber_response_contract");
    expect(result.error.kind).toBe("parse");
  });

  it("rejects mismatched contact-rating and predictive profile identities", async () => {
    const { request } = recordingRequester([
      { data: { subscriber_id: "subscriber-other" } },
      {
        data: {
          prediction: {
            email: "other@example.com",
            subscriber_id: "subscriber-1",
          },
          rfm: {
            email: "reader@example.com",
            subscriber_id: "subscriber-1",
          },
        },
      },
    ]);
    const { contactRatingsApi: ratings, predictiveApi: predictive } =
      createSubscriberIntelligenceApis(request);

    const results = [
      await ratings.get("subscriber-1"),
      await predictive.profile("reader@example.com"),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
    }
  });

  it("preserves rich custom-field registry inputs and encoded ids", async () => {
    const { calls, request } = recordingRequester();
    const { customFieldsApi: fields } =
      createSubscriberIntelligenceApis(request);
    const createInput = {
      key: "favorite_product",
      label: "Favorite product",
      type: "object" as const,
      config: {
        schema: { sku: "string", score: "number" },
        pattern: "^[A-Z]",
        pii_flag: true,
        encryption_flag: true,
        data_classification: "pii" as const,
      },
      validation_rule: "required",
      searchable: true,
    };

    await fields.list();
    await fields.create(createInput);
    await fields.patch("field/one", {
      label: "Preferred product",
      config: { data_classification: "business" },
      validation_rule: "optional",
    });
    await fields.delete("field/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/custom-fields",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/custom-fields",
        init: { method: "POST", body: JSON.stringify(createInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/custom-fields/field%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            label: "Preferred product",
            config: { data_classification: "business" },
            validation_rule: "optional",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/custom-fields/field%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves all predictive/RFM/CLV paths, queries, and recompute policy", async () => {
    const { calls, request } = recordingRequester();
    const { predictiveApi: predictive } =
      createSubscriberIntelligenceApis(request);

    await predictive.catalog();
    await predictive.profiles({ segment: "high value & churn", limit: 0 });
    await predictive.profile("reader+vip@example.test");
    await predictive.rfmSegments();
    await predictive.clvDashboard({ previewLimit: 0 });
    await predictive.recompute();

    expect(calls).toEqual([
      {
        path: "/api/v1/predictive/catalog",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/predictive/profiles?segment=high+value+%26+churn&limit=0",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/predictive/profiles/reader%2Bvip%40example.test",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/predictive/rfm/segments",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/clv-dashboard?preview_limit=0",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/predictive/recompute",
        init: { method: "POST", body: "{}" },
        opts: { timeoutMs: 60_000, maxAttempts: 1 },
      },
    ]);
  });

  it("forwards predictive-profile cancellation without changing legacy calls", async () => {
    const { calls, request } = recordingRequester();
    const { predictiveApi: predictive } =
      createSubscriberIntelligenceApis(request);
    const controller = new AbortController();

    await predictive.profile("reader@example.test", {
      signal: controller.signal,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/predictive/profiles/reader%40example.test",
        init: undefined,
        opts: { signal: controller.signal },
      },
    ]);
  });

  it("accepts only the producer-shaped predictive list envelope", async () => {
    const pair = {
      prediction: {
        email: "reader@example.test",
        subscriber_id: "subscriber-1",
        historic_clv_cents: 100,
        predicted_clv_cents: 200,
        total_clv_cents: 300,
        churn_risk: 0.25,
        predicted_order_count: 2,
        predicted_gender: "unknown",
        confidence: 0.85,
        data_sufficiency: "sufficient",
      },
      rfm: {
        email: "reader@example.test",
        subscriber_id: "subscriber-1",
        frequency: 2,
        monetary_cents: 100,
        recency_score: 4,
        frequency_score: 3,
        monetary_score: 2,
        rfm_score: "432",
        segment_key: "loyal",
      },
    };
    const valid = createSubscriberIntelligenceApis(
      recordingRequester([{ data: { items: [pair] } }]).request,
    );
    await expect(valid.predictiveApi.profiles()).resolves.toEqual({
      data: { items: [pair] },
    });

    const flat = createSubscriberIntelligenceApis(
      recordingRequester([{ data: { items: [pair.prediction] } }]).request,
    );
    const malformed = await flat.predictiveApi.profiles();
    expect(malformed.error?.code).toBe("invalid_subscriber_response_contract");
    expect(malformed.data).toBeUndefined();
  });

  it("omits optional intelligence query strings exactly when absent", async () => {
    const { calls, request } = recordingRequester();
    const {
      contactRatingsApi: ratings,
      predictiveApi: predictive,
      zeroCopyTriggersApi: zeroCopy,
    } = createSubscriberIntelligenceApis(request);

    await ratings.recompute();
    await predictive.profiles();
    await predictive.clvDashboard();
    await zeroCopy.list();

    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/contact-ratings/recompute",
      "/api/v1/predictive/profiles",
      "/api/v1/clv-dashboard",
      "/api/v1/zero-copy-triggers",
    ]);
  });

  it("preserves all zero-copy trigger routes, bodies, and poll policy", async () => {
    const { calls, request } = recordingRequester();
    const { zeroCopyTriggersApi: zeroCopy } =
      createSubscriberIntelligenceApis(request);
    const input = {
      connection_id: "connection/one",
      journey_id: "journey/one",
      name: "Warehouse buyers",
      description: "New buyers",
      status: "active",
      provider: "snowflake",
      query: "select * from buyers",
      cursor_column: "updated_at",
      profile_key_column: "email",
      polling_interval_seconds: 300,
      max_rows_per_tick: 500,
      config: { warehouse: "analytics" },
    };

    await zeroCopy.list({
      status: "active & ready",
      cursor: "next/page",
      limit: 200,
    });
    await zeroCopy.create(input);
    await zeroCopy.get("trigger/one");
    await zeroCopy.update("trigger/one", input);
    await zeroCopy.remove("trigger/one");
    await zeroCopy.pollNow("trigger/one");
    await zeroCopy.fires("trigger/one");
    await zeroCopy.validate(input);
    await zeroCopy.getAlerts("trigger/one");
    await zeroCopy.putAlerts("trigger/one", {
      consecutive_failures_threshold: 3,
      lag_seconds_threshold: 900,
      fires_per_tick_threshold: 750,
      notify_webhook_url: "https://hooks.example.test/zero-copy",
      cooldown_seconds: 1_800,
    });
    await zeroCopy.listDLQ("trigger/one");
    await zeroCopy.retryDLQ("trigger/one", 42);

    expect(calls).toEqual([
      {
        path: "/api/v1/zero-copy-triggers?status=active+%26+ready&cursor=next%2Fpage&limit=200",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone",
        init: { method: "PUT", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/poll",
        init: { method: "POST", body: "{}" },
        opts: {
          timeoutMs: 30_000,
          maxAttempts: 1,
          requireOnline: true,
        },
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/fires",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/validate",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/alerts",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/alerts",
        init: {
          method: "PUT",
          body: JSON.stringify({
            consecutive_failures_threshold: 3,
            lag_seconds_threshold: 900,
            fires_per_tick_threshold: 750,
            notify_webhook_url: "https://hooks.example.test/zero-copy",
            cooldown_seconds: 1_800,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/dlq",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/zero-copy-triggers/trigger%2Fone/dlq/42/retry",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("preserves trigger-delay query encoding and upsert body", async () => {
    const { calls, request } = recordingRequester();
    const { triggerDelayApi: delays } =
      createSubscriberIntelligenceApis(request);
    const input = {
      subscriber_id: " ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF ",
      event_name: " Cart Updated & Ready ",
      optimal_delay_seconds: 3_600,
      // Response-owned metadata must never be replayed into the write body,
      // even when a structurally compatible variable carries extra keys.
      sample_count: 12,
      confidence: 0.82,
      reason: "historical conversion",
      computed_at: "2026-07-16T00:00:00Z",
    };

    await delays.getPreference({
      subscriberId: " ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF ",
      eventName: " Cart Updated & Ready ",
    });
    await delays.putPreference(input);

    expect(calls).toEqual([
      {
        path: "/api/v1/trigger-delay/preferences?subscriber_id=abcdefab-cdef-4abc-8def-abcdefabcdef&event_name=cart+updated+%26+ready",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/trigger-delay/preferences",
        init: {
          method: "PUT",
          body: JSON.stringify({
            subscriber_id: "abcdefab-cdef-4abc-8def-abcdefabcdef",
            event_name: "cart updated & ready",
            optimal_delay_seconds: 3_600,
            reason: "historical conversion",
          }),
        },
        opts: undefined,
      },
    ]);
  });
});
