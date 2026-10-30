import type { ConsoleMessage, Locator, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const FIXED_NOW = new Date("2026-07-18T08:00:00.000Z");
const ISO = "2026-07-17T12:00:00.000Z";
const DEDUPE_SCAN_ID = "11111111-1111-4111-8111-111111111111";
const EMPTY_DEDUPE_SCAN = {
  scan_id: DEDUPE_SCAN_ID,
  status: "complete",
  subscriber_count: 12_840,
  candidate_count: 0,
  created_at: "2026-07-18T08:00:00.000Z",
  completed_at: "2026-07-18T08:00:01.000Z",
  expires_at: "2026-07-19T08:00:00.000Z",
  complete: true,
};
const POPULATED_DEDUPE_SCAN = {
  ...EMPTY_DEDUPE_SCAN,
  candidate_count: 1,
};
const DEDUPE_PAIR = {
  kind: "phone_collision",
  primary_id: "22222222-2222-4222-8222-222222222222",
  primary_email: "ada.lovelace@example.test",
  duplicate_id: "33333333-3333-4333-8333-333333333333",
  duplicate_email: "ada.lovelace+newsletter@example.test",
  confidence: 0.9,
  primary_updated_at: "2026-07-17T12:00:00.000Z",
  duplicate_updated_at: "2026-07-17T12:05:00.000Z",
  stale: false,
  evidence: [
    {
      kind: "phone_collision",
      confidence: 0.9,
      reason: "Both rows have the same non-empty normalized phone identifier.",
    },
    {
      kind: "plus_alias",
      confidence: 0.9,
      reason:
        "Removing a plus-address suffix resolves both rows to the same mailbox.",
    },
  ],
};
const DEDUPE_PREVIEW = {
  primary_id: DEDUPE_PAIR.primary_id,
  duplicate_id: DEDUPE_PAIR.duplicate_id,
  dry_run: true,
  plan: {
    tags: ["vip", "newsletter"],
    custom_fields: { plan: "Growth", acquisition: "newsletter" },
    status: "unsubscribed",
    consent_timestamp: "2026-01-12T09:30:00.000Z",
    gdpr_permissions: [{ marketing_permission_id: "email", enabled: false }],
    conflicts: [
      {
        field: "custom_fields.plan",
        primary_value: "Growth",
        duplicate_value: "Starter",
        resolution: "primary_wins",
      },
      {
        field: "status",
        primary_value: "enabled",
        duplicate_value: "unsubscribed",
        resolution: "most_restrictive_wins",
      },
    ],
    preserved_on_duplicate: [
      "email and profile identifiers",
      "audience merge fields and name/location fields",
      "list memberships, notes, and ID-keyed history",
    ],
  },
  events_moved: 0,
  suppressions_moved: 0,
  loser_soft_deleted: false,
  primary_updated_at: DEDUPE_PAIR.primary_updated_at,
  duplicate_updated_at: DEDUPE_PAIR.duplicate_updated_at,
  plan_fingerprint: `sha256:${"a".repeat(64)}`,
};

const SUBSCRIBERS = [
  {
    id: "sub-ada",
    version: '"subscriber:sub-ada:v1"',
    email: "ada.lovelace@example.test",
    first_name: "Ada",
    last_name: "Lovelace",
    full_name: "Ada Lovelace",
    display_name: "Ada",
    status: "enabled",
    tags: ["vip", "newsletter"],
    account_name: "Analytical Engines",
    created_at: "2026-01-12T09:30:00.000Z",
    updated_at: "2026-07-17T12:00:00.000Z",
    detected_jurisdiction: "GB",
  },
  {
    id: "sub-grace",
    version: '"subscriber:sub-grace:v1"',
    email: "grace.hopper@example.test",
    first_name: "Grace",
    last_name: "Hopper",
    full_name: "Grace Hopper",
    display_name: "Grace",
    status: "unconfirmed",
    tags: ["product-updates"],
    account_name: "Compiler Labs",
    created_at: "2026-02-18T10:15:00.000Z",
    updated_at: "2026-07-16T16:20:00.000Z",
  },
  {
    id: "sub-katherine",
    version: '"subscriber:sub-katherine:v1"',
    email: "katherine.johnson@example.test",
    first_name: "Katherine",
    last_name: "Johnson",
    full_name: "Katherine Johnson",
    display_name: "Katherine",
    status: "unsubscribed",
    tags: ["events"],
    created_at: "2026-03-04T08:00:00.000Z",
    updated_at: "2026-07-15T14:45:00.000Z",
  },
] as const;

const POPULATED_DIRECTORY = {
  items: SUBSCRIBERS,
  total: 12_840,
  page: 1,
  per_page: 50,
};

const EMPTY_DIRECTORY = {
  items: [],
  total: 0,
  page: 1,
  per_page: 50,
};

const SAVED_SEGMENTS = {
  items: [
    {
      id: "segment-vip",
      tenant_id: "test-tenant",
      name: "High-intent newsletter readers",
      description: "Subscribed VIP readers with recent newsletter activity.",
      predicate_json: {
        filters: { status: "subscribed", q: "tag:vip" },
      },
      created_at: "2026-06-01T09:00:00.000Z",
      updated_at: "2026-07-17T10:00:00.000Z",
      is_pinned: true,
      pin_order: 1,
      visibility_scope: "workspace",
      last_count: 438,
      last_evaluated_at: "2026-07-17T10:00:00.000Z",
    },
    {
      id: "segment-reengage",
      tenant_id: "test-tenant",
      name: "Re-engagement review",
      description: "Unconfirmed and inactive profiles queued for review.",
      predicate_json: {
        filters: { status: "unconfirmed", q: "" },
      },
      created_at: "2026-06-12T09:00:00.000Z",
      updated_at: "2026-07-16T10:00:00.000Z",
      is_pinned: false,
      visibility_scope: "personal",
      last_count: 91,
      last_evaluated_at: "2026-07-16T10:00:00.000Z",
    },
  ],
};

const PII_META = {
  scanner_name: "postwave-shadow-pii",
  scanner_version: "2.0.0",
  detector_name: "regex-heuristic",
  detector_version: "2.0.0",
  policy_name: "undeclared-pii-review",
  policy_version: "sub-071-v2",
};

const PII_FINDINGS = [
  {
    ...PII_META,
    id: "11111111-1111-4111-8111-111111111111",
    subscriber_id: "21111111-1111-4111-8111-111111111111",
    field_name: "custom_fields.legacy_identifier",
    detected_type: "ssn",
    confidence: 0.96,
    fingerprint: "a".repeat(64),
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "key-2026-07",
    status: "pending",
    created_at: "2026-07-17T12:00:00.000Z",
    updated_at: "2026-07-17T12:00:00.000Z",
  },
  {
    ...PII_META,
    scanner_name: "legacy-unversioned",
    scanner_version: "unknown-pre-1760",
    detector_name: "legacy-unversioned",
    detector_version: "unknown-pre-1760",
    policy_name: "legacy-unversioned",
    policy_version: "unknown-pre-1760",
    id: "12222222-2222-4222-8222-222222222222",
    subscriber_id: "22222222-2222-4222-8222-222222222222",
    field_name: "profile.import_notes",
    detected_type: "email",
    confidence: 0.78,
    fingerprint: "b".repeat(64),
    fingerprint_scheme: "legacy-redacted-v1",
    fingerprint_key_version: "legacy",
    status: "pending",
    created_at: "2026-07-16T10:30:00.000Z",
    updated_at: "2026-07-16T10:30:00.000Z",
  },
  {
    ...PII_META,
    id: "13333333-3333-4333-8333-333333333333",
    subscriber_id: "23333333-3333-4333-8333-333333333333",
    field_name: "custom_fields.support_context",
    detected_type: "phone",
    confidence: 0.84,
    fingerprint: "c".repeat(64),
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "key-2026-07",
    status: "reviewed",
    reviewed_at: "2026-07-17T14:00:00.000Z",
    reviewed_by: "user:33333333-3333-4333-8333-333333333333",
    created_at: "2026-07-15T09:00:00.000Z",
    updated_at: "2026-07-17T14:00:00.000Z",
    review_receipt: {
      ...PII_META,
      receipt_id: "43333333-3333-4333-8333-333333333333",
      status: "reviewed",
      reason: "remediated",
      comment:
        "The support note was moved to the governed field and the source value was removed.",
      evidence_reference: "ticket:DPO-412",
      reviewed_at: "2026-07-17T14:00:00.000Z",
      actor_type: "user",
      actor_id: "33333333-3333-4333-8333-333333333333",
      fingerprint: "c".repeat(64),
      fingerprint_scheme: "hmac-sha256-v1",
      fingerprint_key_version: "key-2026-07",
      finding_updated_at: "2026-07-15T09:00:00.000Z",
    },
  },
] as const;

const BASE_SUBSCRIBER_API: Readonly<Record<string, unknown>> = {
  "/api/v1/dashboard/stats": {
    subscribers_total: 12_840,
    subscribers_added_30d: 642,
    subscribers_unsubbed_30d: 91,
    range: "30d",
    previous: {},
    sparklines: {},
    anomalies: {},
    recent_audit: [],
  },
  "/api/v1/segments/saved": SAVED_SEGMENTS,
  "/api/v1/segments/compile-from-text": {
    ast: {
      op: "condition",
      field: "last_opened_at",
      comparator: "in_last_days",
      value: 7,
    },
    query_ast: {
      op: "condition",
      field: "last_opened_at",
      comparator: "in_last_days",
      value: 7,
    },
    queryAst: {
      op: "condition",
      field: "last_opened_at",
      comparator: "in_last_days",
      value: 7,
    },
    engine_used: "rules",
    rationale:
      "Matched an open within the last 7 days to the last-opened engagement field.",
    suggested_name: "Opened in last 7d",
    suggestedName: "Opened in last 7d",
    nutrition_facts: {
      predicates: ["last_opened_at"],
      time_windows: ["7 days"],
      source: "rules",
    },
  },
  "/api/v1/segments/preview": {
    count: 438,
    workspace_total: 12_840,
    workspace_percentage: 3.4,
    generated_at: "2026-07-18T08:00:00.000Z",
    archive_scope: "active_only",
    applied_exclusions: ["archived_subscribers"],
  },
  "/api/v1/subscribers/growth": {
    days: 90,
    series: [
      growthPoint("2026-07-11", 12_520, 84, 11, 0),
      growthPoint("2026-07-12", 12_571, 72, 13, 0),
      growthPoint("2026-07-13", 12_624, 75, 12, 0),
      growthPoint("2026-07-14", 12_678, 78, 16, 0),
      growthPoint("2026-07-15", 12_731, 70, 10, 0),
      growthPoint("2026-07-16", 12_786, 76, 14, 0),
      growthPoint("2026-07-17", 12_840, 77, 15, 0),
    ],
    metric_contract_version: "verified-exact-ledger-v2",
    unavailable_metrics: ["lapsed"],
    partial_metrics: ["unsubbed"],
    total_added: 532,
    total_unsubbed: 91,
    delta: 320,
    delta_pct: (320 / 12_520) * 100,
    note: "Verified withdrawals include supported exact-address transitions; legacy or unbound records are excluded. Lapsed is unavailable because no canonical engagement-decay definition is configured; placeholder zeroes are excluded from the chart.",
  },
  "/api/v1/lifecycle/distribution": {
    items: [
      { stage: "new", count: 2_140 },
      { stage: "engaged", count: 7_820 },
      { stage: "at_risk", count: 1_980 },
      { stage: "lapsed", count: 900 },
    ],
  },
  "/api/v1/lifecycle/stages": {
    stages: ["new", "engaged", "at_risk", "lapsed"],
  },
  "/api/v1/engagement-scores/distribution": {
    buckets: [
      { range: "0–19", min: 0, max: 19, count: 740 },
      { range: "20–39", min: 20, max: 39, count: 1_920 },
      { range: "40–59", min: 40, max: 59, count: 3_480 },
      { range: "60–79", min: 60, max: 79, count: 4_210 },
      { range: "80–100", min: 80, max: 100, count: 2_490 },
    ],
  },
  "/api/v1/engagement-scores/subscribers": {
    items: [
      { id: "sub-ada", email: "ada.lovelace@example.test", score: 94 },
      { id: "sub-grace", email: "grace.hopper@example.test", score: 82 },
    ],
    total: 2,
    page: 1,
    per_page: 25,
  },
  "/api/v1/pii-scan-config": {
    ...PII_META,
    available: true,
    scan_enabled: true,
    status: "enabled_unverified",
    execution_mode: "partial_write_path_hooks",
    scheduled_scans_available: false,
    fingerprint_scheme: "hmac-sha256-v1",
    fingerprint_key_version: "key-2026-07",
    reliability: "best_effort",
    coverage: "unverified",
    coverage_limitations: [
      "no_durable_scan_intent",
      "no_retry_or_dead_letter_queue",
      "no_coverage_watermark_or_gap_ledger",
      "direct_subscriber_writers_may_bypass_hooks",
    ],
    max_scan_fields: 500,
    max_scan_field_bytes: 65_536,
    max_detections_per_field: 50,
    max_detections_per_subscriber: 200,
    updated_at: ISO,
  },
  "/api/v1/pii-findings": {
    items: PII_FINDINGS,
    total: PII_FINDINGS.length,
    page: 1,
    per_page: 50,
  },
  "/api/v1/sunset/policies": {
    items: [
      {
        id: "sunset-1",
        tenantId: "test-tenant",
        name: "180-day inactivity review",
        inactiveDays: 180,
        action: "tag",
        enabled: true,
        excludedTags: ["vip"],
        createdAt: "2026-06-01T09:00:00.000Z",
        updatedAt: ISO,
      },
    ],
  },
  "/api/v1/scoring/rules": {
    rules: [
      {
        id: "score-open",
        event_type: "opened",
        weight: 2,
        note: "Recent message open",
      },
      {
        id: "score-click",
        event_type: "clicked",
        weight: 5,
        note: "High-intent click",
      },
    ],
    defaults: [
      { id: "default-open", event_type: "opened", weight: 1 },
      { id: "default-click", event_type: "clicked", weight: 3 },
    ],
    event_catalog: [
      {
        event_type: "opened",
        label: "Email opened",
        category: "engagement",
      },
      {
        event_type: "clicked",
        label: "Link clicked",
        category: "engagement",
      },
    ],
    version: `sha256:${"b".repeat(64)}`,
    window_days: 90,
  },
  "/api/v1/merge-fields/schema": {
    items: [
      {
        tenant_id: "test-tenant",
        key: "FNAME",
        label: "First name",
        type: "text",
        default_value: "",
        required: false,
        position: 1,
        value_count: 8_642,
        created_at: "2026-04-10T09:00:00.000Z",
        updated_at: "2026-07-17T12:00:00.000Z",
      },
      {
        tenant_id: "test-tenant",
        key: "COMPANY",
        label: "Company",
        type: "text",
        default_value: "",
        required: false,
        position: 2,
        value_count: 0,
        created_at: "2026-04-10T09:05:00.000Z",
        updated_at: "2026-07-16T16:20:00.000Z",
      },
    ],
  },
  "/api/v1/subscribers/duplicates": { pairs: [] },
  "/api/v1/subscribers/duplicate-scans": EMPTY_DEDUPE_SCAN,
  [`/api/v1/subscribers/duplicate-scans/${DEDUPE_SCAN_ID}/pairs`]: {
    scan: EMPTY_DEDUPE_SCAN,
    pairs: [],
    count: 0,
    complete: true,
  },
  "/api/v1/settings/deduplication": {
    merge_confidence_threshold: 0.85,
  },
  "/api/v1/subscribers/preview-transforms": {
    config: {
      email_normalize_dots: false,
      email_normalize_plus: false,
      phone_e164_format: false,
      phone_default_region: "",
    },
    email_input: "ada.lovelace@example.test",
    email_output: "ada.lovelace@example.test",
    email_changed: false,
    phones: [],
  },
  "/api/v1/subscribers/sub-ada": {
    ...SUBSCRIBERS[0],
    locale: "en-GB",
    language: "en",
    country: "GB",
    region: "London",
    consent_source: "double_optin",
    consent_timestamp: "2026-01-12T09:30:00.000Z",
    consent_email_marketing_at: "2026-01-12T09:30:00.000Z",
    custom_fields: { plan: "Growth" },
    merge_fields: { FNAME: "Ada", COMPANY: "Analytical Engines" },
  },
  "/api/v1/subscribers/sub-ada/activity": [],
  "/api/v1/subscribers/sub-ada/history": { items: [] },
  "/api/v1/subscribers/sub-ada/timeline": {
    subscriber_id: "sub-ada",
    email: "ada.lovelace@example.test",
    stats: {
      sent_count: 42,
      opened_count: 31,
      clicked_count: 12,
      bounced_count: 0,
      replied_count: 3,
      open_rate: 0.738,
      click_rate: 0.286,
      engagement_score: 0.88,
      subscribed_at: "2026-01-12T09:30:00.000Z",
      last_active_at: "2026-07-17T12:00:00.000Z",
      current_status: "enabled",
    },
    events: [],
    pagination: { limit: 50, has_more: false },
  },
  "/api/v1/subscribers/sub-ada/cross-channel-timeline": {
    items: [],
    has_more: false,
    next_before: null,
  },
  "/api/v1/subscribers/sub-ada/ai-summary": {
    summary:
      "Highly engaged newsletter reader with consistent product-interest signals.",
    drivers: [
      { key: "opens", label: "Open rate", value: "74%", weight: "high" },
    ],
    last_updated: "2026-07-17T12:00:00.000Z",
    cache_hit: true,
    source: "deterministic",
  },
  "/api/v1/subscribers/sub-ada/engagement-score": {
    subscriber_id: "sub-ada",
    score: 88,
    computed_at: "2026-07-17T12:00:00.000Z",
  },
  "/api/v1/contact-ratings/sub-ada": {
    subscriber_id: "sub-ada",
    stars: 5,
    engagement_score: 88,
    engagement_score_at: "2026-07-17T12:00:00.000Z",
    source: "heuristic",
  },
};

type ListResponder = (
  route: Route,
  url: URL,
  requestNumber: number,
) => Promise<void>;

interface SubscriberApiScenario {
  list?: ListResponder;
  overrides?: Readonly<Record<string, unknown>>;
  unavailablePaths?: readonly string[];
}

interface SubscriberFixtureOptions extends SubscriberApiScenario {
  tab?: "directory" | "insights" | "segments" | "governance" | "rules";
  theme?: "dark" | "light";
}

interface RuntimeGuard {
  errors: string[];
  expectedFailurePaths: Set<string>;
  onConsole: (message: ConsoleMessage) => void;
  onPageError: (error: Error) => void;
}

const runtimeGuards = new WeakMap<Page, RuntimeGuard>();

test.beforeEach(({ page }) => {
  const guard: RuntimeGuard = {
    errors: [],
    expectedFailurePaths: new Set(),
    onConsole: (message) => {
      if (message.type() !== "error") return;
      const location = message.location().url;
      if (
        message.text().startsWith("Failed to load resource:") &&
        ([...guard.expectedFailurePaths].some((path) =>
          location.includes(path),
        ) ||
          (guard.expectedFailurePaths.size > 0 &&
            message.text().includes("ERR_INTERNET_DISCONNECTED")))
      ) {
        return;
      }
      guard.errors.push(message.text());
    },
    onPageError: (error) => guard.errors.push(error.message),
  };
  runtimeGuards.set(page, guard);
  page.on("console", guard.onConsole);
  page.on("pageerror", guard.onPageError);
});

test.afterEach(({ page }) => {
  const guard = runtimeGuards.get(page);
  if (!guard) return;
  page.off("console", guard.onConsole);
  page.off("pageerror", guard.onPageError);
  runtimeGuards.delete(page);
  expect(guard.errors, "Subscribers emitted renderer runtime errors").toEqual(
    [],
  );
});

function growthPoint(
  date: string,
  total: number,
  added: number,
  unsubbed: number,
  lapsed: number,
): Record<string, unknown> {
  return {
    date,
    evaluated_at: `${date}T23:59:00.000Z`,
    total,
    added,
    unsubbed,
    lapsed,
  };
}

function allowExpectedFailure(page: Page, path: string): void {
  const guard = runtimeGuards.get(page);
  if (!guard) throw new Error("Subscribers runtime guard was not installed");
  guard.expectedFailurePaths.add(path);
}

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  });
}

