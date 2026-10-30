import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const ANALYTICS_FIXED_NOW = new Date("2026-07-24T12:00:00.000Z");

export type AnalyticsEvidenceScenario =
  | "populated"
  | "empty"
  | "partial"
  | "mixed-currency";
export type AnalyticsEvidenceRole = "admin" | "viewer";
export type AnalyticsEvidenceTheme = "dark" | "light";

export interface AnalyticsEvidenceOptions {
  role?: AnalyticsEvidenceRole;
  scenario?: AnalyticsEvidenceScenario;
}

export interface AnalyticsLedgerEntry {
  sequence: number;
  method: string;
  path: string;
  query: string;
  status: number;
  classification: "read" | "control" | "write" | "unexpected";
  requestBody?: unknown;
}

export interface AnalyticsHttpError {
  method: string;
  path: string;
  status: number;
}

export interface AnalyticsEvidenceControl {
  errors: AnalyticsHttpError[];
  ledger: AnalyticsLedgerEntry[];
  unexpected: AnalyticsLedgerEntry[];
  writes: AnalyticsLedgerEntry[];
  pendingRequests: () => number;
}

interface OpenAnalyticsEvidenceOptions extends AnalyticsEvidenceOptions {
  bootApp: (page: Page) => Promise<void>;
  page: Page;
  setTheme: (
    page: Page,
    theme: "system" | AnalyticsEvidenceTheme,
  ) => Promise<void>;
  theme?: AnalyticsEvidenceTheme;
}

interface EvidenceReply {
  body: unknown;
  contentType?: string;
  status?: number;
}

const CAMPAIGNS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Summer retention launch",
    subject: "A calmer way to keep growing",
    status: "sent",
    sent_at: "2026-07-23T14:00:00.000Z",
    open_rate: 0.438,
    click_rate: 0.081,
    goal_event: "checkout.completed",
    goal_window_hours: 168,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Product digest · July",
    subject: "The features customers asked for",
    status: "sent",
    sent_at: "2026-07-20T09:00:00.000Z",
    open_rate: 0.401,
    click_rate: 0.069,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Win-back field note",
    subject: "Still thinking it over?",
    status: "sent",
    sent_at: "2026-07-16T16:30:00.000Z",
    open_rate: 0.367,
    click_rate: 0.052,
  },
] as const;

const PREDICTIVE_PROFILES = {
  items: [
    {
      prediction: {
        email: "ada.analytics@example.invalid",
        subscriber_id: "sub-vip-001",
        historic_clv_cents: 248_900,
        predicted_clv_cents: 91_500,
        total_clv_cents: 340_400,
        churn_risk: 0.08,
        predicted_order_count: 4.2,
        average_days_between_orders: 28,
        expected_next_order_at: "2026-08-10T00:00:00.000Z",
        predicted_gender: "unknown",
        confidence: 0.85,
        data_sufficiency: "sufficient",
        explanation: { orders: 12, observation_window_days: 365 },
        churn_drivers: [],
        calculated_at: "2026-07-24T10:30:00.000Z",
      },
      rfm: {
        email: "ada.analytics@example.invalid",
        subscriber_id: "sub-vip-001",
        recency_days: 4,
        frequency: 12,
        monetary_cents: 248_900,
        recency_score: 5,
        frequency_score: 5,
        monetary_score: 5,
        rfm_score: "555",
        segment_key: "champions",
        calculated_at: "2026-07-24T10:30:00.000Z",
      },
    },
    {
      prediction: {
        email: "grace.risk@example.invalid",
        subscriber_id: "sub-risk-002",
        historic_clv_cents: 82_400,
        predicted_clv_cents: 9_600,
        total_clv_cents: 92_000,
        churn_risk: 0.82,
        predicted_order_count: 0.8,
        average_days_between_orders: 121,
        expected_next_order_at: null,
        predicted_gender: "unknown",
        confidence: 0.3,
        data_sufficiency: "limited",
        explanation: { orders: 2, observation_window_days: 365 },
        churn_drivers: [
          {
            key: "recency",
            label: "Long time since last order",
            value: "121 days",
            impact: "high",
          },
        ],
        calculated_at: "2026-07-24T10:30:00.000Z",
      },
      rfm: {
        email: "grace.risk@example.invalid",
        subscriber_id: "sub-risk-002",
        recency_days: 121,
        frequency: 2,
        monetary_cents: 82_400,
        recency_score: 1,
        frequency_score: 2,
        monetary_score: 4,
        rfm_score: "124",
        segment_key: "at_risk",
        calculated_at: "2026-07-24T10:30:00.000Z",
      },
    },
  ],
} as const;

const PREDICTIVE_CATALOG = {
  schema_version: "predictive.v1",
  models: [
    {
      key: "clv",
      label: "Customer lifetime value",
      runtime_status: "supported",
      version: "2026.07",
    },
    {
      key: "churn",
      label: "Churn risk",
      runtime_status: "partial",
      version: "2026.07",
    },
  ],
  rfm_segments: [
    { key: "champions", label: "Champions" },
    { key: "at_risk", label: "At risk" },
  ],
} as const;

function isEmpty(scenario: AnalyticsEvidenceScenario): boolean {
  return scenario === "empty";
}

function daysForRange(range: string | null): number {
  if (range === "7d") return 7;
  if (range === "90d") return 90;
  return 30;
}

function dateSeries(
  days: number,
  value: (index: number) => number,
): Array<{ date: string; count: number }> {
  return Array.from({ length: Math.max(1, Math.min(days, 90)) }, (_, index) => {
    const date = new Date(ANALYTICS_FIXED_NOW);
    date.setUTCDate(date.getUTCDate() - (days - index - 1));
    return { date: date.toISOString().slice(0, 10), count: value(index) };
  });
}

function dashboardStats(
  range: string | null,
  scenario: AnalyticsEvidenceScenario,
): Record<string, unknown> {
  const empty = isEmpty(scenario);
  return {
    range: range === "7d" || range === "90d" ? range : "30d",
    subscribers_total: empty ? 0 : 18_642,
    subscribers_added_30d: empty ? 0 : 734,
    subscribers_unsubbed_30d: empty ? 0 : 83,
    campaigns_sent_30d: empty ? 0 : 12,
    emails_sent_30d: empty ? 0 : 91_420,
    opens_total_30d: empty ? 0 : 38_640,
    clicks_total_30d: empty ? 0 : 7_312,
    bounces_total_30d: empty ? 0 : 512,
    unique_opens_30d: empty ? 0 : 37_986,
    unique_clicks_30d: empty ? 0 : 7_104,
    unique_bounces_30d: empty ? 0 : 512,
    unique_delivered_30d: empty ? 0 : 90_908,
    unique_sent_30d: empty ? 0 : 91_420,
    active_sequences_count: empty ? 0 : 6,
    previous: {
      subscribers_added: empty ? 0 : 682,
      subscribers_unsubbed: empty ? 0 : 91,
      campaigns_sent: empty ? 0 : 10,
      emails_sent: empty ? 0 : 86_310,
      opens_total: empty ? 0 : 34_915,
      clicks_total: empty ? 0 : 6_302,
      bounces_total: empty ? 0 : 604,
      unique_opens: empty ? 0 : 34_201,
      unique_clicks: empty ? 0 : 6_114,
      unique_bounces: empty ? 0 : 604,
      unique_delivered: empty ? 0 : 85_706,
      unique_sent: empty ? 0 : 86_310,
    },
    sparklines: {
      subscribers: empty
        ? [0, 0, 0, 0, 0, 0, 0]
        : [17_908, 18_015, 18_126, 18_244, 18_359, 18_511, 18_642],
      opens: empty
        ? [0, 0, 0, 0, 0, 0, 0]
        : [4_980, 5_240, 5_081, 5_702, 5_619, 6_103, 5_915],
      clicks: empty
        ? [0, 0, 0, 0, 0, 0, 0]
        : [894, 978, 1_011, 1_103, 1_008, 1_201, 1_117],
      bounces: empty ? [0, 0, 0, 0, 0, 0, 0] : [81, 75, 70, 82, 69, 66, 69],
    },
    anomalies: empty
      ? { opens: false, clicks: false, bounces: false }
      : { opens: false, clicks: true, bounces: false },
    recent_audit: [],
  };
}

