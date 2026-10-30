import { describe, expect, it } from "vitest";

import {
  parseBotOpenSignatures,
  parseBotOpenStats,
  parseClickTrackingPolicy,
  parseDomainSetups,
  parseEntitlement,
  parseRoutingPolicy,
  parseWarmupPlans,
} from "../../components/deliverability/sending-control-response-contract";
import {
  parseCampaignDiagnosis,
  parseCampaignIspResponse,
  parsePlacementReport,
  parseTenantIspResponse,
} from "../../components/deliverability/diagnostics-response-contract";
import {
  parseAutoSuppress,
  parseAutoSuppressState,
  parseEqScoreResult,
  parseMutationOk,
  parseProviderConfigs,
} from "../../components/deliverability/settings-response-contract";
import {
  parseIntelligentRetryEvent,
  parseIntelligentRetryEvents,
} from "../../components/deliverability/remediation-response-contract";
import { parseCampaignOptions } from "../../components/deliverability/campaign-options";

const RETRY_EVENT = {
  id: "retry-1",
  tenant_id: "tenant-1",
  campaign_id: "campaign-1",
  subscriber_email: "reader@example.test",
  reason: "frequency_cap",
  status: "pending",
  retry_after: "2026-07-17T12:00:00Z",
  attempts: 1,
  created_at: "2026-07-17T10:00:00Z",
  updated_at: "2026-07-17T10:00:00Z",
};

describe("sending-control runtime response contracts", () => {
  it("rejects the populated generic bot-open fixture that omitted by_signature", () => {
    expect(
      parseBotOpenStats({
        since: "2026-06-17T00:00:00Z",
        total_opens: 10,
        bot_opens: 2,
        human_opens: 8,
      }),
    ).toBeNull();
    expect(
      parseBotOpenStats({
        since: "2026-06-17T00:00:00Z",
        total_opens: 10,
        bot_opens: 2,
        human_opens: 8,
        by_signature: [{ label: "Apple MPP", opens: 2 }],
      })?.by_signature,
    ).toEqual([{ label: "Apple MPP", opens: 2 }]);
  });

  it("validates every rendered bot signature and warmup-plan field", () => {
    const signature = {
      id: "sig-1",
      is_default: true,
      label: "Apple MPP",
      pattern: "AppleWebKit",
      kind: "prefetch",
      enabled: true,
      created_at: "2026-07-17T00:00:00Z",
    };
    expect(parseBotOpenSignatures([signature])).toEqual([signature]);
    expect(
      parseBotOpenSignatures([{ ...signature, enabled: "yes" }]),
    ).toBeNull();

    const plan = {
      id: "plan-1",
      domain: "mail.example.test",
      target_daily: 1_000,
      days: 3,
      started_on: "2026-07-15",
      status: "active",
      schedule: [100, 500, 1_000],
      last_sent_count: 80,
      created_at: "2026-07-15T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
    };
    expect(parseWarmupPlans([plan])).toEqual([plan]);
    expect(parseWarmupPlans([{ ...plan, schedule: [100, "500"] }])).toBeNull();
    expect(parseWarmupPlans({ plans: [] })).toBeNull();
  });

  it("validates each independently loaded deliverability-control section", () => {
    const setup = {
      domain: "mail.example.test",
      setup_mode: "automatic",
      status: "verified",
      ssl_status: "active",
      routing_status: "healthy",
    };
    expect(parseDomainSetups([setup])).toEqual([setup]);
    expect(parseDomainSetups([{ ...setup, ssl_status: undefined }])).toBeNull();

    expect(
      parseClickTrackingPolicy({
        tracking_domain: "click.example.test",
        status: "active",
        ssl_status: "active",
        disable_syntax: ["data-no-track"],
      }),
    ).not.toBeNull();
    expect(
      parseClickTrackingPolicy({
        tracking_domain: "click.example.test",
        status: "active",
        ssl_status: "active",
      }),
    ).toBeNull();

    expect(
      parseRoutingPolicy({
        status: "active",
        strategy: "hybrid",
        dedicated_pool: "dedicated",
        shared_pool: "shared",
        dedicated_percentage_bp: 5_000,
        max_dedicated_percentage_bp: 10_000,
      }),
    ).not.toBeNull();
    expect(
      parseRoutingPolicy({ status: "active", strategy: "hybrid" }),
    ).toBeNull();

    const entitlement = {
      period_start: "2026-07-01",
      plan_tier: "growth",
      inbox_tests_monthly: 100,
      render_previews_monthly: 500,
      inbox_tests_used: 12,
      render_previews_used: 45,
      overage_policy: "block",
      inbox_tests_remaining: 88,
      render_previews_remaining: 455,
    };
    expect(parseEntitlement(entitlement)).toEqual(entitlement);
    expect(
      parseEntitlement({ ...entitlement, inbox_tests_used: NaN }),
    ).toBeNull();
  });
});