async function fulfillDirectory(
  route: Route,
  body: unknown = POPULATED_DIRECTORY,
): Promise<void> {
  const requestedPage = Math.max(
    1,
    Number(new URL(route.request().url()).searchParams.get("page")) || 1,
  );
  const response =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? { ...(body as Record<string, unknown>), page: requestedPage }
      : body;
  await fulfillJson(route, response);
}

async function installSubscriberApi(
  page: Page,
  scenario: SubscriberApiScenario = {},
): Promise<void> {
  let listRequestNumber = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (request.method() === "GET" && path === "/api/v1/subscribers") {
      listRequestNumber += 1;
      if (scenario.list) {
        await scenario.list(route, url, listRequestNumber);
      } else {
        await fulfillDirectory(route);
      }
      return;
    }

    if (
      request.method() === "GET" &&
      path === "/api/v1/subscribers/export.csv"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: {
          "Content-Disposition":
            'attachment; filename="postwave-subscribers-2026-07-18.csv"',
          "X-Postwave-Exported-Rows": "12840",
          "X-Postwave-Truncated": "false",
        },
        body: "email,status\nada.lovelace@example.test,enabled\n",
      });
      return;
    }

    if (request.method() === "POST" && path === "/api/v1/sar/requests") {
      await fulfillJson(route, {
        id: "sar-access-1",
        kind: "access",
        subscriber_email: "ada.lovelace@example.test",
        status: "completed",
        event_count: 42,
        consent_count: 3,
        bundle_bytes: 8_192,
        download_url: "/api/v1/subscribers/sub-ada/data-export.zip",
        store_responses: [
          {
            provider: "shopify",
            status: "returned",
            customer_id: "customer-test-1",
            action_taken: "return_only",
          },
        ],
      });
      return;
    }

    if (
      request.method() === "GET" &&
      path === "/api/v1/segments/compile-from-text"
    ) {
      await fulfillJson(route, {
        available: true,
        ai_processing: {
          provider: "anthropic",
          model: "claude-sonnet",
          data_categories: [
            "operator_supplied_segment_description",
            "segment_predicate_catalog",
          ],
          retention: "not_declared",
          residency: "not_declared",
        },
      });
      return;
    }

    if (scenario.unavailablePaths?.includes(path)) {
      await fulfillJson(
        route,
        { error: { code: "not_found", message: "Capability unavailable" } },
        404,
      );
      return;
    }

    const overridden = scenario.overrides?.[path];
    if (overridden !== undefined) {
      await fulfillJson(route, overridden);
      return;
    }
    if (request.method() === "GET" && path === "/api/v1/pii-findings") {
      const status = url.searchParams.get("status");
      const detectedType = url.searchParams.get("detected_type");
      const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      const pageNumber = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const perPage = Math.max(
        1,
        Math.min(50, Number(url.searchParams.get("per_page")) || 50),
      );
      const filtered = PII_FINDINGS.filter((finding) => {
        if (status && finding.status !== status) return false;
        if (detectedType && finding.detected_type !== detectedType)
          return false;
        if (!query) return true;
        return (
          finding.field_name.toLowerCase().includes(query) ||
          finding.id.toLowerCase() === query ||
          finding.subscriber_id.toLowerCase() === query ||
          (finding.fingerprint_scheme === "hmac-sha256-v1" &&
            finding.fingerprint.toLowerCase().startsWith(query))
        );
      });
      const offset = (pageNumber - 1) * perPage;
      await fulfillJson(route, {
        items: filtered.slice(offset, offset + perPage),
        total: filtered.length,
        page: pageNumber,
        per_page: perPage,
      });
      return;
    }
    const base = BASE_SUBSCRIBER_API[path];
    if (base !== undefined) {
      const record =
        base !== null && typeof base === "object" && !Array.isArray(base)
          ? (base as Record<string, unknown>)
          : null;
      const detailVersion =
        request.method() === "GET" &&
        path === "/api/v1/subscribers/sub-ada" &&
        typeof record?.version === "string"
          ? record.version
          : undefined;
      await fulfillJson(
        route,
        base,
        200,
        detailVersion === undefined ? undefined : { ETag: detailVersion },
      );
      return;
    }
    await route.fallback();
  });
}