function campaignReport(
  index: number,
  empty: boolean,
): Record<string, unknown> {
  const sent = empty ? 0 : 12_000 - index * 1_450;
  const delivered = empty ? 0 : sent - (220 - index * 28);
  const uniqueOpens = empty ? 0 : 4_920 - index * 620;
  const uniqueClicks = empty ? 0 : 902 - index * 129;
  const opens = empty ? 0 : uniqueOpens + 382;
  const clicks = empty ? 0 : uniqueClicks + 83;
  const bounces = Math.max(0, sent - delivered);
  return {
    campaign_id: CAMPAIGNS[index]?.id ?? CAMPAIGNS[0].id,
    sent,
    delivered,
    opens,
    unique_opens: uniqueOpens,
    clicks,
    unique_clicks: uniqueClicks,
    bounces,
    complaints: empty ? 0 : 7 + index,
    unsubscribes: empty ? 0 : 21 + index * 3,
    open_rate: delivered > 0 ? uniqueOpens / delivered : 0,
    click_rate: delivered > 0 ? uniqueClicks / delivered : 0,
    click_to_open_rate: uniqueOpens > 0 ? uniqueClicks / uniqueOpens : 0,
    bounce_rate: sent > 0 ? bounces / sent : 0,
    unsub_rate: sent > 0 ? (21 + index * 3) / sent : 0,
    top_links: empty
      ? []
      : [
          { url: "https://postwave.example.invalid/launch", clicks: 420 },
          { url: "https://postwave.example.invalid/guide", clicks: 233 },
        ],
    human_opens: empty ? 0 : Math.max(0, opens - 411),
    human_unique_opens: empty ? 0 : Math.max(0, uniqueOpens - 265),
    human_clicks: empty ? 0 : Math.max(0, clicks - 91),
    human_unique_clicks: empty ? 0 : Math.max(0, uniqueClicks - 54),
    human_open_rate:
      delivered > 0 ? Math.max(0, uniqueOpens - 265) / delivered : 0,
    human_click_rate:
      delivered > 0 ? Math.max(0, uniqueClicks - 54) / delivered : 0,
    human_click_to_open_rate:
      uniqueOpens > 265
        ? Math.max(0, uniqueClicks - 54) / (uniqueOpens - 265)
        : 0,
    human_top_links: empty
      ? []
      : [{ url: "https://postwave.example.invalid/launch", clicks: 381 }],
    bot_signatures_applied: empty ? [] : ["apple_mpp", "gmail_image_proxy"],
  };
}

function campaignBenchmark(
  campaignId: string,
  empty: boolean,
): Record<string, unknown> {
  const current = {
    recipients: empty ? 0 : 12_000,
    open_rate: empty ? 0 : 0.418,
    click_rate: empty ? 0 : 0.076,
    bounce_rate: empty ? 0 : 0.018,
    complaint_rate: empty ? 0 : 0.0006,
    unsubscribe_rate: empty ? 0 : 0.0019,
  };
  const baseline = {
    recipients: empty ? 0 : 10_830,
    open_rate: empty ? 0 : 0.374,
    click_rate: empty ? 0 : 0.064,
    bounce_rate: empty ? 0 : 0.022,
    complaint_rate: empty ? 0 : 0.0008,
    unsubscribe_rate: empty ? 0 : 0.0022,
  };
  const metric = (
    name: string,
    value: number,
    base: number,
    percentile: number,
    invert = false,
  ) => {
    const available = !empty;
    const verdict =
      Math.abs(value - base) < 0.0001
        ? "on_par"
        : invert
          ? value < base
            ? "above"
            : "below"
          : value > base
            ? "above"
            : "below";
    return {
      name,
      value,
      baseline: base,
      delta: value - base,
      delta_pct: available && base !== 0 ? ((value - base) / base) * 100 : null,
      percentile: available ? percentile : null,
      available,
      ...(available ? { verdict } : { reason: "insufficient_baseline_sample" }),
    };
  };
  return {
    campaign_id: campaignId,
    baseline_days: 90,
    baseline_from: "2026-04-25T12:00:00.000Z",
    baseline_to: ANALYTICS_FIXED_NOW.toISOString(),
    as_of: ANALYTICS_FIXED_NOW.toISOString(),
    timezone: "UTC",
    baseline_selection: "sent_campaigns_by_last_recipient_sent_at",
    this: current,
    tenant_baseline: baseline,
    baseline_sample_size: empty ? 0 : 12,
    minimum_sample_size: 5,
    baseline_available: !empty,
    ...(empty
      ? { baseline_unavailable_reason: "insufficient_baseline_sample" }
      : {}),
    metrics: [
      metric("open_rate", current.open_rate, baseline.open_rate, 78),
      metric("click_rate", current.click_rate, baseline.click_rate, 81),
      metric(
        "bounce_rate",
        current.bounce_rate,
        baseline.bounce_rate,
        71,
        true,
      ),
      metric(
        "complaint_rate",
        current.complaint_rate,
        baseline.complaint_rate,
        69,
        true,
      ),
      metric(
        "unsubscribe_rate",
        current.unsubscribe_rate,
        baseline.unsubscribe_rate,
        73,
        true,
      ),
    ],
  };
}

function campaignIndex(campaignId: string): number {
  const index = CAMPAIGNS.findIndex((campaign) => campaign.id === campaignId);
  return index < 0 ? 0 : index;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<redacted-email>")
    .replace(
      /([?&](?:token|key|secret|signature)=)[^&#\s]*/giu,
      "$1<redacted>",
    );
}

function sanitizeUnknown(value: unknown, key = ""): unknown {
  if (
    /(?:authorization|api[_-]?key|secret|signature|token|email|recipient|question)/iu.test(
      key,
    )
  ) {
    if (Array.isArray(value)) return value.map(() => "<redacted>");
    return value == null ? value : "<redacted>";
  }
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, item]) => [entryKey, sanitizeUnknown(item, entryKey)],
      ),
    );
  }
  return value;
}

function sanitizedQuery(url: URL): string {
  const params = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const safeValue = /(?:token|key|email|recipient)/iu.test(key)
        ? "<redacted>"
        : sanitizeText(value);
      return `${encodeURIComponent(key)}=${encodeURIComponent(safeValue)}`;
    });
  return params.length > 0 ? `?${params.join("&")}` : "";
}

function requestBody(route: Route): unknown {
  const raw = route.request().postData();
  if (!raw) return undefined;
  try {
    return sanitizeUnknown(JSON.parse(raw));
  } catch {
    return sanitizeText(raw);
  }
}

