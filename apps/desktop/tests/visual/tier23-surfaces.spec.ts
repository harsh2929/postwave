/**
 * Tier 2/3 surfaces — realistic happy-path render test.
 *
 * The generic populated-sweep returns one blob for every endpoint, so it
 * exercises the new surfaces' EMPTY/fallback path (and already caught a
 * PlanSummaryCard crash there). This spec instead stubs each new endpoint
 * with its REAL shape so the POPULATED path renders, and asserts both
 * "no crash" and that the honest-UI markers actually appear:
 *
 *   · PlanSummaryCard      — usage bars + an "Estimate"-labelled projection
 *   · Server-driven Subscribers — rows from the server response
 *   · Agent routine trust  — reasoning + draft snapshot in the runs drilldown
 *   · Approvals trust       — the same panel beside the decision
 *
 *   pnpm exec playwright test tier23-surfaces.spec.ts --reporter=line
 */
import { test, expect, waitForPrimaryNavigation } from "./fixture";
import type { Page } from "@playwright/test";

interface Finding {
  area: string;
  kind: string;
  detail: string;
}
const findings: Finding[] = [];
const NOISE = [
  "unstubbed Tauri command",
  "Failed to load resource",
  "favicon",
  "Download the React DevTools",
  "MIME type",
];
const isNoise = (s: string): boolean => NOISE.some((n) => s.includes(n));

function watch(page: Page, area: string): void {
  page.on("pageerror", (e) =>
    findings.push({
      area,
      kind: "pageerror",
      detail: `${e.name}: ${e.message}`.slice(0, 300),
    }),
  );
  page.on("console", (m) => {
    const t = m.text();
    if (
      m.type() === "error" &&
      !isNoise(t) &&
      /TypeError|Cannot read|is not a function|NaN/.test(t)
    )
      findings.push({ area, kind: "console", detail: t.slice(0, 300) });
  });
}

const ISO = "2026-06-10T12:00:00.000Z";

const PLAN_SUMMARY = {
  tier: "pro",
  current_period_end: "2026-07-01T00:00:00Z",
  resources: [
    {
      resource: "monthly_sends",
      current: 46000,
      limit: 50000,
      percent: 92,
      exceeded: false,
    },
    {
      resource: "contacts",
      current: 8200,
      limit: 100000,
      percent: 8,
      exceeded: false,
    },
    {
      resource: "campaigns",
      current: 12,
      limit: 2000,
      percent: 1,
      exceeded: false,
    },
  ],
  // on track to exceed — exercises the warning + estimate label
  sends_projection: {
    current: 46000,
    limit: 50000,
    as_of: ISO,
    period_start: "2026-06-01T00:00:00Z",
    period_end: "2026-06-30T23:59:59Z",
    avg_per_day: 4600,
    days_elapsed: 10,
    days_in_period: 30,
    projected_end_of_period: 138000,
    projected_exceed_date: "2026-06-11",
    on_track_to_exceed: true,
  },
};

const SUBSCRIBERS = {
  items: [
    {
      id: "1",
      email: "ada@example.com",
      status: "enabled",
      created_at: ISO,
      updated_at: ISO,
    },
    {
      id: "2",
      email: "grace@example.com",
      status: "enabled",
      created_at: ISO,
      updated_at: ISO,
    },
    {
      id: "3",
      email: "alan@example.com",
      status: "disabled",
      created_at: ISO,
      updated_at: ISO,
    },
  ],
  total: 12345,
  page: 1,
  per_page: 50,
};

const ROUTINES = {
  items: [
    {
      id: "rt-1",
      name: "Weekly re-engagement",
      prompt: "Draft a re-engagement campaign for lapsed subscribers",
      kind: "draft_campaign",
      schedule: "weekly",
      require_approval: true,
      enabled: true,
      last_run_at: ISO,
      created_at: ISO,
      updated_at: ISO,
    },
  ],
};