async function openSubscribers(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: SubscriberFixtureOptions = {},
): Promise<void> {
  await page.clock.install({ time: FIXED_NOW });
  await setTheme(page, options.theme ?? "dark");
  await bootApp(page);
  await installSubscriberApi(page, options);
  const suffix =
    options.tab && options.tab !== "directory" ? `?tab=${options.tab}` : "";
  await page.goto(`/app/subscribers${suffix}`);
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByRole("heading", { name: "Subscribers", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Subscriber workspaces" }),
  ).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function settleSubscriberReconnect(page: Page): Promise<void> {
  const reconnectNotice = page.getByText("Reconnecting subscriber updates", {
    exact: true,
  });
  await expect(reconnectNotice).toBeVisible({ timeout: 15_000 });
  // The deterministic EventSource opens after the first painted frame. Wait
  // for that transition before checking the refresh control; otherwise the
  // initial enabled button can be mistaken for the post-reconciliation idle
  // state and the screenshot races the authoritative background read.
  await expect(reconnectNotice).toBeHidden({ timeout: 15_000 });
  const refresh = page.getByRole("button", { name: /^Refresh(?:ing…)?$/ });
  await expect
    .poll(
      async () => {
        if ((await refresh.count()) !== 1 || !(await refresh.isEnabled())) {
          return false;
        }
        await page.waitForTimeout(750);
        return (
          (await refresh.isEnabled()) &&
          (await refresh.textContent())?.trim() === "Refresh"
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
}

async function openAudienceFieldsDialog(page: Page): Promise<Locator> {
  await expect(
    page.getByRole("heading", { name: "Audience field schema" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit field schema…" }).click();
  const dialog = page.getByRole("dialog", { name: "Audience fields" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("workspace tabs are URL-backed, manually activated, and history-safe", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, { tab: "insights" });

  const tabs = page.getByRole("tablist", { name: "Subscriber workspaces" });
  const directory = tabs.getByRole("tab", { name: "Directory" });
  const insights = tabs.getByRole("tab", { name: "Insights" });
  const segments = tabs.getByRole("tab", { name: /Segments/ });
  const governance = tabs.getByRole("tab", { name: "Governance" });
  const rules = tabs.getByRole("tab", { name: "Rules & fields" });

  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(insights).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/app\/subscribers\?tab=insights$/);
  await expect(
    page.getByRole("heading", { name: "Audience signals" }),
  ).toBeVisible();

  await insights.focus();
  await page.keyboard.press("ArrowRight");
  await expect(segments).toBeFocused();
  await expect(insights).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=insights/);

  await page.keyboard.press("Enter");
  await expect(segments).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=segments/);
  await expect(
    page.getByRole("heading", { name: "Reusable audiences" }),
  ).toBeVisible();

  await governance.click();
  await expect(page).toHaveURL(/tab=governance/);
  await rules.click();
  await expect(page).toHaveURL(/tab=rules/);

  await page.goBack();
  await expect(governance).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(segments).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(insights).toHaveAttribute("aria-selected", "true");

  await directory.click();
  await expect(directory).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/app\/subscribers$/);
});

test("directory applied view survives reload and resets canonically", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(60_000);
  let returnEmpty = false;
  const directoryRequests: URL[] = [];
  await openSubscribers(page, bootApp, setTheme, {
    list: async (route, url) => {
      directoryRequests.push(new URL(url));
      await fulfillDirectory(
        route,
        returnEmpty ? EMPTY_DIRECTORY : POPULATED_DIRECTORY,
      );
    },
  });

  const search = page.getByRole("searchbox", {
    name: "Search subscribers by email or name",
  });

  await search.fill("ada");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("q"))
    .toBe("ada");
  await page.getByRole("button", { name: "Subscribed", exact: true }).click();
  await page.getByRole("button", { name: "Show archived" }).click();
  await page.getByRole("button", { name: /^Sort by Email/ }).click();
  await page.getByRole("button", { name: "Next page", exact: true }).click();

  const appliedPath =
    "/app/subscribers?q=ada&sort=email&dir=desc&f.archived=true&f.page=2&f.status=subscribed";
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(appliedPath);
  await expect(search).toHaveValue("ada");
  await expect(
    page.getByRole("button", { name: /Subscribed/ }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Show archived" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("columnheader", { name: "Email" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByText(/Page 2 of 257/)).toBeVisible();

  const requestCountBeforeReload = directoryRequests.length;
  await page.reload();
  await waitForPrimaryNavigation(page);
  await expect
    .poll(() => directoryRequests.length)
    .toBeGreaterThan(requestCountBeforeReload);
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(appliedPath);
  await expect(search).toHaveValue("ada");
  await expect(
    page.getByRole("button", { name: /Subscribed/ }).first(),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Show archived" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("columnheader", { name: "Email" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByText(/Page 2 of 257/)).toBeVisible();

  const restoredRequest = directoryRequests.at(-1);
  expect(restoredRequest).toBeDefined();
  expect(restoredRequest?.searchParams.get("q")).toBe("ada");
  expect(restoredRequest?.searchParams.get("status")).toBe("enabled");
  expect(restoredRequest?.searchParams.get("include_archived")).toBe("true");
  expect(restoredRequest?.searchParams.get("sort")).toBe("email");
  expect(restoredRequest?.searchParams.get("order")).toBe("desc");
  expect(restoredRequest?.searchParams.get("page")).toBe("2");

  await page.getByRole("tab", { name: "Insights" }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(
      "/app/subscribers?tab=insights&q=ada&sort=email&dir=desc&f.archived=true&f.page=2&f.status=subscribed",
    );
  await page.getByRole("tab", { name: "Directory" }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(appliedPath);

  returnEmpty = true;
  await search.fill("");
  await expect(page.getByRole("button", { name: "Reset view" })).toBeVisible();
  const requestCountBeforeReset = directoryRequests.length;
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe("/app/subscribers");
  await expect(search).toHaveValue("");
  await expect
    .poll(() => directoryRequests.length)
    .toBeGreaterThan(requestCountBeforeReset);
  await expect
    .poll(() => {
      const request = directoryRequests.at(-1);
      return request
        ? [
            request.searchParams.get("q"),
            request.searchParams.get("status"),
            request.searchParams.get("include_archived"),
            request.searchParams.get("sort"),
            request.searchParams.get("order"),
            request.searchParams.get("page"),
          ]
        : [];
    })
    .toEqual([null, null, null, "updated_at", "desc", "1"]);

  // A supported overlay deep link remains independently operable after the
  // Directory state has returned to its canonical default.
  await page.goto("/app/subscribers?overlay=import");
  const importDialog = page.getByRole("dialog", { name: "Import subscribers" });
  await expect(importDialog).toBeVisible({ timeout: 20_000 });
  await importDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/app\/subscribers$/);
});

test("directory exposes a semantic, page-scoped keyboard grid", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme);
  const grid = page.getByRole("grid", { name: "Subscribers directory" });
  const ada = grid.getByRole("row", {
    name: "Subscriber ada.lovelace@example.test",
  });
  const grace = grid.getByRole("row", {
    name: "Subscriber grace.hopper@example.test",
  });
  const katherine = grid.getByRole("row", {
    name: "Subscriber katherine.johnson@example.test",
  });

  await expect(grid).toHaveAttribute("aria-rowcount", "4");
  await expect(grid).not.toHaveAttribute("aria-busy", "true");
  await expect(ada).toHaveAttribute("tabindex", "0");
  await expect(grace).toHaveAttribute("tabindex", "-1");

  await ada.focus();
  await page.keyboard.press("ArrowDown");
  await expect(grace).toBeFocused();
  await page.keyboard.press(" ");
  await expect(grace).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("1 selected", { exact: false }).first(),
  ).toBeVisible();

  await page.keyboard.press("End");
  await expect(katherine).toBeFocused();
  await page.keyboard.press("Home");
  await expect(ada).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "ada.lovelace@example.test" }),
  ).toBeVisible();
});

test("directory distinguishes loading, first-load failure, and recovery", async ({
  page,
  bootApp,
  setTheme,
}) => {
  let release: (() => void) | undefined;
  let directoryMode: "loading" | "ready" | "error" = "loading";
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await openSubscribers(page, bootApp, setTheme, {
    list: async (route) => {
      if (directoryMode === "loading") await gate;
      if (directoryMode === "error") {
        await fulfillJson(
          route,
          {
            error: { code: "unavailable", message: "Directory unavailable" },
          },
          400,
        );
        return;
      }
      await fulfillDirectory(route);
    },
  });

  const grid = page.getByRole("grid", { name: "Subscribers directory" });
  await expect(grid).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByText("Loading subscribers…", { exact: true }).first(),
  ).toBeVisible();
  directoryMode = "ready";
  release?.();
  await expect(
    grid.getByRole("row", { name: "Subscriber ada.lovelace@example.test" }),
  ).toBeVisible();

  allowExpectedFailure(page, "/api/v1/subscribers");
  directoryMode = "error";
  await page.reload();
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByText(/Couldn't load subscribers:/).first(),
  ).toBeVisible();
  await expect(grid).not.toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeVisible();
});