function errorReply(
  code: string,
  message: string,
  status: number,
): EvidenceReply {
  return { body: { error: { code, message } }, status };
}

function partialFailure(
  path: string,
  scenario: AnalyticsEvidenceScenario,
): EvidenceReply | null {
  if (scenario !== "partial") return null;
  if (
    path === "/api/v1/replies/top-senders" ||
    path === "/api/v1/predictive/catalog" ||
    path === "/api/v1/conversions/attribution/timeseries" ||
    path === "/api/v1/analytics/fatigue"
  ) {
    return errorReply(
      "analytics_evidence_partial",
      "This evidence source is temporarily unavailable.",
      503,
    );
  }
  return null;
}

function viewerFailure(
  path: string,
  method: string,
  role: AnalyticsEvidenceRole,
): EvidenceReply | null {
  if (role !== "viewer") return null;
  if (
    path === "/api/v1/predictive/profiles" ||
    path === "/api/v1/subscribers" ||
    path === "/api/v1/suppressions" ||
    path === "/api/v1/replies/top-senders" ||
    path === "/api/v1/scheduled-reports" ||
    (method !== "GET" && path.startsWith("/api/v1/reporting/definitions"))
  ) {
    return errorReply(
      "insufficient_scope",
      "This view requires additional workspace access.",
      403,
    );
  }
  return null;
}

function revenueAttribution(
  scenario: AnalyticsEvidenceScenario,
): Record<string, unknown> {
  if (isEmpty(scenario)) {
    return {
      items: [],
      total_revenue_cents: 0,
      unattributed_cents: 0,
      unattributed_conversions: 0,
      currency: "USD",
      currencies: [],
      total_campaigns: 0,
      days: 30,
    };
  }
  const mixed = scenario === "mixed-currency";
  return {
    items: [
      {
        campaign_id: CAMPAIGNS[0].id,
        campaign_name: CAMPAIGNS[0].name,
        conversions: 84,
        revenue_cents: 642_900,
        emails_sent: 12_000,
        revenue_per_send_cents: 53.575,
      },
      {
        campaign_id: CAMPAIGNS[1].id,
        campaign_name: CAMPAIGNS[1].name,
        conversions: 46,
        revenue_cents: 318_500,
        emails_sent: 10_550,
        revenue_per_send_cents: 30.189,
      },
      {
        campaign_id: "",
        campaign_name: "(other campaigns)",
        conversions: 22,
        revenue_cents: -18_400,
        emails_sent: 7_100,
      },
    ],
    total_revenue_cents: 1_102_600,
    unattributed_cents: 159_600,
    unattributed_conversions: 19,
    ...(mixed ? {} : { currency: "USD" }),
    currencies: mixed
      ? [
          { currency: "USD", conversions: 133, revenue_cents: 1_102_600 },
          { currency: "EUR", conversions: 19, revenue_cents: 184_300 },
        ]
      : [{ currency: "USD", conversions: 152, revenue_cents: 1_102_600 }],
    total_campaigns: 54,
    days: 30,
  };
}

function revenueTimeseries(
  url: URL,
  scenario: AnalyticsEvidenceScenario,
): Record<string, unknown> {
  const days = Number(url.searchParams.get("days") ?? "30");
  const mixed = scenario === "mixed-currency";
  return {
    points: isEmpty(scenario)
      ? []
      : dateSeries(days, (index) =>
          index === Math.max(0, days - 4) ? -184 : 120 + ((index * 97) % 560),
        ).map(({ date, count }) => ({
          date,
          revenue_cents: count * 100,
          conversions: count < 0 ? 1 : 2 + (count % 5),
        })),
    ...(mixed ? {} : { currency: "USD" }),
    currencies: mixed
      ? [
          { currency: "USD", conversions: 133, revenue_cents: 1_102_600 },
          { currency: "EUR", conversions: 19, revenue_cents: 184_300 },
        ]
      : [{ currency: "USD", conversions: 152, revenue_cents: 1_102_600 }],
    days,
    ...(url.searchParams.get("campaign_id")
      ? { campaign_id: url.searchParams.get("campaign_id") }
      : {}),
  };
}

function resolveCampaignEndpoint(
  path: string,
  scenario: AnalyticsEvidenceScenario,
): EvidenceReply | null {
  const match = /^\/api\/v1\/campaigns\/([^/]+)\/([^/]+)$/u.exec(path);
  if (!match) return null;
  const campaignId = decodeURIComponent(match[1] ?? "");
  const endpoint = match[2] ?? "";
  const empty = isEmpty(scenario);
  const index = campaignIndex(campaignId);
  if (endpoint === "report") return { body: campaignReport(index, empty) };
  if (endpoint === "link-report") {
    return {
      body: empty
        ? []
        : [
            {
              url: "https://postwave.example.invalid/launch",
              clicks: 420 - index * 31,
              unique_clickers: 391 - index * 28,
              ctr: 0.036,
            },
            {
              url: "https://postwave.example.invalid/guide",
              clicks: 233 - index * 19,
              unique_clickers: 211 - index * 16,
              ctr: 0.02,
            },
          ],
    };
  }
  if (endpoint === "geography") {
    return {
      body: empty
        ? []
        : [
            { country: "United States", opens: 2_410, clicks: 498 },
            { country: "India", opens: 1_204, clicks: 229 },
            { country: "United Kingdom", opens: 844, clicks: 143 },
          ],
    };
  }
  if (endpoint === "devices") {
    return {
      body: empty
        ? []
        : [
            { client: "Apple Mail", opens: 2_114, clicks: 292 },
            { client: "Gmail", opens: 1_672, clicks: 341 },
            { client: "Outlook", opens: 803, clicks: 154 },
            { client: "Yahoo Mail", opens: 244, clicks: 41 },
            { client: "Other", opens: 87, clicks: 19 },
          ],
    };
  }
  if (endpoint === "bounces") {
    return {
      body: empty
        ? { hard: 0, soft: 0, spam_trap: 0, total: 0 }
        : { hard: 91, soft: 123, spam_trap: 6, total: 220 },
    };
  }
  if (endpoint === "revenue") {
    return {
      body: {
        attributed_revenue_cents: empty ? 0 : 642_900,
        currency: "USD",
        conversions: empty ? 0 : 84,
        attribution_window_days: 7,
        note: "Legacy campaign-level attribution response.",
      },
    };
  }
  if (endpoint === "benchmark") {
    return { body: campaignBenchmark(campaignId, empty) };
  }
  if (endpoint === "engagement") {
    return {
      body: {
        campaign_id: campaignId,
        delivered: empty ? 0 : 11_780,
        human_unique_opens: empty ? 0 : 4_655,
        human_open_rate: empty ? 0 : 0.3952,
        raw_open_rate: empty ? 0 : 0.451,
        reply_count: empty ? 0 : 137,
        distinct_replyers: empty ? 0 : 121,
        reply_rate: empty ? 0 : 0.0103,
        open_decoupled_conversions: empty ? 0 : 18,
        total_attributed_conversions: empty ? 0 : 84,
        bot_signatures_applied: empty ? [] : ["apple_mpp", "gmail_image_proxy"],
        ai_surfacing_score: empty ? 0 : 0.72,
        ai_surfacing_basis: empty
          ? []
          : ["human engagement", "reply depth", "conversion evidence"],
        ai_surfacing_confidence_level: empty ? "low" : "ok",
        ai_surfacing_sample_opens: empty ? 0 : 4_655,
      },
    };
  }
  if (endpoint === "timeseries") {
    return {
      body: {
        campaign_id: campaignId,
        buckets: empty
          ? []
          : Array.from({ length: 12 }, (_, hour) => ({
              hour: `2026-07-23T${String(hour + 12).padStart(2, "0")}:00:00Z`,
              opens: hour === 4 ? 1_210 : 120 + ((hour * 83) % 430),
              clicks: 22 + ((hour * 29) % 91),
              unsubs: hour % 4 === 0 ? 2 : 0,
            })),
      },
    };
  }
  if (endpoint === "goal-results") {
    return {
      body: {
        campaign_id: campaignId,
        goal_event: empty ? "" : "checkout.completed",
        goal_window_hours: empty ? 0 : 168,
        configured: !empty,
        conversion_count: empty ? 0 : 84,
        recipients: empty ? 0 : 12_000,
        conversion_rate: empty ? 0 : 0.007,
        attributed_revenue_cents: empty ? 0 : 642_900,
        currency: "USD",
      },
    };
  }
  if (endpoint === "anomalies") {
    return {
      body: {
        campaign_id: campaignId,
        anomalies: empty
          ? []
          : [
              {
                hour: "2026-07-23T16:00:00Z",
                metric: "opens",
                value: 1_210,
                mean: 382.4,
                z_score: 2.91,
                direction: "spike",
              },
            ],
      },
    };
  }
  if (endpoint === "locale-report") {
    return {
      body: {
        campaign_id: campaignId,
        locales: empty
          ? []
          : [
              { locale: "en-US", sent: 8_400, opens: 3_720, clicks: 682 },
              { locale: "en-GB", sent: 2_100, opens: 811, clicks: 142 },
              { locale: "hi-IN", sent: 1_500, opens: 601, clicks: 109 },
            ],
      },
    };
  }
  return null;
}