describe("remediation and diagnostics runtime response contracts", () => {
  it("rejects malformed retry envelopes and mutation rows before string operations", () => {
    expect(
      parseIntelligentRetryEvents({ items: [RETRY_EVENT] }, "tenant-1"),
    ).toEqual([RETRY_EVENT]);
    expect(
      parseIntelligentRetryEvents(
        {
          items: [{ ...RETRY_EVENT, reason: undefined }],
        },
        "tenant-1",
      ),
    ).toBeNull();
    expect(
      parseIntelligentRetryEvents(
        {
          items: [{ ...RETRY_EVENT, tenant_id: undefined }],
        },
        "tenant-1",
      ),
    ).toBeNull();
    expect(
      parseIntelligentRetryEvents({ items: [RETRY_EVENT] }, "tenant-2"),
    ).toBeNull();
    expect(
      parseIntelligentRetryEvent(
        { ...RETRY_EVENT, reason: "quiet_hours" },
        "tenant-1",
      ),
    ).toBeNull();
    expect(parseIntelligentRetryEvent(RETRY_EVENT, "tenant-1")).toEqual(
      RETRY_EVENT,
    );
    expect(parseIntelligentRetryEvent(RETRY_EVENT, "tenant-2")).toBeNull();
    expect(
      parseIntelligentRetryEvent({ ...RETRY_EVENT, attempts: -1 }, "tenant-1"),
    ).toBeNull();
  });

  it("validates complete tenant and campaign ISP envelopes", () => {
    const bucket = {
      isp: "gmail.com",
      subscribers: 10,
      sent: 9,
      opens: 5,
      clicks: 2,
      bounces: 1,
      complaints: 0,
      open_rate: 0.5,
      click_rate: 0.2,
      bounce_rate: 0.1,
      complaint_rate: 0,
    };
    expect(
      parseTenantIspResponse({ window_days: 30, buckets: [bucket] }),
    ).toEqual({ windowDays: 30, buckets: [bucket] });
    expect(parseTenantIspResponse({ buckets: [bucket] })).toBeNull();
    expect(
      parseCampaignIspResponse(
        { campaign_id: "campaign-1", buckets: [bucket] },
        "campaign-1",
      ),
    ).toEqual([bucket]);
    expect(
      parseCampaignIspResponse(
        { campaign_id: "stale-campaign", buckets: [bucket] },
        "campaign-1",
      ),
    ).toBeNull();
  });

  it("rejects malformed placement maps and cross-campaign responses", () => {
    const report = {
      campaign_id: "campaign-1",
      providers: [{ provider: "gmail", total: 2, placements: { primary: 2 } }],
      overall_pct: { primary: 1 },
      total_inboxes: 2,
      generated_at: "2026-07-17T00:00:00Z",
    };
    expect(parsePlacementReport(report, "campaign-1")).toEqual(report);
    expect(parsePlacementReport(report, "campaign-2")).toBeNull();
    expect(
      parsePlacementReport({ ...report, providers: { provider: "gmail" } }),
    ).toBeNull();
    expect(
      parsePlacementReport({ ...report, overall_pct: { primary: "100%" } }),
    ).toBeNull();
  });

  it("validates diagnosis text, fixes, and finite impact maps", () => {
    const diagnosis = {
      campaign_id: "campaign-1",
      diagnosis: "## Placement\nHealthy.",
      fixes: [
        {
          title: "Publish DMARC",
          detail: "Move to quarantine.",
          action: "dns_record",
          estimated_impact: 0.1,
        },
      ],
      predicted_impact: { inbox_rate: 0.1 },
      generated_at: "2026-07-17T00:00:00Z",
    };
    expect(parseCampaignDiagnosis(diagnosis)).toEqual(diagnosis);
    expect(
      parseCampaignDiagnosis({ ...diagnosis, fixes: [{ title: "missing" }] }),
    ).toBeNull();
    expect(
      parseCampaignDiagnosis({
        ...diagnosis,
        predicted_impact: { inbox_rate: Infinity },
      }),
    ).toBeNull();
  });
});