test("filter-empty and offline-like refresh retain honest state", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(60_000);
  let failRefresh = false;
  await openSubscribers(page, bootApp, setTheme, {
    list: async (route, url) => {
      if (failRefresh) {
        await route.abort("internetdisconnected");
        return;
      }
      await fulfillDirectory(
        route,
        url.searchParams.get("q") ? EMPTY_DIRECTORY : POPULATED_DIRECTORY,
      );
    },
  });
  const search = page.getByRole("searchbox", {
    name: "Search subscribers by email or name",
  });
  await search.fill("no-such-profile");
  await expect(
    page.getByRole("heading", { name: "No matches for “no-such-profile”" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Clear search" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(
    page.getByText("ada.lovelace@example.test").first(),
  ).toBeVisible();

  const refresh = page.getByRole("button", { name: "Refresh", exact: true });
  await expect(refresh).toBeEnabled();
  // The first live-stream connection intentionally reconciles once after
  // boot. Let that authoritative background read finish before exercising
  // the operator-triggered refresh below.
  await page.waitForTimeout(750);
  await expect(refresh).toBeEnabled();
  const refreshControl = await refresh.elementHandle();
  expect(refreshControl).not.toBeNull();
  allowExpectedFailure(page, "/api/v1/subscribers");
  failRefresh = true;
  // Dispatch directly after the enabled-state assertion: the deterministic
  // live transport can schedule its own reconciliation in the same frame,
  // making pointer-stability checks race a legitimate background refresh.
  await refreshControl?.dispatchEvent("click");
  await expect(
    page.getByText("Showing last-confirmed subscribers", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("ada.lovelace@example.test").first(),
  ).toBeVisible();
  // A live reconciliation may legitimately be inside its bounded retry phase
  // when the stale-state banner appears. Both phases are truthful: a disabled
  // automatic retry, or an enabled manual recovery affordance after backoff.
  const recovery = page.getByRole("button", {
    name: /^(?:Try again|Retrying…)$/,
  });
  await expect(recovery).toBeVisible();
  const recoveryLabel = (await recovery.textContent())?.trim();
  if (recoveryLabel === "Retrying…") {
    await expect(recovery).toBeDisabled();
  } else {
    await expect(recovery).toBeEnabled();
  }
});

test("insights, segments, governance, and rules render truthful populated contracts", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, { tab: "insights" });
  await expect(
    page.getByText("Workspace total", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("12,840", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("Status evidence", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Audience growth" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Lifecycle distribution" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Engagement scores" }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Segments/ }).click();
  await expect(
    page.getByRole("heading", { name: "High-intent newsletter readers" }),
  ).toBeVisible();
  await expect(
    page.getByText("Subscribed VIP readers with recent newsletter activity.", {
      exact: true,
    }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Governance" }).click();
  await expect(
    page.getByRole("region", { name: "Shadow-PII findings" }),
  ).toBeVisible();
  await page.getByText("Sunset policies", { exact: false }).first().click();
  await expect(page.getByText("180-day inactivity review")).toBeVisible();

  await page.getByRole("tab", { name: "Rules & fields" }).click();
  await expect(
    page.getByRole("heading", { name: "Audience field schema" }),
  ).toBeVisible();
  await page.getByText("Lead scoring", { exact: false }).first().click();
  await expect(page.getByLabel("Rule 1 event type")).toHaveValue("opened");
  await expect(page.getByLabel("Rule 2 weight")).toHaveValue("5");
});

test("add, import, dedupe, and field-schema overlays are safe and focus-restoring", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme);

  const add = page
    .getByRole("button", { name: "Add subscriber", exact: true })
    .first();
  await add.click();
  const addDialog = page.getByRole("dialog", { name: "Add subscriber" });
  await expect(addDialog).toBeVisible();
  await expect(addDialog.getByLabel("Email")).toBeFocused();
  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeFocused();

  const importButton = page.getByRole("button", { name: "Import CSV" }).first();
  await importButton.click();
  const importDialog = page.getByRole("dialog", { name: "Import subscribers" });
  await expect(importDialog).toBeVisible();
  await expect(
    importDialog.getByRole("list", { name: "Subscriber import steps" }),
  ).toBeVisible();
  await importDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(importButton).toBeFocused();

  const dedupe = page.getByRole("button", { name: "Dedupe" }).first();
  await dedupe.click();
  const dedupeDialog = page.getByRole("dialog", {
    name: "Duplicate review workspace",
  });
  await expect(dedupeDialog).toBeVisible();
  await expect(
    dedupeDialog.getByText("No deterministic duplicate candidates"),
  ).toBeVisible();
  await expect(
    dedupeDialog.getByText(/This scan is complete, not sampled/),
  ).toBeVisible();
  await dedupeDialog.getByRole("button", { name: "Close workspace" }).click();
  await expect(dedupe).toBeFocused();

  await page.getByRole("tab", { name: "Rules & fields" }).click();
  const editSchema = page.getByRole("button", { name: "Edit field schema…" });
  await editSchema.click();
  const schemaDialog = page.getByRole("dialog", { name: "Audience fields" });
  await expect(schemaDialog).toBeVisible();
  await expect(
    schemaDialog
      .getByLabel("Personalization fields")
      .getByText("FNAME", { exact: true }),
  ).toBeVisible();
  await schemaDialog.getByRole("button", { name: "Done" }).click();
  await expect(editSchema).toBeFocused();
});

test("dedupe workspace and reviewed merge remain evidence-rich, responsive, and keyboard safe", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, {
    overrides: {
      "/api/v1/subscribers/duplicate-scans": POPULATED_DEDUPE_SCAN,
      [`/api/v1/subscribers/duplicate-scans/${DEDUPE_SCAN_ID}/pairs`]: {
        scan: POPULATED_DEDUPE_SCAN,
        pairs: [DEDUPE_PAIR],
        count: 1,
        complete: true,
      },
      "/api/v1/merge/apply": DEDUPE_PREVIEW,
    },
  });

  await page.getByRole("button", { name: "Dedupe" }).first().click();
  const workspace = page.getByRole("dialog", {
    name: "Duplicate review workspace",
  });
  await expect(workspace).toBeVisible();
  await expect(
    workspace.getByRole("region", { name: "Verified scan summary" }),
  ).toBeVisible();
  await expect(
    workspace.getByText(DEDUPE_PAIR.evidence[0].reason),
  ).toBeVisible();
  await expect(
    workspace.getByText(DEDUPE_PAIR.evidence[1].reason),
  ).toBeVisible();
  await expect(
    workspace.getByText("Entire verified manifest loaded."),
  ).toBeVisible();
  await settle(page);
  await expect(workspace).toHaveScreenshot(
    "subscribers-dedupe-workspace-populated-dark.png",
  );

  const review = workspace.getByRole("button", { name: /Review merge/ });
  await review.focus();
  await page.keyboard.press("Enter");
  const reviewDialog = page.getByRole("alertdialog", {
    name: "Review one subscriber merge",
  });
  await expect(reviewDialog).toBeVisible();
  await expect(reviewDialog.getByText("custom_fields.plan")).toBeVisible();
  await expect(reviewDialog.getByText("Most restrictive wins")).toBeVisible();
  await expect(
    reviewDialog.getByText("list memberships, notes, and ID-keyed history"),
  ).toBeVisible();
  const apply = reviewDialog.getByRole("button", {
    name: "Apply reviewed merge",
  });
  await expect(apply).toBeDisabled();
  await reviewDialog.getByPlaceholder("MERGE").fill("MERGE");
  await expect(apply).toBeEnabled();
  await settle(page);
  await expect(reviewDialog).toHaveScreenshot(
    "subscribers-dedupe-reviewed-plan-dark.png",
  );

  await page.setViewportSize({ width: 760, height: 860 });
  await expect(reviewDialog).toBeVisible();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(reviewDialog).toHaveScreenshot(
    "subscribers-dedupe-reviewed-plan-narrow-dark.png",
  );

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await settle(page);
  await expect(reviewDialog).toHaveScreenshot(
    "subscribers-dedupe-reviewed-plan-forced-colors.png",
  );
});

test("detail privacy, read-only DSAR, and export disclosure stay explicit", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme);
  await page
    .getByRole("button", { name: "Open ada.lovelace@example.test" })
    .click();
  const detail = page.getByRole("dialog", {
    name: "ada.lovelace@example.test",
  });
  await expect(detail).toBeVisible({ timeout: 20_000 });
  const detailGroups = detail.getByRole("tablist", {
    name: "Subscriber detail groups",
  });
  await expect(detailGroups.getByRole("tab")).toHaveCount(5);
  await detailGroups.getByRole("tab", { name: "Consent", exact: true }).click();
  const consentSections = detail.getByRole("tablist", {
    name: "Consent sections",
  });
  await expect(consentSections.getByRole("tab")).toHaveCount(2);
  await expect(
    consentSections.getByRole("tab", { name: "Privacy", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    detail.getByText("Subject Access Request (GDPR Article 15 / CCPA)"),
  ).toBeVisible();
  await detail
    .getByRole("button", { name: /Export this subscriber's data/ })
    .click();

  const dsar = page.getByRole("dialog", {
    name: "Create a read-only subject access request",
  });
  await expect(dsar).toBeVisible();
  await expect(
    dsar.getByText(/This access request is read-only/),
  ).toBeVisible();
  await expect(
    dsar.getByRole("button", {
      name: "Download Moosewave access export (.zip)",
    }),
  ).toBeVisible();
  await dsar.getByText("Close", { exact: true }).click();
  await detail.getByLabel("Close").click();

  const exportButton = page.getByRole("button", {
    name: "Export",
    exact: true,
  });
  await expect(exportButton).toHaveAccessibleDescription(
    /complete applied view.*page-only fallback is disabled/,
  );
  await page.evaluate(() => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (!internals) return;
    const original = internals.invoke.bind(internals);
    internals.invoke = async (command, args) =>
      command === "plugin:dialog|save" ? null : original(command, args);
  });
  await exportButton.click();
  const disclosure = page
    .getByRole("status")
    .filter({ hasText: "Preparing the frozen subscriber export" });
  await expect(disclosure).toContainText("active only");
  await expect(disclosure).toContainText("12,840 matching");
  await expect(disclosure).toContainText("personal data");
  await expect(disclosure).toContainText("server-complete path");
  await expect(exportButton).toBeEnabled();
});

test("narrow viewport contains wide grid and workspace navigation", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await openSubscribers(page, bootApp, setTheme, { theme: "light" });
  await expectNoDocumentOverflow(page);
  await expect(
    page.getByRole("tablist", { name: "Subscriber workspaces" }),
  ).toBeVisible();
  await expect(
    page.getByRole("grid", { name: "Subscribers directory" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add subscriber", exact: true }).first(),
  ).toBeVisible();
});

test("440 by 280 zoom proxy keeps focused controls operable and contained", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, { theme: "light" });
  await page.setViewportSize({ width: 440, height: 280 });
  await settle(page);
  await expectNoDocumentOverflow(page);

  const directory = page.getByRole("tab", { name: "Directory" });
  await directory.focus();
  await expect(directory).toBeFocused();

  const search = page.getByRole("searchbox", {
    name: "Search subscribers by email or name",
  });
  await search.scrollIntoViewIfNeeded();
  await search.focus();
  await expect(search).toBeFocused();
  const searchBox = await search.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((searchBox?.x ?? 441) + (searchBox?.width ?? 0)).toBeLessThanOrEqual(
    440,
  );
  expect(searchBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((searchBox?.y ?? 281) + (searchBox?.height ?? 0)).toBeLessThanOrEqual(
    280,
  );

  const add = page
    .getByRole("button", { name: "Add subscriber", exact: true })
    .first();
  await add.scrollIntoViewIfNeeded();
  await add.click();
  const addDialog = page.getByRole("dialog", { name: "Add subscriber" });
  await expect(addDialog).toBeVisible();
  const email = addDialog.getByLabel("Email");
  await expect(email).toBeFocused();
  const emailBox = await email.boundingBox();
  expect(emailBox).not.toBeNull();
  expect(emailBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((emailBox?.x ?? 441) + (emailBox?.width ?? 0)).toBeLessThanOrEqual(
    440,
  );
  expect(emailBox?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((emailBox?.y ?? 281) + (emailBox?.height ?? 0)).toBeLessThanOrEqual(
    280,
  );
  await addDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeFocused();
  await expectNoDocumentOverflow(page);
});

test("reduced motion and forced colors preserve operable semantics", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await openSubscribers(page, bootApp, setTheme, { tab: "governance" });
  const governance = page.getByRole("tab", { name: "Governance" });
  await expect(governance).toHaveAttribute("aria-selected", "true");
  await governance.focus();
  await expect(governance).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: /Segments/ })).toBeFocused();
  await expect(governance).toHaveAttribute("aria-selected", "true");
});

test("visual: populated directory in dark theme", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, { theme: "dark" });
  await expect(
    page.getByText("ada.lovelace@example.test").first(),
  ).toBeVisible();
  await settleSubscriberReconnect(page);
  await settle(page);
  await expect(page).toHaveScreenshot(
    "subscribers-directory-populated-dark.png",
  );
});

