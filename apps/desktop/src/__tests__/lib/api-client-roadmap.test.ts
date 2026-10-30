// Wire-shape tests for the roadmap build-tier wrappers
// (apps/desktop/ROADMAP-WRAPPERS.md). Each test pins the verified
// Go-handler contract for one representative wrapper:
//
//   - envelope keys ({items} vs {goals} vs {schedules} vs bare arrays)
//   - the "failed poll is still HTTP 200" feed contract
//   - request bodies / query-param encoding
//
// Same fetch-mocking pattern as api-client.test.ts /
// api-client-extended.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error — minimal window for module load
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  // @ts-expect-error — clean up
  delete globalThis.window;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

import {
  agentRoutinesApi,
  analyticsExtrasApi,
  analyticsNlqApi,
  auditExportSchedulesApi,
  engagementScoresApi,
  feedSourcesApi,
  formVariantsApi,
  goalsApi,
  landingPagesApi,
  mergeApplyApi,
  revenueAttributionApi,
  segmentInsightsApi,
  smsBroadcastsApi,
  voiceRoadmapApi,
  winbackSettingsApi,
} from "../../lib/api-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return jsonResponse({ error: { code, message } }, status);
}

describe("feedSourcesApi", () => {
  it("list returns the `{items}` envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              id: "fs1",
              name: "Blog RSS",
              url: "https://example.com/feed.xml",
              schedule: "daily",
              subject_template: "New post: {{title}}",
              enabled: true,
              created_at: "2026-06-01T00:00:00Z",
              updated_at: "2026-06-01T00:00:00Z",
            },
          ],
        }),
      ),
    );
    const r = await feedSourcesApi.list();
    expect(r.error).toBeUndefined();
    expect(r.data?.items.length).toBe(1);
    expect(r.data?.items[0].schedule).toBe("daily");
  });

  it("poll surfaces a FAILED run as data (HTTP 200 + status:'failed'), not an ApiErr", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({
          run_id: "run9",
          status: "failed",
          items_seen: 0,
          new_items: 0,
          error: "fetch feed: 404 Not Found",
        });
      }),
    );
    const r = await feedSourcesApi.poll("fs1");
    expect(r.error).toBeUndefined();
    expect(r.data?.status).toBe("failed");
    expect(r.data?.error).toContain("404");
    expect(urls[0]).toContain("/api/v1/feed-sources/fs1/poll");
  });
});

describe("engagementScoresApi", () => {
  it("get types a never-computed score as null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ score: null })),
    );
    const r = await engagementScoresApi.get("sub1");
    expect(r.error).toBeUndefined();
    expect(r.data?.score).toBeNull();
    expect(r.data?.computed_at).toBeUndefined();
  });

  it("subscribers encodes min/max/page/per_page and returns the page envelope", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({
          items: [{ id: "s1", email: "a@b.c", score: 72 }],
          total: 1,
          page: 2,
          per_page: 25,
        });
      }),
    );
    const r = await engagementScoresApi.subscribers({
      min: 50,
      max: 90,
      page: 2,
      perPage: 25,
    });
    expect(r.data?.total).toBe(1);
    expect(r.data?.items[0].score).toBe(72);
    expect(urls[0]).toContain("/api/v1/engagement-scores/subscribers?");
    expect(urls[0]).toContain("min=50");
    expect(urls[0]).toContain("max=90");
    expect(urls[0]).toContain("page=2");
    expect(urls[0]).toContain("per_page=25");
  });
});

describe("analyticsExtrasApi.fatigue", () => {
  it("returns the `{deciles}` envelope and passes ?days=", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({
          deciles: [
            {
              sends_bucket: "1-2",
              subscribers: 100,
              open_rate: 0.4,
              unsub_rate: 0.001,
            },
          ],
        });
      }),
    );
    const r = await analyticsExtrasApi.fatigue({ days: 60 });
    expect(r.data?.deciles[0].sends_bucket).toBe("1-2");
    expect(urls[0]).toContain("/api/v1/analytics/fatigue?days=60");
  });
});