const ROUTINE_RUNS = {
  items: [
    {
      id: "run-1",
      routine_id: "rt-1",
      status: "succeeded",
      output_kind: "campaign",
      output_ref: "camp-1",
      approval_id: "appr-1",
      prompt_used: "Draft a re-engagement campaign for lapsed subscribers",
      context_used: "Target audience: tenant segment seg-9",
      reasoning:
        "Lapsed openers respond best to a low-pressure, value-led nudge rather than a discount, so the angle leads with the most-read recent content.",
      draft_preview: {
        kind: "campaign",
        name: "We miss you",
        subject: "Here's what you've missed",
        preview_text: "A quick note for you",
        body: "<p>It's been a while — here are the three pieces our readers loved most this month.</p>",
      },
      started_at: ISO,
      finished_at: ISO,
    },
  ],
};

async function stub(page: Page, map: Record<string, unknown>): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    // exact match, then prefix match (so /agent-routines/{id}/runs resolves)
    let body: unknown = map[p];
    if (body === undefined) {
      for (const key of Object.keys(map)) {
        if (key.endsWith("*") && p.startsWith(key.slice(0, -1))) {
          body = map[key];
          break;
        }
      }
    }
    if (body === undefined) body = {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function goSection(page: Page, sectionId: string): Promise<void> {
  const it = page
    .getByRole("navigation", { name: "Primary" })
    .locator(`button[data-section="${sectionId}"]`);
  await expect(
    it,
    `Missing desktop navigation item: ${sectionId}`,
  ).toBeVisible();
  await it.click({ timeout: 8000 });
  await expect(it).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(700);
}

const AUTH_ME = {
  user_id: "tier23-user",
  tenant_id: "test-tenant",
  email: "t@p.email",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
};

function assertNoCrash(area: string, _page: Page): void {
  expect(
    findings.filter((f) => f.area === area),
    `${area} produced render errors: ${JSON.stringify(findings.filter((f) => f.area === area))}`,
  ).toEqual([]);
}

test("plan summary card renders projection as an estimate", async ({
  page,
  bootApp,
}) => {
  watch(page, "plan");
  await bootApp(page);
  await stub(page, {
    "/api/v1/billing/plan-summary": PLAN_SUMMARY,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "settings");
  await page.waitForTimeout(900);
  // honest-UI markers
  await expect(page.getByText("Monthly sends").first()).toBeVisible({
    timeout: 6000,
  });
  await expect(page.getByText("Estimate").first()).toBeVisible();
  assertNoCrash("plan", page);
});

test("server-driven subscribers renders rows from the response", async ({
  page,
  bootApp,
}) => {
  watch(page, "subs");
  await bootApp(page);
  await stub(page, {
    "/api/v1/subscribers": SUBSCRIBERS,
    "/api/v1/subscribers/search": SUBSCRIBERS,
    "/api/v1/auth/me": AUTH_ME,
    "/api/v1/dashboard/stats": {
      total_subscribers: 12345,
      active_campaigns: 3,
      recent_audit: [],
    },
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "subscribers");
  await page.waitForTimeout(900);
  await expect(page.getByText("ada@example.com").first()).toBeVisible({
    timeout: 6000,
  });
  assertNoCrash("subs", page);
});

test("agent routine trust panel shows reasoning + draft snapshot", async ({
  page,
  bootApp,
}) => {
  watch(page, "routines");
  await bootApp(page);
  await stub(page, {
    "/api/v1/agent-routines": ROUTINES,
    "/api/v1/agent-routines/rt-1/runs": ROUTINE_RUNS,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "ai");
  await page.waitForTimeout(900);
  const routinesTab = page.getByRole("tab", { name: /^Routines$/ }).first();
  await expect(routinesTab).toBeVisible({ timeout: 6_000 });
  await routinesTab.click();
  await page.waitForTimeout(500);
  // Expand the runs drilldown, then open the trust panel.
  const runsBtn = page.getByRole("button", { name: /^Runs$/ }).first();
  await expect(runsBtn).toBeVisible({ timeout: 6_000 });
  await runsBtn.click();
  await page.waitForTimeout(500);
  const whyBtn = page.getByRole("button", { name: /Why & preview/ }).first();
  await expect(whyBtn).toBeVisible({ timeout: 4_000 });
  await whyBtn.click();
  await expect(page.getByText(/low-pressure, value-led/).first()).toBeVisible({
    timeout: 4000,
  });
  await expect(page.getByText("What it produced").first()).toBeVisible();
  assertNoCrash("routines", page);
});

const PREDICTIVE_PROFILES = {
  items: [
    {
      email: "whale@example.com",
      historic_clv_cents: 120000,
      predicted_clv_cents: 90000,
      total_clv_cents: 210000,
      churn_risk: 0.15,
      predicted_order_count: 8,
      average_days_between_orders: 30,
      expected_next_order_at: ISO,
      predicted_gender: "unknown",
      confidence: 0.82,
      data_sufficiency: "ok",
      calculated_at: ISO,
    },
    {
      email: "atrisk@example.com",
      historic_clv_cents: 40000,
      predicted_clv_cents: 5000,
      total_clv_cents: 45000,
      churn_risk: 0.91,
      predicted_order_count: 1,
      average_days_between_orders: 120,
      expected_next_order_at: null,
      predicted_gender: "unknown",
      confidence: 0.3,
      data_sufficiency: "low",
      calculated_at: ISO,
    },
  ],
};
const PREDICTIVE_RFM = {
  items: [
    {
      email: "whale@example.com",
      recency_days: 5,
      frequency: 12,
      monetary_cents: 120000,
      recency_score: 5,
      frequency_score: 5,
      monetary_score: 5,
      rfm_score: "555",
      segment_key: "champions",
      calculated_at: ISO,
    },
  ],
};
const PREDICTIVE_CATALOG = {
  schema_version: "1",
  models: [{ key: "clv", label: "CLV", runtime_status: "ready", version: "1" }],
  rfm_segments: [{ key: "champions", label: "Champions" }],
};

test("predictive analytics surface renders CLV + confidence labels", async ({
  page,
  bootApp,
}) => {
  watch(page, "predictive");
  await bootApp(page);
  await stub(page, {
    "/api/v1/predictive/catalog": PREDICTIVE_CATALOG,
    "/api/v1/predictive/profiles": PREDICTIVE_PROFILES,
    "/api/v1/predictive/profiles*": PREDICTIVE_PROFILES,
    "/api/v1/predictive/rfm/segments": PREDICTIVE_RFM,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "analytics");
  await page.waitForTimeout(1100);
  // The predictive surface should show an Estimate marker and a profile.
  await expect(page.getByText("whale@example.com").first()).toBeVisible({
    timeout: 6000,
  });
  await expect(page.getByText("Estimate").first()).toBeVisible();
  assertNoCrash("predictive", page);
});

const FORMS_LIST = {
  items: [
    {
      id: "f1",
      name: "Welcome popup",
      slug: "welcome",
      status: "published",
      created_at: ISO,
      updated_at: ISO,
    },
  ],
};
const OG_CATALOG = {
  schema_version: "1",
  trigger_types: [
    { key: "delay", label: "After delay", runtime_status: "ready" },
  ],
  targeting_groups: [{ key: "url", label: "URL", runtime_status: "ready" }],
  frequency_modes: [
    { key: "once", label: "Once per visitor", runtime_status: "ready" },
  ],
  experiment_modes: [
    { key: "fixed", label: "Fixed split", runtime_status: "ready" },
  ],
  winner_metrics: [
    { key: "submit_rate", label: "Submit rate", runtime_status: "ready" },
  ],
  spin_reward_types: [
    { key: "coupon", label: "Coupon", runtime_status: "ready" },
  ],
  experiment_events: ["impression", "submit"],
};

test("forms growth panel: structured A/B variant editor", async ({
  page,
  bootApp,
}) => {
  watch(page, "growth");
  await bootApp(page);
  await stub(page, {
    "/api/v1/forms": FORMS_LIST,
    "/api/v1/onsite-growth/catalog": OG_CATALOG,
    "/api/v1/onsite-growth/forms/f1/experiments": { items: [] },
    "/api/v1/onsite-growth/forms/f1/targeting": {},
    "/api/v1/onsite-growth/forms/f1/spin/rewards": { items: [] },
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "forms");
  await page.waitForTimeout(900);
  // Open the Growth panel for the first form.
  const growthBtn = page.getByRole("button", { name: /^Growth$/ }).first();
  await expect(growthBtn).toBeVisible({ timeout: 6_000 });
  await growthBtn.click();
  await page.waitForTimeout(500);
  // Switch to the Experiments tab, start a new experiment, add a variant.
  const expTab = page.getByRole("tab", { name: /experiments/i }).first();
  await expect(expTab).toBeVisible({ timeout: 4_000 });
  await expTab.click();
  const newExp = page.getByRole("button", { name: /New experiment/i }).first();
  await expect(newExp).toBeVisible({ timeout: 4_000 });
  await newExp.click();
  const addVariant = page.getByRole("button", { name: /Add variant/i }).first();
  await expect(addVariant).toBeVisible({ timeout: 4_000 });
  await addVariant.click();
  // The structured editor (not a JSON textarea) shows a weight total.
  await expect(page.getByText(/Total traffic/i).first()).toBeVisible({
    timeout: 4000,
  });
  assertNoCrash("growth", page);
});

const BLOCKED_PRODUCTS = {
  schema_version: "klv12.reporting.v1",
  items: [
    {
      product_area: "deliverability",
      initiative: "KLV-14-deliverability-routing-and-entitlements",
      blocked_note:
        "Provider / domain / country / client breakdowns require deliverability routing reporting.",
      metrics: ["deliverability.provider_rate", "deliverability.domain_rate"],
      statuses: ["planned", "planned"],
    },
    {
      product_area: "flow",
      initiative: "KLV-03-flow-builder-and-runtime-parity",
      blocked_note:
        "Flow execution metrics require the flow runtime analytics pipeline.",
      metrics: ["flow.conversion"],
      statuses: ["partial"],
    },
  ],
};

test("analytics blocked-products banner surfaces the gating initiative", async ({
  page,
  bootApp,
}) => {
  watch(page, "blocked");
  await bootApp(page);
  await stub(page, {
    "/api/v1/reporting/blocked-products": BLOCKED_PRODUCTS,
    "/api/v1/auth/me": AUTH_ME,
    "/api/v1/dashboard/stats": {
      total_subscribers: 100,
      active_campaigns: 1,
      recent_audit: [],
    },
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "analytics");
  await page.waitForTimeout(1000);
  await expect(
    page.getByText(/waiting on upcoming features/i).first(),
  ).toBeVisible({ timeout: 6000 });
  await expect(page.getByText("KLV-14").first()).toBeVisible();
  assertNoCrash("blocked", page);
});

const METRIC_REGISTRY = {
  schema_version: "klv12.reporting.v1",
  items: [
    {
      key: "campaign.sent",
      label: "Campaign sends",
      product_area: "campaign",
      source: "campaign_report_events",
      aggregation: "count",
      value_type: "count",
      dimensions: ["day"],
      runtime_status: "supported",
      help: "Emails sent",
    },
    {
      key: "deliverability.provider_rate",
      label: "Provider delivery rate",
      product_area: "deliverability",
      source: "n/a",
      aggregation: "ratio",
      value_type: "rate",
      dimensions: ["day"],
      runtime_status: "planned",
      help: "Needs deliverability routing",
    },
  ],
};
const REPORT_PREVIEW = {
  schema_version: "klv12.reporting.v1",
  valid: true,
  rows: [
    { day: "2026-06-09", "campaign.sent": 42 },
    { day: "2026-06-10", "campaign.sent": 57 },
  ],
  metrics: [METRIC_REGISTRY.items[0]],
  warnings: [],
};

test("report builder: pick metric → preview renders rows", async ({
  page,
  bootApp,
}) => {
  watch(page, "reportbuilder");
  await bootApp(page);
  await stub(page, {
    "/api/v1/reporting/metric-registry": METRIC_REGISTRY,
    "/api/v1/reporting/preview": REPORT_PREVIEW,
    "/api/v1/reporting/blocked-products": { schema_version: "v1", items: [] },
    "/api/v1/reporting/definitions": { items: [] },
    "/api/v1/auth/me": AUTH_ME,
    "/api/v1/dashboard/stats": {
      total_subscribers: 100,
      active_campaigns: 1,
      recent_audit: [],
    },
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "analytics");
  await page.waitForTimeout(800);
  // Expand the collapsible Report builder section.
  const header = page.getByRole("button", { name: /Report builder/i }).first();
  await expect(header).toBeVisible({ timeout: 6_000 });
  await header.click();
  // Pick the supported metric.
  const metric = page.getByText("Campaign sends").first();
  await expect(metric).toBeVisible({ timeout: 4_000 });
  await metric.click();
  const previewBtn = page.getByRole("button", { name: /Run preview/i }).first();
  await expect(previewBtn).toBeVisible({ timeout: 4_000 });
  await previewBtn.click();
  // A preview row value should render in the table.
  await expect(page.getByText("57").first()).toBeVisible({ timeout: 4000 });
  assertNoCrash("reportbuilder", page);
});

const SEGMENTS_LIST = [
  {
    id: "seg-1",
    name: "VIP buyers",
    description: "High-value repeat customers",
    queryAst: { and: [] },
    lastCount: 1200,
    createdAt: ISO,
    updatedAt: ISO,
  },
];
const SEG_SNAPSHOTS = {
  items: [
    {
      id: "snap-1",
      tenant_id: "t",
      segment_id: "seg-1",
      count: 1200,
      sample_size: 500,
      evaluator_version: "v1",
      evaluated_at: ISO,
      created_at: ISO,
    },
  ],
};
const SNAP_MEMBERS = {
  items: [
    { email: "vip1@example.com", subscriber_id: "1" },
    { email: "vip2@example.com", subscriber_id: "2" },
  ],
  page: 1,
  per_page: 50,
  total: 1200,
  sample_size: 500,
  sample_is_complete: false,
};

test("segment snapshots: list + honest sample note", async ({
  page,
  bootApp,
}) => {
  watch(page, "snapshots");
  await bootApp(page);
  await stub(page, {
    "/api/v1/segments": SEGMENTS_LIST,
    "/api/v1/segments/seg-1/snapshots": SEG_SNAPSHOTS,
    "/api/v1/segments/snapshots/snap-1/members": SNAP_MEMBERS,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "segments");
  await page.waitForTimeout(800);
  // Open the segment's detail slideover.
  const row = page
    .locator(".list-row")
    .filter({ hasText: "VIP buyers" })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Open" }).click();
  await expect(
    page.getByRole("heading", { name: "Evaluation snapshots", exact: true }),
  ).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByRole("button", { name: "Record snapshot", exact: true }),
  ).toBeVisible();
  // The record names the bounded cache and discloses its evaluated scope.
  await expect(
    page.getByText(
      /500 of 1,200 evaluated members were cached for inspection/i,
    ),
  ).toBeVisible();
  const viewBtn = page.getByRole("button", {
    name: "View cached members",
    exact: true,
  });
  await expect(viewBtn).toBeVisible();
  await viewBtn.click();
  await expect(
    page.getByText(
      /exposes 500 cached members from 1,200 matches at evaluation time/i,
    ),
  ).toBeVisible({ timeout: 4000 });
  assertNoCrash("snapshots", page);
});

const PREDICATE_REGISTRY = {
  registry_version: "klv06.registry.v1",
  boolean_ops: ["and", "or", "not"],
  predicates: [
    {
      key: "email",
      label: "Email",
      category: "profile",
      value_type: "string",
      comparators: ["equals", "contains"],
      source: "subscribers",
      activation: ["segment"],
      compiler_status: "supported",
      help: "The subscriber email",
    },
    {
      key: "metric.track.purchase.count",
      label: "Purchase count",
      category: "metrics",
      value_type: "number",
      comparators: ["gte", "lte"],
      source: "events",
      activation: ["segment"],
      compiler_status: "planned",
      help: "Number of purchases",
    },
  ],
  metrics: [
    {
      key: "purchase",
      label: "Purchase",
      source: "events",
      aggregation: "count",
      value_type: "number",
      total: 4200,
    },
  ],
  custom_objects: [
    {
      id: "co1",
      key: "orders",
      label: "Orders",
      primary_key: "order_id",
      status: "active",
      updated_at: ISO,
    },
  ],
  warnings: [],
};

test("predicate-registry catalog exposes only compiler-supported fields", async ({
  page,
  bootApp,
}) => {
  watch(page, "catalog");
  await bootApp(page);
  await stub(page, {
    "/api/v1/segments": [],
    "/api/v1/segments/predicate-registry": PREDICATE_REGISTRY,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "segments");
  await page.waitForTimeout(700);
  const newBtn = page.getByRole("button", { name: /^New segment$/i }).first();
  await expect(newBtn).toBeVisible({ timeout: 6_000 });
  await newBtn.click();
  const catalog = page
    .getByRole("button", { name: /What can I segment on/i })
    .first();
  await expect(catalog).toBeVisible({ timeout: 4_000 });
  await catalog.click();
  await expect(page.getByText("Email").first()).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByText("Purchase", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Orders", { exact: true }).first()).toBeVisible();
  // Fail closed: a catalog entry that the segment compiler cannot evaluate
  // must not be advertised as selectable or merely softened with a badge.
  await expect(page.getByText("Purchase count", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  assertNoCrash("catalog", page);
});

const REVIEWS_CATALOG = {
  statuses: ["pending", "approved", "rejected", "spam", "archived"],
  widget_types: [
    "star_rating",
    "summary",
    "product_reviews",
    "featured_carousel",
  ],
  review_types: ["product", "store"],
};
const REVIEWS_LIST = {
  items: [
    {
      id: "rev-1",
      product_id: "p1",
      rating: 5,
      title: "Fantastic product",
      body: "Exceeded my expectations, would buy again.",
      status: "pending",
      verified_buyer: true,
      incentivized: false,
      featured: false,
      reviewer_name: "Ada L.",
      created_at: ISO,
      public_replies: [],
    },
    {
      id: "rev-2",
      product_id: "p1",
      rating: 2,
      title: "Not for me",
      body: "Arrived late and smaller than pictured.",
      status: "pending",
      verified_buyer: false,
      incentivized: true,
      featured: false,
      reviewer_name: "Grace H.",
      created_at: ISO,
      public_replies: [],
    },
  ],
};
const REVIEWS_WIDGETS = {
  items: [
    {
      id: "w1",
      slug: "homepage-stars",
      name: "Homepage stars",
      status: "active",
      widget_type: "star_rating",
      public_url: "https://pub.example/reviews/homepage-stars",
    },
  ],
};

test("reviews moderation surface renders reviews + badges", async ({
  page,
  bootApp,
}) => {
  watch(page, "reviews");
  await bootApp(page);
  await stub(page, {
    "/api/v1/reviews/catalog": REVIEWS_CATALOG,
    "/api/v1/reviews": REVIEWS_LIST,
    "/api/v1/reviews/widgets": REVIEWS_WIDGETS,
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "reviews");
  await page.waitForTimeout(900);
  await expect(page.getByText("Fantastic product").first()).toBeVisible({
    timeout: 6000,
  });
  await expect(page.getByText("Ada L.").first()).toBeVisible();
  // The verified-buyer badge renders honestly.
  await expect(page.getByText(/Verified buyer/i).first()).toBeVisible();
  assertNoCrash("reviews", page);
});

// Helpdesk deliberately lives in helpdesk-99p9.spec.ts. That suite imports
// the canonical seven-key v2 catalog and covers the held Agent surface; this
// broad tier sweep must not preserve or normalize a legacy v1 wire fixture.

test("visual segment builder build mode renders", async ({ page, bootApp }) => {
  watch(page, "segbuilder");
  await bootApp(page);
  await stub(page, {
    "/api/v1/segments": [],
    "/api/v1/segments/predicate-registry": PREDICATE_REGISTRY,
    "/api/v1/segments/preview-count": {
      count: 42,
      computed_in_ms: 5,
      capped: false,
    },
    "/api/v1/auth/me": AUTH_ME,
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await goSection(page, "segments");
  await page.waitForTimeout(700);
  const newBtn = page.getByRole("button", { name: /^New segment$/i }).first();
  await expect(newBtn).toBeVisible({ timeout: 6_000 });
  await newBtn.click();
  const buildTab = page.getByRole("radio", {
    name: "Build",
    exact: true,
  });
  await expect(buildTab).toBeVisible({ timeout: 4_000 });
  await buildTab.click();
  await expect(buildTab).toBeChecked();
  // The visual builder offers an add-condition affordance.
  await expect(
    page.getByRole("button", { name: "Add condition", exact: true }),
  ).toBeVisible({ timeout: 4000 });
  assertNoCrash("segbuilder", page);
});

test.afterAll(async () => {
  if (findings.length) {
    // eslint-disable-next-line no-console
    console.log("tier23 findings:", JSON.stringify(findings, null, 2));
  }
});