test("visual: empty directory in light theme", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await openSubscribers(page, bootApp, setTheme, {
    theme: "light",
    list: async (route) => fulfillDirectory(route, EMPTY_DIRECTORY),
    overrides: { "/api/v1/segments/saved": { items: [] } },
  });
  await expect(
    page.getByRole("heading", {
      name: "Build the audience that owns your inbox.",
    }),
  ).toBeVisible();
  await settleSubscriberReconnect(page);
  await settle(page);
  await expect(page).toHaveScreenshot("subscribers-directory-empty-light.png");
});

test("visual: narrow light directory at 200% equivalent pressure", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await openSubscribers(page, bootApp, setTheme, { theme: "light" });
  await expectNoDocumentOverflow(page);
  await settleSubscriberReconnect(page);
  await settle(page);
  await expect(page).toHaveScreenshot("subscribers-directory-narrow-light.png");
});

test("visual: single-subscriber quality review in dark", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSubscribers(page, bootApp, setTheme, {
    theme: "dark",
    overrides: {
      "/api/v1/email-validation/check": {
        email: "quality-risk@example.test",
        valid: false,
        verdict: "disposable",
        has_mx: true,
        disposable: true,
        role_account: false,
        reasons: ["Disposable mailbox provider", "Short-lived address"],
      },
    },
  });
  await page
    .getByRole("button", { name: "Add subscriber", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add subscriber" });
  const email = dialog.getByLabel("Email");
  await email.fill("quality-risk@example.test");
  await email.blur();
  await expect(
    dialog.getByRole("group", { name: "Deliverability warning" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add subscriber" }),
  ).toBeDisabled();
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-add-single-quality-warning-dark.png",
  );
});

test("visual: paste-subscriber review in light", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 960, height: 760 });
  await openSubscribers(page, bootApp, setTheme, { theme: "light" });
  await page
    .getByRole("button", { name: "Add subscriber", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add subscriber" });
  await dialog.getByRole("tab", { name: /Paste a list/ }).click();
  const addresses = dialog.getByLabel("Subscriber addresses");
  const addressInput =
    "ada@example.test\ngrace@example.test\nADA@example.test\nkatherine@example.test";
  await addresses.fill(addressInput);
  const tags = dialog.getByLabel("Shared tags");
  await tags.fill("newsletter, july-review");
  await expect(dialog.getByText("3 addresses detected")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add 3 pasted" }),
  ).toBeEnabled();
  await expect(addresses).toHaveValue(addressInput);
  await expect(tags).toHaveValue("newsletter, july-review");
  await tags.focus();
  await expect(tags).toBeFocused();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-add-paste-review-light.png",
  );
});