describe("revenueAttributionApi", () => {
  it("campaigns returns totals + currencies + the rollup row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          items: [
            {
              campaign_id: "c1",
              campaign_name: "Spring",
              conversions: 4,
              revenue_cents: 12000,
              emails_sent: 1000,
              revenue_per_send_cents: 12,
            },
            {
              campaign_id: "",
              campaign_name: "(other campaigns)",
              conversions: 2,
              revenue_cents: 900,
              emails_sent: 0,
            },
          ],
          total_revenue_cents: 12900,
          unattributed_cents: 500,
          unattributed_conversions: 1,
          currency: "USD",
          currencies: [
            { currency: "USD", conversions: 7, revenue_cents: 13400 },
          ],
          days: 30,
        }),
      ),
    );
    const r = await revenueAttributionApi.campaigns({ days: 30 });
    expect(r.data?.total_revenue_cents).toBe(12900);
    expect(r.data?.items[1].campaign_name).toBe("(other campaigns)");
    expect(r.data?.items[1].revenue_per_send_cents).toBeUndefined();
    expect(r.data?.currencies[0].currency).toBe("USD");
  });
});

describe("agentRoutinesApi.run", () => {
  it("returns the 202 `{run_id,status}` ack", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({ run_id: "r1", status: "running" }, 202);
      }),
    );
    const r = await agentRoutinesApi.run("rt1");
    expect(r.data?.run_id).toBe("r1");
    expect(r.data?.status).toBe("running");
    expect(urls[0]).toContain("/api/v1/agent-routines/rt1/run");
  });

  it("surfaces 409 name_taken from create as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        errorResponse(
          409,
          "name_taken",
          "an agent routine with this name already exists",
        ),
      ),
    );
    const r = await agentRoutinesApi.create({
      name: "Weekly digest",
      prompt: "Draft the weekly digest",
      kind: "draft_campaign",
    });
    expect(r.error?.status).toBe(409);
    expect(r.error?.code).toBe("name_taken");
  });
});

describe("analyticsNlqApi.query", () => {
  it("POSTs `{question}` and returns the table-shaped answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { question: string };
        expect(body.question).toBe("top campaigns by opens");
        return jsonResponse({
          question: "top campaigns by opens",
          answer_kind: "table",
          template: "top_campaigns",
          params: { window_days: 30, limit: 10 },
          columns: ["campaign", "opens"],
          rows: [{ campaign: "Spring", opens: 412 }],
          summary_text: "",
          trace: {
            reasoning: "matched top_campaigns",
            prompt_tokens: 100,
            response_tokens: 20,
            summary_tokens: 0,
            generated_at: "2026-06-11T00:00:00Z",
          },
        });
      }),
    );
    const r = await analyticsNlqApi.query("top campaigns by opens");
    expect(r.data?.answer_kind).toBe("table");
    expect(r.data?.rows.length).toBe(1);
    expect(r.data?.trace.prompt_tokens).toBe(100);
  });
});

describe("voiceRoadmapApi.getStepVariant", () => {
  it("posts an opaque subscriber_id outside the URL and returns variant_key shape", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse({
          variant_key: "b",
          subject: "Hi there",
          body: "plain",
          weight_bp: 5000,
        });
      }),
    );
    const r = await voiceRoadmapApi.getStepVariant(
      "seq1",
      2,
      "subscriber_01HXYZ",
    );
    expect(r.data?.variant_key).toBe("b");
    expect(r.data?.weight_bp).toBe(5000);
    expect(calls[0]?.url).toContain(
      "/api/v1/voice/sequences/seq1/steps/2/variant",
    );
    expect(calls[0]?.url).not.toContain("?");
    expect(calls[0]?.url).not.toContain("subscriber");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      subscriber_id: "subscriber_01HXYZ",
    });
  });

  it("fails fast (no fetch) on a non-positive position", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await voiceRoadmapApi.getStepVariant("seq1", 0, "subscriber_1");
    expect(r.error?.kind).toBe("invalid_config");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails fast on email-shaped or unsafe subscriber identifiers", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const subscriberId of [
      "reader@example.test",
      "subscriber/1",
      "subscriber 1",
      "",
    ]) {
      const result = await voiceRoadmapApi.getStepVariant(
        "seq1",
        1,
        subscriberId,
      );
      expect(result.error?.kind).toBe("invalid_config");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("smsBroadcastsApi.send", () => {
  it("returns the 202 `{broadcast,progress,enqueued}` envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            broadcast: {
              id: "b1",
              name: "Flash sale",
              body: "20% off",
              list_ids: ["l1"],
              status: "sending",
              sent_count: 0,
              failed_count: 0,
              held_count: 0,
              segments_per_message: 1,
              created_at: "2026-06-11T00:00:00Z",
              updated_at: "2026-06-11T00:00:00Z",
            },
            progress: {
              status: "sending",
              sent: 0,
              failed: 0,
              held: 0,
              total: 40,
            },
            enqueued: 40,
          },
          202,
        ),
      ),
    );
    const r = await smsBroadcastsApi.send("b1");
    expect(r.data?.enqueued).toBe(40);
    expect(r.data?.broadcast.status).toBe("sending");
    expect(r.data?.progress.total).toBe(40);
  });

  it("surfaces the typed audience_too_large error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        errorResponse(
          422,
          "audience_too_large",
          "audience exceeds the broadcast cap",
        ),
      ),
    );
    const r = await smsBroadcastsApi.create({
      name: "x",
      body: "y",
      tag: "vip",
    });
    expect(r.error?.status).toBe(422);
    expect(r.error?.code).toBe("audience_too_large");
  });
});