describe("deliverability settings runtime response contracts", () => {
  it("validates provider envelopes without reading or displaying secrets", () => {
    const provider = {
      id: "provider-1",
      tenant_id: "tenant-1",
      provider: "sendgrid",
      display_name: "Production",
      config: { webhook_token_set: true },
      active: true,
      created_at: "2026-07-17T00:00:00Z",
      updated_at: "2026-07-17T00:00:00Z",
    };
    expect(parseProviderConfigs({ items: [provider] })).toEqual([provider]);
    expect(
      parseProviderConfigs({ items: [{ ...provider, active: "true" }] }),
    ).toBeNull();
    expect(parseProviderConfigs({ data: [provider] })).toBeNull();
  });

  it("requires explicit boolean settings and mutation confirmations", () => {
    expect(parseAutoSuppress({ auto_suppress: false })).toBe(false);
    expect(parseAutoSuppress({})).toBeNull();
    expect(parseAutoSuppress({ auto_suppress: 0 })).toBeNull();
    expect(
      parseAutoSuppressState({
        auto_suppress: true,
        eligible_now: 2,
        active_suppressions: 3,
        observed_at: "2026-07-17T12:00:00Z",
      }),
    ).toEqual({
      auto_suppress: true,
      eligible_now: 2,
      active_suppressions: 3,
      observed_at: "2026-07-17T12:00:00Z",
    });
    expect(
      parseAutoSuppressState({
        auto_suppress: true,
        eligible_now: -1,
        active_suppressions: 3,
        observed_at: "2026-07-17T12:00:00Z",
      }),
    ).toBeNull();
    expect(parseMutationOk({ ok: true })).toBe(true);
    expect(parseMutationOk({ ok: false })).toBe(false);
  });

  it("rejects incomplete EQ-score substructures before helper rendering", () => {
    const reason = {
      code: "auth",
      message: "SPF passed",
      severity: "info",
      bucket: "auth",
    };
    const subScore = { score: 90, weight: 0.3, reasons: [reason] };
    const result = {
      score: 88,
      grade: "A",
      content: subScore,
      auth: subScore,
      reputation: subScore,
      reasons: [reason],
      skippedSubScores: [],
    };
    expect(parseEqScoreResult(result)).toEqual(result);
    expect(parseEqScoreResult({ ...result, auth: {} })).toBeNull();
    expect(parseEqScoreResult({ ...result, score: "88" })).toBeNull();
  });

  it("distinguishes malformed campaign picker responses from real empties", () => {
    expect(parseCampaignOptions({ items: [] })).toEqual([]);
    expect(
      parseCampaignOptions([
        { id: "campaign-1", name: "Canonical array", status: "sent" },
      ]),
    ).toEqual([{ id: "campaign-1", label: "Canonical array · sent" }]);
    expect(parseCampaignOptions({ populated: true })).toBeNull();
    expect(parseCampaignOptions({ items: [{ id: 1, name: 42 }] })).toBeNull();
    expect(parseCampaignOptions({ items: [null] })).toBeNull();
  });
});