test("visual: audience field schema populated and usage-locked in dark", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "rules",
    theme: "dark",
  });
  const dialog = await openAudienceFieldsDialog(page);
  const usedField = dialog.locator(".merge-schema-row").filter({
    hasText: "FNAME",
  });
  await expect(usedField.getByText("8,642", { exact: true })).toBeVisible();
  await expect(usedField.getByLabel("Type")).toBeDisabled();
  await expect(
    usedField.getByRole("button", { name: "Remove" }),
  ).toBeDisabled();
  await expect(
    usedField.getByText(/Type and deletion are locked/),
  ).toBeVisible();
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-audience-fields-populated-dark.png",
  );
});

test("visual: audience field schema empty in light", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "rules",
    theme: "light",
    overrides: {
      "/api/v1/merge-fields/schema": { items: [] },
    },
  });
  const dialog = await openAudienceFieldsDialog(page);
  await expect(dialog.getByText("No audience fields yet")).toBeVisible();
  await expect(
    dialog
      .getByRole("region", { name: "Schema summary" })
      .getByText("0", { exact: true })
      .first(),
  ).toBeVisible();
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-audience-fields-empty-light.png",
  );
});

test("visual: audience field schema unavailable at 880 by 560", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const schemaPath = "/api/v1/merge-fields/schema";
  await page.setViewportSize({ width: 880, height: 560 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "rules",
    theme: "dark",
    unavailablePaths: [schemaPath],
  });
  allowExpectedFailure(page, schemaPath);
  const dialog = await openAudienceFieldsDialog(page);
  await expect(dialog.getByText("Schema unavailable")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add field" }),
  ).toBeDisabled();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-audience-fields-unavailable-narrow-dark.png",
  );
});