describe("goalsApi", () => {
  it("list returns the `{goals}` envelope (NOT items)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          goals: [
            {
              id: "g1",
              metric: "subscribers",
              target: 1000,
              period: "monthly",
              starts_at: "2026-06-01T00:00:00Z",
              created_at: "2026-06-01T00:00:00Z",
              updated_at: "2026-06-01T00:00:00Z",
            },
          ],
        }),
      ),
    );
    const r = await goalsApi.list();
    expect(r.data?.goals.length).toBe(1);
    expect(r.data?.goals[0].metric).toBe("subscribers");
  });

  it("progress returns `{progress,as_of}`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          progress: [
            {
              goal: {
                id: "g1",
                metric: "subscribers",
                target: 1000,
                period: "monthly",
                starts_at: "2026-06-01T00:00:00Z",
                created_at: "2026-06-01T00:00:00Z",
                updated_at: "2026-06-01T00:00:00Z",
              },
              current: 412,
              target: 1000,
              pct: 41.2,
              pace: "behind",
              period_start: "2026-06-01T00:00:00Z",
              period_end: "2026-07-01T00:00:00Z",
              as_of: "2026-06-11T00:00:00Z",
            },
          ],
          as_of: "2026-06-11T00:00:00Z",
        }),
      ),
    );
    const r = await goalsApi.progress();
    expect(r.data?.progress[0].pace).toBe("behind");
    expect(r.data?.as_of).toBe("2026-06-11T00:00:00Z");
  });
});

describe("auditExportSchedulesApi", () => {
  it("list returns `{schedules}` and remove returns `{deleted:true}`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "DELETE") {
          expect(url).toContain("/api/v1/audit/export-schedules/sch1");
          return jsonResponse({ deleted: true });
        }
        return jsonResponse({
          schedules: [
            {
              id: "sch1",
              cadence: "weekly",
              recipients: ["sec@example.com"],
              enabled: true,
              created_at: "2026-06-01T00:00:00Z",
            },
          ],
        });
      }),
    );
    const list = await auditExportSchedulesApi.list();
    expect(list.data?.schedules[0].cadence).toBe("weekly");
    const del = await auditExportSchedulesApi.remove("sch1");
    expect(del.data?.deleted).toBe(true);
  });
});

describe("segmentInsightsApi.overlap", () => {
  it("encodes ?a=&b= and returns the overlap shape", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse({
          a: "s1",
          b: "s2",
          a_count: 100,
          b_count: 60,
          intersection: 30,
          jaccard: 0.2307,
        });
      }),
    );
    const r = await segmentInsightsApi.overlap("s1", "s2");
    expect(r.data?.intersection).toBe(30);
    expect(urls[0]).toContain("/api/v1/segments/overlap?a=s1&b=s2");
  });
});

describe("winbackSettingsApi.put", () => {
  it("PUTs `{enabled,churn_threshold}` and returns the persisted settings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          enabled: boolean;
          churn_threshold: number;
        };
        expect(body.enabled).toBe(true);
        expect(body.churn_threshold).toBe(0.7);
        return jsonResponse({
          enabled: true,
          churn_threshold: 0.7,
          churn_profiles_scored: 1234,
        });
      }),
    );
    const r = await winbackSettingsApi.put({
      enabled: true,
      churn_threshold: 0.7,
    });
    expect(r.data?.churn_profiles_scored).toBe(1234);
  });
});