function resolveAnalyticsRequest(
  url: URL,
  method: string,
  scenario: AnalyticsEvidenceScenario,
  role: AnalyticsEvidenceRole,
): EvidenceReply | null {
  const { pathname: path } = url;
  const viewer = viewerFailure(path, method, role);
  if (viewer) return viewer;
  const partial = partialFailure(path, scenario);
  if (partial) return partial;
  const empty = isEmpty(scenario);

  if (method === "GET" && path === "/api/v1/auth/me") {
    return {
      body: {
        user_id: `analytics-${role}`,
        tenant_id: "test-tenant",
        email: `${role}@analytics.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Moosewave Analytics Evidence",
        workspace_slug: "test-tenant",
      },
    };
  }
  if (method === "GET" && path === "/api/v1/me") {
    return {
      body: {
        user: `${role}@analytics.example.invalid`,
        tenant: "Moosewave Analytics Evidence",
      },
    };
  }
  if (method === "GET" && path === "/api/v1/audit/my-scopes") {
    return {
      body: {
        scopes: role === "admin" ? ["audit:read", "audit:read_pii"] : [],
        auditScopes: role === "admin" ? ["audit:read", "audit:read_pii"] : [],
        isAdmin: role === "admin",
      },
    };
  }
  if (method === "GET" && path === "/api/v1/health") {
    return { body: { status: "ok", version: "evidence", service: "api" } };
  }
  if (method === "GET" && path === "/api/v1/onboarding-progress") {
    return {
      body: {
        steps: [],
        completed: 0,
        total: 0,
        percent: 0,
        all_done: false,
      },
    };
  }
  if (method === "GET" && path === "/api/v1/custom-domains") {
    return { body: [] };
  }
  if (method === "GET" && path === "/api/v1/track/stats") {
    return {
      body: {
        periodDays: Number(url.searchParams.get("days") ?? "30"),
        totalEvents: 0,
        uniqueSubscribers: 0,
        uniqueEventNames: 0,
        daily: [],
        timeZone: "UTC",
        asOf: ANALYTICS_FIXED_NOW.toISOString(),
      },
    };
  }
  if (method === "GET" && path === "/api/v1/deliverability/dmarc-reports") {
    return { body: { items: [] } };
  }
  if (method === "POST" && path === "/api/v1/streams/token") {
    return {
      body: {
        token: "analytics-evidence-stream-token",
        expires_at: "2026-07-24T12:01:00.000Z",
        ttl_seconds: 60,
      },
    };
  }
  if (method === "GET" && path === "/api/v1/dashboard/stats") {
    return {
      body: dashboardStats(url.searchParams.get("range"), scenario),
    };
  }
  if (method === "GET" && path === "/api/v1/campaigns") {
    return {
      body: {
        items: empty ? [] : CAMPAIGNS,
        total: empty ? 0 : CAMPAIGNS.length,
      },
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/subscribers/timeseries") {
    const range = url.searchParams.get("range");
    const days = daysForRange(range);
    return {
      body: {
        range: range === "7d" || range === "90d" ? range : "30d",
        points: empty ? [] : dateSeries(days, (index) => 17_900 + index * 26),
      },
    };
  }
  if (method === "GET" && path === "/api/v1/voice/sequences") {
    return {
      body: {
        items: empty
          ? []
          : [
              {
                id: "44444444-4444-4444-8444-444444444444",
                name: "Lifecycle onboarding",
                status: "active",
                steps: 3,
                active_runs: 1_284,
              },
            ],
      },
    };
  }
  if (
    method === "GET" &&
    /^\/api\/v1\/voice\/sequences\/[^/]+\/funnel$/u.test(path)
  ) {
    return {
      body: {
        sequence_id: "44444444-4444-4444-8444-444444444444",
        steps: empty
          ? []
          : [
              {
                position: 0,
                reached: 1_284,
                opened: 812,
                clicked: 194,
                open_rate: 0.632,
                click_rate: 0.151,
                dropoff_pct: 0,
              },
              {
                position: 1,
                reached: 1_102,
                opened: 638,
                clicked: 151,
                open_rate: 0.579,
                click_rate: 0.137,
                dropoff_pct: 0.142,
              },
            ],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/replies/summary") {
    return {
      body: {
        window_days: Number(url.searchParams.get("days") ?? "30"),
        total: empty ? 0 : 482,
        matched: empty ? 0 : 436,
        unmatched: empty ? 0 : 46,
        top_campaigns: empty
          ? []
          : [{ campaign_id: CAMPAIGNS[0].id, replies: 137 }],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/replies/timeseries") {
    const days = Number(url.searchParams.get("days") ?? "30");
    return {
      body: {
        window_days: days,
        points: empty
          ? []
          : dateSeries(days, (index) => 8 + ((index * 11) % 17)).map(
              ({ date, count }) => ({ date, replies: count }),
            ),
      },
    };
  }
  if (method === "GET" && path === "/api/v1/replies/top-senders") {
    return {
      body: {
        window_days: Number(url.searchParams.get("days") ?? "30"),
        senders: empty
          ? []
          : [
              {
                recipient_email: "masked-responder@example.invalid",
                replies: 7,
                last_at: "2026-07-24T09:45:00.000Z",
              },
              {
                recipient_email: "second-responder@example.invalid",
                replies: 5,
                last_at: "2026-07-23T18:20:00.000Z",
              },
            ],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/cohorts") {
    return {
      body: empty
        ? []
        : [
            {
              cohort_label: "2026-05",
              cohort_size: 814,
              weeks: [0.49, 0.43, 0.39, 0.36, 0.33, 0.31, 0.29, 0.27],
            },
            {
              cohort_label: "2026-06",
              cohort_size: 932,
              weeks: [0.51, 0.45, 0.41, 0.37, 0.35, 0.32],
            },
            {
              cohort_label: "2026-07",
              cohort_size: 604,
              weeks: [0.54, 0.48, 0.43],
            },
          ],
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/campaigns/compare") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    return {
      body: empty
        ? []
        : ids.map((campaignId, index) => ({
            campaign_id: campaignId,
            total_recipients: 12_000 - index * 1_450,
            open_rate: 0.418 - index * 0.031,
            click_rate: 0.076 - index * 0.009,
            bounce_rate: 0.018 + index * 0.003,
            complaint_rate: 0.0006 + index * 0.0002,
            unsub_rate: 0.0019 + index * 0.0004,
          })),
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/timeseries") {
    const days = Number(url.searchParams.get("days") ?? "30");
    const groupBy = url.searchParams.get("group_by") ?? "campaign";
    return {
      body: {
        series: empty
          ? []
          : CAMPAIGNS.slice(0, 2).map((campaign, campaignOffset) => ({
              key:
                groupBy === "domain"
                  ? campaignOffset === 0
                    ? "mail.postwave.example"
                    : "news.postwave.example"
                  : campaign.id,
              label:
                groupBy === "domain"
                  ? campaignOffset === 0
                    ? "mail.postwave.example"
                    : "news.postwave.example"
                  : campaign.name,
              points: dateSeries(
                days,
                (index) => 90 + ((index * (19 + campaignOffset * 7)) % 280),
              ).map(({ date, count }) => ({ date, value: count })),
            })),
      },
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/fatigue") {
    return {
      body: {
        deciles: empty
          ? []
          : [
              {
                sends_bucket: "1–2",
                subscribers: 3_840,
                open_rate: 0.49,
                unsub_rate: 0.0008,
              },
              {
                sends_bucket: "3–5",
                subscribers: 4_902,
                open_rate: 0.42,
                unsub_rate: 0.0015,
              },
              {
                sends_bucket: "6–9",
                subscribers: 2_481,
                open_rate: 0.34,
                unsub_rate: 0.0031,
              },
              {
                sends_bucket: "10+",
                subscribers: 1_204,
                open_rate: 0.27,
                unsub_rate: 0.0058,
              },
            ],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/analytics/subscribers/funnel") {
    return {
      body: {
        bucket: "month",
        cohort_by: "created_at_month",
        steps: empty
          ? []
          : [
              {
                stage: "signup",
                label: "Signed up",
                count: 4_280,
                conversion_rate: 100,
              },
              {
                stage: "first_purchase",
                label: "First purchase",
                count: 1_621,
                conversion_rate: 37.9,
              },
              {
                stage: "repeat_purchase",
                label: "Repeat purchase",
                count: 711,
                conversion_rate: 43.9,
              },
            ],
        cohorts: empty
          ? []
          : [
              {
                cohort_label: "2026-06",
                signup_count: 1_412,
                first_purchase_count: 548,
                repeat_purchase_count: 237,
                first_purchase_rate: 38.8,
                repeat_purchase_rate: 43.2,
              },
              {
                cohort_label: "2026-05",
                signup_count: 1_297,
                first_purchase_count: 489,
                repeat_purchase_count: 221,
                first_purchase_rate: 37.7,
                repeat_purchase_rate: 45.2,
              },
            ],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/tags") {
    return {
      body: {
        items: empty
          ? []
          : [
              { id: "tag-vip", name: "VIP customers" },
              { id: "tag-growth", name: "Growth cohort" },
            ],
      },
    };
  }
  if (method === "GET" && path === "/api/v1/subscribers") {
    return {
      body: {
        items: empty
          ? []
          : [
              {
                id: "sub-1",
                email: "one@gmail.com",
                status: "enabled",
                version: '"subscriber:sub-1:v1"',
              },
              {
                id: "sub-2",
                email: "two@yahoo.com",
                status: "enabled",
                version: '"subscriber:sub-2:v1"',
              },
              {
                id: "sub-3",
                email: "three@outlook.com",
                status: "enabled",
                version: '"subscriber:sub-3:v1"',
              },
              {
                id: "sub-4",
                email: "four@icloud.com",
                status: "enabled",
                version: '"subscriber:sub-4:v1"',
              },
              {
                id: "sub-5",
                email: "five@example.net",
                status: "enabled",
                version: '"subscriber:sub-5:v1"',
              },
            ],
        total: empty ? 0 : 5,
        page: 1,
        // The UI intentionally asks for 500 rows to build the local provider
        // aggregate, while the subscriber producer clamps directory pages to
        // its verified 200-row ceiling.
        per_page: 200,
      },
    };
  }
  if (method === "GET" && path === "/api/v1/suppressions") {
    const reason = url.searchParams.get("reason");
    return {
      body: {
        items: empty
          ? []
          : reason === "complaint"
            ? [
                {
                  id: "supp-complaint-1",
                  email: "complaint@yahoo.com",
                  reason,
                  created_at: "2026-07-20T10:00:00.000Z",
                },
              ]
            : [
                {
                  id: "supp-bounce-1",
                  email: "bounce@gmail.com",
                  reason: "hard_bounce",
                  created_at: "2026-07-21T10:00:00.000Z",
                },
                {
                  id: "supp-bounce-2",
                  email: "bounce@outlook.com",
                  reason: "hard_bounce",
                  created_at: "2026-07-20T10:00:00.000Z",
                },
              ],
        total: empty ? 0 : reason === "complaint" ? 1 : 2,
      },
    };
  }
  if (method === "GET" && path === "/api/v1/predictive/profiles") {
    return { body: empty ? { items: [] } : PREDICTIVE_PROFILES };
  }
  if (method === "GET" && path === "/api/v1/predictive/catalog") {
    return {
      body: empty
        ? { ...PREDICTIVE_CATALOG, models: [], rfm_segments: [] }
        : PREDICTIVE_CATALOG,
    };
  }
  if (method === "POST" && path === "/api/v1/predictive/recompute") {
    return {
      body: {
        run: {
          id: "predictive-run-evidence",
          tenant_id: "test-tenant",
          model_key: "clv",
          model_version: "2026.07",
          status: "completed",
          input_window_days: 365,
          scored_profiles: empty ? 0 : 18_102,
          insufficient_profiles: empty ? 0 : 540,
          metrics: { coverage: empty ? 0 : 0.971 },
          started_at: "2026-07-24T10:29:00.000Z",
          completed_at: "2026-07-24T10:30:00.000Z",
          created_at: "2026-07-24T10:29:00.000Z",
        },
        predictions: empty ? 0 : 18_102,
        rfm_scores: empty ? 0 : 18_102,
      },
    };
  }
  if (
    method === "GET" &&
    path === "/api/v1/conversions/attribution/campaigns"
  ) {
    return { body: revenueAttribution(scenario) };
  }
  if (
    method === "GET" &&
    path === "/api/v1/conversions/attribution/timeseries"
  ) {
    return { body: revenueTimeseries(url, scenario) };
  }
  if (method === "GET" && path === "/api/v1/reporting/blocked-products") {
    return { body: { schema_version: "reporting.v1", items: [] } };
  }
  if (method === "GET" && path === "/api/v1/reporting/metric-registry") {
    return {
      body: {
        schema_version: "reporting.v1",
        items: [
          {
            key: "campaign.sent",
            label: "Emails sent",
            product_area: "campaigns",
            source: "campaign_report_events",
            aggregation: "sum",
            value_type: "integer",
            dimensions: ["day", "campaign"],
            runtime_status: "supported",
            help: "Distinct campaign-recipient sends.",
          },
          {
            key: "campaign.open_rate",
            label: "Unique open rate",
            product_area: "campaigns",
            source: "campaign_report_events",
            aggregation: "rate",
            value_type: "percentage",
            dimensions: ["day", "campaign"],
            runtime_status: "supported",
            help: "Unique openers divided by delivered recipients.",
          },
        ],
      },
    };
  }
  if (method === "POST" && path === "/api/v1/reporting/preview") {
    return {
      body: {
        schema_version: "reporting.v1",
        valid: true,
        rows: empty
          ? []
          : [
              { day: "2026-07-23", "campaign.sent": 12_000 },
              { day: "2026-07-22", "campaign.sent": 10_550 },
            ],
        metrics: [],
        warnings: [],
        errors: [],
      },
    };
  }
  if (method === "POST" && path === "/api/v1/reporting/definitions") {
    return {
      body: {
        id: "report-definition-evidence",
        tenant_id: "test-tenant",
        name: "Evidence report",
        description: "",
        product_area: "campaigns",
        status: "draft",
        metrics: [{ key: "campaign.sent" }],
        dimensions: ["day"],
        filters: {},
        time_range: { preset: "30d" },
        visualization: "table",
        created_at: "2026-07-24T11:00:00.000Z",
        updated_at: "2026-07-24T11:00:00.000Z",
      },
      status: 201,
    };
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/reporting\/definitions\/[^/]+\/runs$/u.test(path)
  ) {
    return {
      body: {
        id: "report-run-evidence",
        tenant_id: "test-tenant",
        definition_id: "report-definition-evidence",
        status: "completed",
        result: {
          rows: empty ? [] : [{ day: "2026-07-23", "campaign.sent": 12_000 }],
        },
        rows_total: empty ? 0 : 1,
        started_at: "2026-07-24T11:01:00.000Z",
        completed_at: "2026-07-24T11:01:01.000Z",
        created_at: "2026-07-24T11:01:00.000Z",
      },
      status: 202,
    };
  }
  if (method === "GET" && /^\/api\/v1\/reporting\/runs\/[^/]+$/u.test(path)) {
    return {
      body: {
        id: "report-run-evidence",
        tenant_id: "test-tenant",
        definition_id: "report-definition-evidence",
        status: "completed",
        result: {
          rows: empty ? [] : [{ day: "2026-07-23", "campaign.sent": 12_000 }],
        },
        rows_total: empty ? 0 : 1,
        started_at: "2026-07-24T11:01:00.000Z",
        completed_at: "2026-07-24T11:01:01.000Z",
        created_at: "2026-07-24T11:01:00.000Z",
      },
    };
  }
  if (method === "GET" && path === "/api/v1/scheduled-reports") {
    return {
      body: {
        reports: empty
          ? []
          : [
              {
                id: "55555555-5555-4555-8555-555555555555",
                name: "Monday growth pulse",
                enabled: true,
                template: "engagement_summary",
                schedule: "weekly:mon@09:00",
                timezone: "Asia/Kolkata",
                recipients: ["analytics-owner@example.invalid"],
                last_run_at: "2026-07-20T09:00:00.000Z",
                latest_run_id: "66666666-6666-4666-8666-666666666666",
                latest_run_status: "succeeded",
                latest_run_created_at: "2026-07-20T09:00:00.000Z",
                latest_run_accepted_count: 1,
                latest_run_failed_count: 0,
                latest_run_unknown_count: 0,
                latest_run_recipient_count: 1,
                next_due_at: "2026-07-27T09:00:00.000Z",
                created_at: "2026-07-01T08:00:00.000Z",
              },
              {
                id: "88888888-8888-4888-8888-888888888888",
                name: "Month-end deliverability review",
                enabled: true,
                template: "deliverability",
                schedule: "monthly:28@16:30",
                timezone: "America/New_York",
                recipients: [
                  "deliverability-owner@example.invalid",
                  "security-reviewer@example.invalid",
                  "operations-lead@example.invalid",
                ],
                last_run_at: "2026-06-28T20:30:00.000Z",
                latest_run_id: "99999999-9999-4999-8999-999999999999",
                latest_run_status: "needs_review",
                latest_run_created_at: "2026-06-28T20:30:00.000Z",
                latest_run_accepted_count: 1,
                latest_run_failed_count: 0,
                latest_run_unknown_count: 2,
                latest_run_recipient_count: 3,
                next_due_at: "2026-07-28T20:30:00.000Z",
                created_at: "2026-06-01T08:00:00.000Z",
              },
            ],
      },
    };
  }
  if (
    method === "POST" &&
    /^\/api\/v1\/scheduled-reports\/[^/]+\/send-now$/u.test(path)
  ) {
    return {
      body: {
        queued: true,
        run_id: "77777777-7777-4777-8777-777777777777",
        scheduled_report_id: "55555555-5555-4555-8555-555555555555",
        run_kind: "manual",
        status: "queued",
        occurrence_at: ANALYTICS_FIXED_NOW.toISOString(),
        created_at: ANALYTICS_FIXED_NOW.toISOString(),
      },
      status: 202,
    };
  }
  if (method === "POST" && path === "/api/v1/analytics/nlq") {
    return {
      body: {
        question: "Which campaign had the strongest click rate?",
        answer_kind: "table",
        template: "campaign_performance",
        params: { window_days: 30, limit: 10 },
        columns: ["campaign_name", "click_rate"],
        rows: [
          {
            campaign_name: CAMPAIGNS[0].name,
            click_rate: 0.076,
          },
        ],
        summary_text: "Returned 1 result row(s) for the last 30 days.",
        trace: {
          reasoning: "Used the verified campaign performance template.",
          prompt_tokens: 120,
          response_tokens: 64,
          summary_tokens: 0,
          generated_at: "2026-07-24T12:00:00.000Z",
        },
      },
    };
  }

  return resolveCampaignEndpoint(path, scenario);
}

function requestClassification(
  method: string,
  path: string,
  unexpected: boolean,
): AnalyticsLedgerEntry["classification"] {
  if (unexpected) return "unexpected";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return "read";
  }
  if (
    method === "POST" &&
    (path === "/api/v1/streams/token" || path === "/api/v1/analytics/nlq")
  ) {
    return "control";
  }
  return "write";
}

export async function installAnalyticsEvidenceApi(
  page: Page,
  { role = "admin", scenario = "populated" }: AnalyticsEvidenceOptions = {},
): Promise<AnalyticsEvidenceControl> {
  const ledger: AnalyticsLedgerEntry[] = [];
  const unexpected: AnalyticsLedgerEntry[] = [];
  const writes: AnalyticsLedgerEntry[] = [];
  const errors: AnalyticsHttpError[] = [];
  let pending = 0;
  let sequence = 0;

  await page.route("**/api/v1/**", async (route) => {
    pending += 1;
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    const reply = resolveAnalyticsRequest(url, method, scenario, role);
    const isUnexpected = reply === null;
    const resolved =
      reply ??
      errorReply(
        "unexpected_analytics_evidence_request",
        `The Analytics evidence fixture has no handler for ${method} ${url.pathname}.`,
        501,
      );
    const status = resolved.status ?? 200;
    const entry: AnalyticsLedgerEntry = {
      sequence: ++sequence,
      method,
      path: url.pathname,
      query: sanitizedQuery(url),
      status,
      classification: requestClassification(method, url.pathname, isUnexpected),
      ...(request.postData() ? { requestBody: requestBody(route) } : {}),
    };
    ledger.push(entry);
    if (entry.classification === "write") writes.push(entry);
    if (isUnexpected) unexpected.push(entry);
    if (status >= 400) {
      errors.push({ method, path: url.pathname, status });
    }
    try {
      const contentType = resolved.contentType ?? "application/json";
      await route.fulfill({
        status,
        contentType,
        body:
          contentType === "application/json"
            ? JSON.stringify(resolved.body)
            : String(resolved.body),
      });
    } finally {
      pending -= 1;
    }
  });

  return {
    errors,
    ledger,
    unexpected,
    writes,
    pendingRequests: () => pending,
  };
}

async function installDeterministicBrowser(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  try {
    await session.send("Emulation.setLocaleOverride", { locale: "en-US" });
  } catch (error) {
    // Playwright's Desktop Chrome descriptor already applies en-US. Chromium
    // rejects a second identical CDP override instead of treating it as a
    // no-op, so retain that deterministic profile and reject every other
    // protocol failure.
    if (
      !(error instanceof Error) ||
      !error.message.includes("Another locale override is already in effect")
    ) {
      throw error;
    }
  }
  await page.addInitScript(() => {
    Object.defineProperties(navigator, {
      language: { configurable: true, get: () => "en-US" },
      languages: { configurable: true, get: () => ["en-US"] },
    });
    const startupSignals: Array<{
      kind: "error" | "unhandledrejection";
      message: string;
      source?: string;
    }> = [];
    Object.defineProperty(window, "__postwaveAnalyticsStartupSignals", {
      configurable: false,
      enumerable: false,
      value: startupSignals,
      writable: false,
    });
    window.addEventListener("error", (event) => {
      startupSignals.push({
        kind: "error",
        message: event.message || "window error without a message",
        ...(event.filename ? { source: event.filename } : {}),
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      startupSignals.push({
        kind: "unhandledrejection",
        message:
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : typeof reason === "string"
              ? reason
              : "unhandled rejection without a serializable reason",
      });
    });
  });
}

export async function openAnalyticsEvidence({
  bootApp,
  page,
  setTheme,
  theme = "dark",
  ...evidenceOptions
}: OpenAnalyticsEvidenceOptions): Promise<AnalyticsEvidenceControl> {
  const pendingStartupResources = new Set<string>();
  const failedStartupResources: Array<{
    error: string;
    type: string;
    url: string;
  }> = [];
  const startupPageErrors: string[] = [];
  page.on("request", (request) => {
    if (
      request.resourceType() === "document" ||
      request.resourceType() === "script"
    ) {
      pendingStartupResources.add(request.url());
    }
  });
  page.on("requestfinished", (request) => {
    pendingStartupResources.delete(request.url());
  });
  page.on("requestfailed", (request) => {
    pendingStartupResources.delete(request.url());
    failedStartupResources.push({
      error: request.failure()?.errorText ?? "unknown request failure",
      type: request.resourceType(),
      url: request.url(),
    });
  });
  page.on("pageerror", (error) => startupPageErrors.push(error.message));

  await installDeterministicBrowser(page);
  await setTheme(page, theme);
  await bootApp(page);
  const control = await installAnalyticsEvidenceApi(page, evidenceOptions);
  await page.goto("/app/analytics");
  try {
    await waitForPrimaryNavigation(page);
    await expect(
      page.getByRole("heading", { name: "Analytics", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const captureBrowserState = () =>
      page.evaluate(() => {
        const mainText =
          document.querySelector<HTMLElement>("#main-content")?.innerText ?? "";
        return {
          analyticsHeadingVisible: [...document.querySelectorAll("h1")].some(
            (heading) =>
              heading.textContent?.trim() === "Analytics" &&
              heading.getBoundingClientRect().width > 0,
          ),
          busyRegions: [
            ...document.querySelectorAll<HTMLElement>('[aria-busy="true"]'),
          ]
            .map((element) => element.innerText.trim())
            .filter(Boolean),
          mainText: mainText.slice(0, 1_000),
          mainTextLength: mainText.length,
          primaryNavigationLoaded: Boolean(
            document.querySelector(
              'nav[aria-label="Primary"] button[data-section="dashboard"]',
            ),
          ),
          resources: performance
            .getEntriesByType("resource")
            .slice(-50)
            .map((entry) => ({
              duration: Math.round(entry.duration),
              name: entry.name,
            })),
          startupSignals:
            (
              window as Window & {
                __postwaveAnalyticsStartupSignals?: Array<{
                  kind: string;
                  message: string;
                  source?: string;
                }>;
              }
            ).__postwaveAnalyticsStartupSignals ?? [],
        };
      });
    const initialBrowserState = await captureBrowserState();
    const wakeStages: Array<{
      action: string;
      state: Awaited<ReturnType<typeof captureBrowserState>>;
    }> = [{ action: "initial", state: initialBrowserState }];
    const viewport = page.viewportSize();
    if (viewport) {
      await page.setViewportSize({
        width: viewport.width + 1,
        height: viewport.height,
      });
      await page.setViewportSize(viewport);
    } else {
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    }
    await page.waitForTimeout(350);
    let latestWakeState = await captureBrowserState();
    wakeStages.push({ action: "viewport-resize", state: latestWakeState });
    const collapse = page.locator(".sidebar-collapse");
    if (
      !latestWakeState.analyticsHeadingVisible &&
      (await collapse.count()) > 0
    ) {
      await collapse.click({ timeout: 1_000 }).catch(() => undefined);
      await page.waitForTimeout(350);
      latestWakeState = await captureBrowserState();
      wakeStages.push({ action: "sidebar-collapse", state: latestWakeState });
    }
    const dashboard = page.locator(
      'nav[aria-label="Primary"] button[data-section="dashboard"]',
    );
    const analytics = page.locator(
      'nav[aria-label="Primary"] button[data-section="analytics"]',
    );
    if ((await dashboard.count()) > 0 && (await analytics.count()) > 0) {
      if (!latestWakeState.analyticsHeadingVisible) {
        await dashboard.click({ timeout: 1_000 }).catch(() => undefined);
        await analytics.click({ timeout: 1_000 }).catch(() => undefined);
        await page.waitForTimeout(350);
        latestWakeState = await captureBrowserState();
        wakeStages.push({
          action: "dashboard-analytics-route-cycle",
          state: latestWakeState,
        });
      }
    }
    const moduleProbes = await page.evaluate(async () => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) =>
          /\/assets\/(?:DesktopDestinationGate|Analytics)-[^/]+\.js$/u.test(
            url,
          ),
        );
      return Promise.all(
        [...new Set(urls)].map(async (url) => {
          const result = await Promise.race([
            import(/* @vite-ignore */ url).then(
              (
                module,
              ): {
                exports: string[];
                status: "resolved";
              } => ({
                exports: Object.keys(module).sort(),
                status: "resolved",
              }),
              (
                moduleError,
              ): {
                message: string;
                status: "rejected";
              } => ({
                message:
                  moduleError instanceof Error
                    ? `${moduleError.name}: ${moduleError.message}`
                    : "module import rejected without a serializable reason",
                status: "rejected",
              }),
            ),
            new Promise<{
              status: "timeout";
            }>((resolve) =>
              setTimeout(() => resolve({ status: "timeout" }), 2_000),
            ),
          ]);
          return { result, url };
        }),
      );
    });
    await page.waitForTimeout(750);
    const afterModuleProbeState = await captureBrowserState();
    throw new Error(
      `Analytics destination did not become ready: ${JSON.stringify({
        browserState: {
          afterModuleProbe: afterModuleProbeState,
          moduleProbes,
          wakeStages,
        },
        failedStartupResources,
        original:
          error instanceof Error ? error.message : "unknown readiness failure",
        pendingStartupResources: [...pendingStartupResources],
        startupPageErrors,
      })}`,
    );
  }
  // The shell's persisted capability/router boot state uses wall-clock
  // timestamps while its lazy destination boundary resolves. Freeze Date
  // only after that boundary is ready, then refresh Analytics so every
  // accepted-at value and all subsequent interactions use the fixed instant.
  await page.clock.setFixedTime(ANALYTICS_FIXED_NOW);
  await page
    .getByRole("button", {
      name: "Refresh analytics snapshot",
      exact: true,
    })
    .click();
  await settleAnalytics(page, control);
  return control;
}

export async function settleAnalytics(
  page: Page,
  control: AnalyticsEvidenceControl,
): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await expect
      .poll(control.pendingRequests, {
        message: "Analytics evidence requests should settle",
        timeout: 20_000,
      })
      .toBe(0);
    await page.evaluate(async () => document.fonts.ready);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }
}

export async function expectNoAnalyticsOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const containedByScroller = (
      element: HTMLElement,
      boundary: HTMLElement | null,
    ): boolean => {
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== boundary?.parentElement) {
        const style = getComputedStyle(ancestor);
        if (/auto|scroll|hidden|clip/u.test(style.overflowX)) return true;
        if (ancestor === boundary) break;
        ancestor = ancestor.parentElement;
      }
      return false;
    };
    const offenders = content
      ? Array.from(content.querySelectorAll<HTMLElement>("*"))
          .filter((element) => {
            if (element instanceof SVGElement) return false;
            const style = getComputedStyle(element);
            if (style.position === "fixed" || style.display === "none") {
              return false;
            }
            if (element.scrollWidth - element.clientWidth <= 2) return false;
            if (/auto|scroll|hidden|clip/u.test(style.overflowX)) return false;
            return !containedByScroller(element, content);
          })
          .slice(0, 12)
          .map((element) => {
            const classes =
              typeof element.className === "string"
                ? `.${element.className.trim().replaceAll(/\s+/gu, ".")}`
                : "";
            return `${element.tagName.toLowerCase()}${classes}:${element.scrollWidth}-${element.clientWidth}`;
          })
      : [];
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      offenders,
    };
  });
  expect(overflow.document, "Analytics document overflow").toBeLessThanOrEqual(
    1,
  );
  expect(overflow.body, "Analytics body overflow").toBeLessThanOrEqual(1);
  expect(
    overflow.content,
    `Analytics content overflow; offenders: ${overflow.offenders.join("; ")}`,
  ).toBeLessThanOrEqual(1);
  expect(overflow.offenders).toEqual([]);
}

export async function expectAnalyticsViewportContained(
  locator: Locator,
  page: Page,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

export async function expectNoInvalidAnalyticsText(page: Page): Promise<void> {
  const invalid = await page.evaluate(() => {
    const text = document.body.innerText;
    const badText =
      text.match(/(?:^|\s)(?:NaN|Infinity|-Infinity)(?=\s|$|%|,|\.)/gu) ?? [];
    const badAttributes = Array.from(
      document.querySelectorAll<HTMLElement>("*"),
    )
      .flatMap((element) =>
        Array.from(element.attributes).map((attribute) => ({
          element: element.tagName.toLowerCase(),
          name: attribute.name,
          value: attribute.value,
        })),
      )
      .filter(({ value }) => /(?:NaN|Infinity)/u.test(value))
      .slice(0, 12);
    return { badAttributes, badText };
  });
  expect(invalid.badText).toEqual([]);
  expect(invalid.badAttributes).toEqual([]);
}

export async function seriousAnalyticsAxeViolations(
  page: Page,
  { forcedColors = false }: { forcedColors?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ forcedColors }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              root: Document,
              options: {
                runOnly: { type: "tag"; values: string[] };
                rules?: Record<string, { enabled: boolean }>;
              },
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{ target: string[]; failureSummary?: string }>;
              }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
        ...(forcedColors
          ? { rules: { "color-contrast": { enabled: false } } }
          : {}),
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        )
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failure: node.failureSummary,
          })),
        }));
    },
    { forcedColors },
  );
}

export function observeAnalyticsRenderer(page: Page): {
  expectClean: (control: AnalyticsEvidenceControl) => void;
} {
  const consoleErrors: Array<{ text: string; url: string }> = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    consoleErrors.push({
      text: message.text(),
      url: message.location().url,
    });
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: (control) => {
      const expectedErrorPaths = new Set(
        control.errors.map((error) => error.path),
      );
      const unexpectedConsoleErrors = consoleErrors.filter(({ text, url }) => {
        if (!text.startsWith("Failed to load resource:")) return true;
        try {
          return !expectedErrorPaths.has(new URL(url).pathname);
        } catch {
          return true;
        }
      });
      expect(unexpectedConsoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

export async function saveAnalyticsEvidenceSegments(
  page: Page,
  testInfo: TestInfo,
  name: string,
  { maxSegments = 3 }: { maxSegments?: number } = {},
): Promise<void> {
  const safeName = name.replaceAll(/[^a-z0-9-]+/giu, "-").toLowerCase();
  const scroller = page.locator(".content");
  const metrics = await scroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop,
  }));
  const segmentHeight = Math.max(1, metrics.clientHeight);
  const maximumTop = Math.max(0, metrics.scrollHeight - segmentHeight);
  const wanted = Math.max(
    1,
    Math.min(maxSegments, Math.ceil(metrics.scrollHeight / segmentHeight)),
  );
  const offsets = Array.from({ length: wanted }, (_, index) =>
    wanted === 1 ? 0 : Math.round((maximumTop * index) / (wanted - 1)),
  );
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index] ?? 0;
    await scroller.evaluate((element, top) => {
      element.scrollTop = top;
    }, offset);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await page.screenshot({
      path: testInfo.outputPath(
        `${safeName}-segment-${String(index + 1).padStart(2, "0")}.png`,
      ),
      fullPage: false,
    });
  }
  await scroller.evaluate((element, top) => {
    element.scrollTop = top;
  }, metrics.scrollTop);
}

export async function attachAnalyticsLedger(
  control: AnalyticsEvidenceControl,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  const safeLedger = control.ledger.map((entry) => sanitizeUnknown(entry));
  const body = Buffer.from(
    `${JSON.stringify(
      {
        fixed_now: ANALYTICS_FIXED_NOW.toISOString(),
        locale: "en-US",
        timezone: "UTC",
        entries: safeLedger,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const evidencePath = testInfo.outputPath(
    `${name.replaceAll(/[^a-z0-9-]+/giu, "-").toLowerCase()}-analytics-request-ledger.json`,
  );
  writeFileSync(evidencePath, body);
  await testInfo.attach(`${name}-analytics-request-ledger`, {
    path: evidencePath,
    contentType: "application/json",
  });
}