test("visual: populated subscriber workspaces", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(60_000);
  await openSubscribers(page, bootApp, setTheme, { theme: "dark" });

  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(
    page.getByRole("region", { name: "Audience growth" }),
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot(
    "subscribers-insights-populated-dark.png",
  );

  await page.getByRole("tab", { name: /Segments/ }).click();
  await expect(
    page.getByRole("heading", { name: "High-intent newsletter readers" }),
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot(
    "subscribers-segments-populated-dark.png",
  );

  await page.getByRole("tab", { name: "Governance" }).click();
  await expect(
    page.getByRole("region", { name: "Shadow-PII findings" }),
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot(
    "subscribers-governance-populated-dark.png",
  );

  await page.getByRole("tab", { name: "Rules & fields" }).click();
  await expect(
    page.getByRole("heading", { name: "Audience field schema" }),
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("subscribers-rules-populated-dark.png");
});

test("visual: natural-language audience studio review", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1180, height: 1_400 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "segments",
    theme: "dark",
  });
  const studio = page.getByRole("region", {
    name: "Turn an idea into exact, inspectable rules",
  });
  await studio.scrollIntoViewIfNeeded();
  await studio
    .getByRole("textbox", { name: "Natural language segment description" })
    .fill("Readers who opened in the last 7 days");
  await studio.getByRole("button", { name: /Build with rules/ }).click();
  await expect(studio.getByText("438")).toBeVisible();
  await expect(studio.getByText("Identity-safe")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(studio).toHaveScreenshot(
    "subscribers-audience-copilot-reviewed-dark.png",
  );
});

test("visual: Shadow-PII queue is provenance-rich, narrow-safe, and forced-color legible", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1180, height: 1_000 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "governance",
    theme: "dark",
  });
  const card = page.getByRole("region", { name: "Shadow-PII findings" });
  await expect(card.getByText("2", { exact: true })).toBeVisible();
  await settle(page);
  await expect(card).toHaveScreenshot("subscribers-shadow-pii-card-dark.png");
  await card.getByRole("button", { name: "Review findings" }).click();
  const dialog = page.getByRole("dialog", { name: "Shadow-PII review queue" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("custom_fields.legacy_identifier"),
  ).toBeVisible();
  await expect(dialog.getByText("Privacy-safe review boundary")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-shadow-pii-queue-dark.png",
  );

  await page.setViewportSize({ width: 680, height: 900 });
  await expect(dialog).toBeVisible();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-shadow-pii-queue-narrow-dark.png",
  );

  await setTheme(page, "light");
  await page.setViewportSize({ width: 440, height: 700 });
  await expect(dialog).toBeVisible();
  await expectNoDocumentOverflow(page);
  const safeSearch = dialog.getByLabel("Safe metadata search");
  await safeSearch.scrollIntoViewIfNeeded();
  await safeSearch.focus();
  await expect(safeSearch).toBeFocused();
  const searchBox = await safeSearch.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((searchBox?.x ?? 441) + (searchBox?.width ?? 0)).toBeLessThanOrEqual(
    440,
  );
  await settle(page);
  await expect(dialog).toHaveScreenshot(
    "subscribers-shadow-pii-queue-zoom-proxy-light.png",
  );

  await setTheme(page, "dark");
  await page.setViewportSize({ width: 1100, height: 900 });
  await dialog.getByLabel("Status").selectOption("reviewed");
  await expect(dialog.getByText("ticket:DPO-412")).toBeVisible();
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await dialog.locator(".modal-body").evaluate((body) => {
    body.scrollTop = body.scrollHeight;
  });
  await settle(page);
  const receipt = dialog.locator(".pii-receipt").last();
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toHaveScreenshot(
    "subscribers-shadow-pii-queue-forced-colors.png",
  );
});