describe("mergeApplyApi.apply", () => {
  it("POSTs the merge body and returns the plan + move counters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as {
          primary_id: string;
          duplicate_id: string;
          scan_id: string;
          expected_primary_updated_at: string;
          expected_duplicate_updated_at: string;
          dry_run?: boolean;
        };
        expect(body.primary_id).toBe("p1");
        expect(body.duplicate_id).toBe("d1");
        expect(body.scan_id).toBe("scan-1");
        expect(body.dry_run).toBe(true);
        return jsonResponse({
          primary_id: "p1",
          duplicate_id: "d1",
          dry_run: true,
          plan: {
            tags: ["vip"],
            custom_fields: {},
            status: "enabled",
            gdpr_permissions: [],
            conflicts: [],
            preserved_on_duplicate: ["profile identifiers"],
          },
          events_moved: 0,
          suppressions_moved: 0,
          loser_soft_deleted: false,
          primary_updated_at: "2026-07-18T12:00:00Z",
          duplicate_updated_at: "2026-07-18T12:01:00Z",
          plan_fingerprint: `sha256:${"a".repeat(64)}`,
        });
      }),
    );
    const r = await mergeApplyApi.apply({
      primary_id: "p1",
      duplicate_id: "d1",
      scan_id: "scan-1",
      expected_primary_updated_at: "2026-07-18T12:00:00Z",
      expected_duplicate_updated_at: "2026-07-18T12:01:00Z",
      dry_run: true,
    });
    expect(r.data?.plan.tags).toContain("vip");
    expect(r.data?.loser_soft_deleted).toBe(false);
  });

  it("surfaces 409 already_merged as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        errorResponse(
          409,
          "already_merged",
          "merge: duplicate was already merged",
        ),
      ),
    );
    const r = await mergeApplyApi.apply({
      primary_id: "p1",
      duplicate_id: "d1",
      scan_id: "scan-1",
      expected_primary_updated_at: "2026-07-18T12:00:00Z",
      expected_duplicate_updated_at: "2026-07-18T12:01:00Z",
      expected_plan_fingerprint: `sha256:${"a".repeat(64)}`,
    });
    expect(r.error?.status).toBe(409);
    expect(r.error?.code).toBe("already_merged");
  });

  it("fails closed when a nominal plan is not bound to the reviewed versions and fingerprint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          primary_id: "p1",
          duplicate_id: "d1",
          dry_run: true,
          plan: {
            tags: [],
            custom_fields: {},
            status: "enabled",
            gdpr_permissions: [],
            conflicts: [],
            preserved_on_duplicate: [],
          },
          events_moved: 0,
          suppressions_moved: 0,
          loser_soft_deleted: false,
          primary_updated_at: "2026-07-18T12:00:09Z",
          duplicate_updated_at: "2026-07-18T12:01:00Z",
          plan_fingerprint: "sha256:too-short",
        }),
      ),
    );
    const r = await mergeApplyApi.apply({
      primary_id: "p1",
      duplicate_id: "d1",
      scan_id: "scan-1",
      expected_primary_updated_at: "2026-07-18T12:00:00Z",
      expected_duplicate_updated_at: "2026-07-18T12:01:00Z",
      dry_run: true,
    });
    expect(r.error?.code).toBe("invalid_subscriber_response_contract");
    if (!r.error) throw new Error("Expected reviewed-plan contract failure");
    expect(r.retryability).toBe("manual");
  });
});

describe("Task-2 wrappers (mounted packages)", () => {
  it("formVariantsApi.list returns a BARE camelCase array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "v1",
            tenantId: "t1",
            formId: "f1",
            label: "Control",
            displayConfig: {},
            trafficPct: 50,
            status: "active",
            lastZScore: 0,
            impressions: 100,
            submissions: 7,
            conversionRate: 0.07,
            createdAt: "2026-06-01T00:00:00Z",
            updatedAt: "2026-06-01T00:00:00Z",
          },
        ]),
      ),
    );
    const r = await formVariantsApi.list("f1");
    expect(Array.isArray(r.data)).toBe(true);
    expect(r.data?.[0].trafficPct).toBe(50);
    expect(r.data?.[0].conversionRate).toBeCloseTo(0.07);
  });

  it("landingPagesApi.list returns a BARE array of pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "lp1",
            tenant_id: "t1",
            slug: "spring-sale",
            name: "Spring Sale",
            status: "draft",
            template: "default",
            blocks: [],
            seo: {},
            tracking: {},
            metrics: {},
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-01T00:00:00Z",
          },
        ]),
      ),
    );
    const r = await landingPagesApi.list();
    expect(Array.isArray(r.data)).toBe(true);
    expect(r.data?.[0].slug).toBe("spring-sale");
  });
});