test("visual: natural-language audience studio narrow", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 560, height: 1_600 });
  await openSubscribers(page, bootApp, setTheme, {
    tab: "segments",
    theme: "light",
  });
  const studio = page.getByRole("region", {
    name: "Turn an idea into exact, inspectable rules",
  });
  await studio.scrollIntoViewIfNeeded();
  await studio
    .getByRole("textbox", { name: "Natural language segment description" })
    .fill("Readers who opened in the last 7 days");
  await studio.getByRole("button", { name: /Build with rules/ }).click();
  await expect(studio.getByText("438")).toBeVisible();
  await expectNoDocumentOverflow(page);
  await settle(page);
  await expect(studio).toHaveScreenshot(
    "subscribers-audience-copilot-reviewed-narrow-light.png",
  );
});

test("visual: populated subscriber detail groups", async ({
  page,
  bootApp,
  setTheme,
}) => {
  test.setTimeout(60_000);
  const unavailablePaths = [
    "/api/v1/subscribers/sub-ada/pii-findings",
    "/api/v1/subscribers/sub-ada/segment-membership",
    "/api/v1/subscribers/sub-ada/decision-explanations",
  ];
  await openSubscribers(page, bootApp, setTheme, {
    theme: "dark",
    unavailablePaths,
  });
  for (const path of unavailablePaths) allowExpectedFailure(page, path);
  await settleSubscriberReconnect(page);

  await page
    .getByRole("button", { name: "Open ada.lovelace@example.test" })
    .click();
  const detail = page.getByRole("dialog", {
    name: "ada.lovelace@example.test",
  });
  await expect(detail).toBeVisible({ timeout: 20_000 });
  const groups = detail.getByRole("tablist", {
    name: "Subscriber detail groups",
  });

  await groups.getByRole("tab", { name: "Summary", exact: true }).click();
  await expect(
    detail
      .getByRole("tablist", { name: "Summary sections" })
      .getByRole("tab", { name: "Profile", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    detail.getByText("Some profile graph data couldn't be loaded.", {
      exact: false,
    }),
  ).toBeVisible({ timeout: 15_000 });
  await detail.locator(".slideover-body").evaluate((body) => {
    const groupTabs = body.querySelector<HTMLElement>(
      ".subscriber-detail-group-tabs",
    );
    if (!groupTabs) return;
    body.scrollTop +=
      groupTabs.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await settle(page);
  await expect(detail).toHaveScreenshot("subscriber-detail-summary-dark.png");

  await groups.getByRole("tab", { name: "Consent", exact: true }).click();
  await expect(
    detail.getByText("Subject Access Request (GDPR Article 15 / CCPA)"),
  ).toBeVisible();
  await detail.locator(".slideover-body").evaluate((body) => {
    const groupTabs = body.querySelector<HTMLElement>(
      ".subscriber-detail-group-tabs",
    );
    if (!groupTabs) return;
    body.scrollTop +=
      groupTabs.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await settle(page);
  await expect(detail).toHaveScreenshot(
    "subscriber-detail-consent-privacy-dark.png",
  );

  await groups.getByRole("tab", { name: "Governance", exact: true }).click();
  const governanceSections = detail.getByRole("tablist", {
    name: "Governance sections",
  });
  await governanceSections
    .getByRole("tab", { name: "PII Findings", exact: true })
    .click();
  await expect(
    detail.getByText("Couldn’t verify findings", { exact: true }),
  ).toBeVisible();
  await governanceSections
    .getByRole("tab", { name: "Segment Decisions", exact: true })
    .click();
  await expect(
    governanceSections.getByRole("tab", {
      name: /Segment Decisions.*Unavailable/,
    }),
  ).toBeVisible();
  await detail.locator(".slideover-body").evaluate((body) => {
    const groupTabs = body.querySelector<HTMLElement>(
      ".subscriber-detail-group-tabs",
    );
    if (!groupTabs) return;
    body.scrollTop +=
      groupTabs.getBoundingClientRect().top - body.getBoundingClientRect().top;
  });
  await settle(page);
  await expect(detail).toHaveScreenshot(
    "subscriber-detail-governance-unavailable-dark.png",
  );
});
