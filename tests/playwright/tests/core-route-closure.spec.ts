import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const CAMPAIGN_ID = "closure-campaign";
const FORM_ID = "closure-form";
const SEGMENT_ID = "closure-segment";
const OTHER_SEGMENT_ID = "closure-segment-other";
const TOPIC_ID = "closure-topic";
const WEBHOOK_ID = "closure-webhook";
const DELIVERY_ID = 401;
const TEMPLATE_NAME = "Core route closure fixture";
const TENANT_HEADERS = { "X-Tenant-Slug": "demo" };
const BLOCKING_IMPACTS = new Set(["critical", "serious"]);
const SANDBOX_SERVICE_WORKER_PROBE_ERROR =
  "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.";
const SANDBOX_INIT_SCRIPT_BLOCKED_ERROR =
  "Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed and the 'allow-scripts' permission is not set.";
const CORE_ROUTE_FILTER = process.env.POSTWAVE_CORE_ROUTE_FILTER?.trim();

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  tenant_id: "closure-tenant",
  name: "Lifecycle experiment",
  subject: "A useful product update",
  status: "draft",
  campaign_type: "ab_test",
  created_at: "2026-08-20T09:00:00Z",
  updated_at: "2026-08-21T09:00:00Z",
};

const AB_VIEW = {
  settings: {
    campaign_id: CAMPAIGN_ID,
    winner_metric: "open_rate",
    evaluation_window_hours: 24,
    winner_recipients_pct: 100,
    sample_pct: 40,
    bandit_strategy: "fixed",
    explore_floor: 0.1,
    recompute_interval_minutes: 30,
  },
  variants: [
    {
      id: "variant-a",
      campaign_id: CAMPAIGN_ID,
      variant_label: "A",
      subject: "The control subject",
      body_html: "<p>Control</p>",
      weight: 50,
    },
    {
      id: "variant-b",
      campaign_id: CAMPAIGN_ID,
      variant_label: "B",
      subject: "The challenger subject",
      body_html: "<p>Challenger</p>",
      weight: 50,
    },
  ],
  results: [
    {
      variant_id: "variant-a",
      recipients_count: 500,
      delivered: 490,
      opens: 210,
      clicks: 60,
      unsubscribes: 1,
      complaints: 0,
      winner: false,
    },
    {
      variant_id: "variant-b",
      recipients_count: 500,
      delivered: 492,
      opens: 245,
      clicks: 73,
      unsubscribes: 0,
      complaints: 0,
      winner: true,
    },
  ],
  winner_variant_id: "variant-b",
};

const FORM = {
  id: FORM_ID,
  tenantId: "closure-tenant",
  slug: "core-route-closure",
  name: "Newsletter signup",
  optInMode: "double",
  status: "draft",
  structure: {
    fields: [
      {
        id: "heading",
        kind: "heading",
        label: "Join the newsletter",
        required: false,
        content: "Join the newsletter",
      },
      {
        id: "email",
        kind: "email",
        label: "Email address",
        placeholder: "you@example.com",
        required: true,
      },
      {
        id: "submit",
        kind: "submit",
        label: "Subscribe",
        required: false,
      },
    ],
  },
  settings: {
    successMessage: "Check your inbox to confirm.",
    confirmationSubject: "Confirm your subscription",
    confirmationBody: "Open {{confirm_url}} to confirm.",
    tagsOnSubmit: ["closure"],
    styleClass: "closure-form",
  },
  createdAt: "2026-08-20T09:00:00Z",
  updatedAt: "2026-08-21T09:00:00Z",
};

const SEGMENT = {
  id: SEGMENT_ID,
  tenantId: "closure-tenant",
  name: "Engaged readers",
  description: "Readers who opened a recent campaign.",
  queryAst: {
    op: "condition",
    field: "email",
    comparator: "contains",
    value: "@",
  },
  lastCount: 248,
  lastEvaluatedAt: "2026-08-21T09:00:00Z",
  includeArchived: false,
  createdAt: "2026-08-20T09:00:00Z",
  updatedAt: "2026-08-21T09:00:00Z",
};

const OTHER_SEGMENT = {
  ...SEGMENT,
  id: OTHER_SEGMENT_ID,
  name: "Recent customers",
  description: "Customers with a recent conversion.",
  lastCount: 180,
};

const TOPIC = {
  id: TOPIC_ID,
  tenantId: "closure-tenant",
  slug: "product-news",
  name: "Product news",
  description: "Important product announcements.",
  defaultOptIn: false,
  displayOrder: 1,
  createdAt: "2026-08-20T09:00:00Z",
  updatedAt: "2026-08-21T09:00:00Z",
};

const DELIVERY = {
  id: DELIVERY_ID,
  webhookId: WEBHOOK_ID,
  event: "subscriber.created",
  statusCode: 202,
  attempt: 1,
  responseMs: 84,
  at: "2026-08-21T09:00:00Z",
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installClientFixtures(page: Page) {
  await page.route("**/api/v1/auth/me", async (route) => {
    await fulfillJson(route, {
      user_id: "closure-user",
      tenant_id: "closure-tenant",
      email: "owner@example.test",
      role: "owner",
      effective_role: "owner",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Closure workspace",
      workspace_slug: "demo",
    });
  });

  await page.route(`**/api/v1/campaigns/${CAMPAIGN_ID}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/ab-results")) {
      await fulfillJson(route, {
        campaign_id: CAMPAIGN_ID,
        metric:
          new URL(route.request().url()).searchParams.get("metric") ??
          "open_rate",
        variants: [
          {
            id: "variant-a",
            variant_index: 0,
            variant_label: "A",
            subject: "The control subject",
            sent: 500,
            hits: 210,
            rate: 0.42,
            is_control: true,
          },
          {
            id: "variant-b",
            variant_index: 1,
            variant_label: "B",
            subject: "The challenger subject",
            sent: 500,
            hits: 245,
            rate: 0.49,
            is_control: false,
          },
        ],
        frequentist: {
          "0:1": {
            z_score: 2.23,
            p_value: 0.026,
            lift_percent: 16.7,
            significant_at_95: true,
            significant_after_correction: true,
          },
        },
        bayesian: {
          "0:1": {
            prob_b_better: 0.972,
            expected_lift: 0.167,
            credible_interval_95: [0.02, 0.29],
          },
        },
        bonferroni: {
          num_comparisons: 1,
          family_alpha: 0.05,
          corrected_alpha: 0.05,
          applied_to_frequentist: true,
        },
        winner: {
          variant_index: 1,
          variant_id: "variant-b",
          method: "bayesian",
          confidence: 0.972,
        },
      });
      return;
    }
    if (pathname.endsWith("/ab-weight-history")) {
      await fulfillJson(route, {
        campaign_id: CAMPAIGN_ID,
        series: [
          {
            variant_id: "variant-a",
            label: "A",
            points: [{ at: "2026-08-21T09:00:00Z", weight: 50 }],
          },
          {
            variant_id: "variant-b",
            label: "B",
            points: [{ at: "2026-08-21T09:00:00Z", weight: 50 }],
          },
        ],
      });
      return;
    }
    if (pathname.endsWith("/ab/evaluate")) {
      await fulfillJson(route, AB_VIEW);
      return;
    }
    if (pathname.endsWith("/ab")) {
      await fulfillJson(route, AB_VIEW);
      return;
    }
    await fulfillJson(route, CAMPAIGN);
  });

  await page.route(`**/api/v1/forms/${FORM_ID}**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/analytics")) {
      await fulfillJson(route, {
        form_id: FORM_ID,
        days: 30,
        visits: [
          { date: "2026-08-20", count: 18 },
          { date: "2026-08-21", count: 24 },
        ],
        visits_total: 42,
      });
      return;
    }
    if (pathname.endsWith("/variants/promotions")) {
      await fulfillJson(route, []);
      return;
    }
    if (pathname.endsWith("/variants")) {
      await fulfillJson(route, []);
      return;
    }
    await fulfillJson(route, FORM);
  });
  await page.route("**/api/v1/forms", async (route) => {
    await fulfillJson(route, [
      {
        ...FORM,
        submissions30d: 12,
        visits30d: 42,
        conversionRate: 28.6,
      },
    ]);
  });
  await page.route("**/api/v1/audit**", async (route) => {
    await fulfillJson(route, { rows: [], nextCursor: undefined });
  });

  await page.route("**/api/v1/subscribers/duplicates**", async (route) => {
    await fulfillJson(route, {
      scan: {
        scan_id: "closure-scan",
        status: "complete",
        subscriber_count: 320,
        candidate_count: 1,
        created_at: "2026-08-21T09:00:00Z",
        expires_at: "2026-08-22T09:00:00Z",
        complete: true,
      },
      pairs: [
        {
          primary_id: "subscriber-primary",
          primary_email: "reader@example.test",
          duplicate_id: "subscriber-duplicate",
          duplicate_email: "reader+news@example.test",
          primary_updated_at: "2026-08-20T09:00:00Z",
          duplicate_updated_at: "2026-08-20T10:00:00Z",
          kind: "plus_alias",
          confidence: 0.94,
          evidence: [
            {
              kind: "plus alias",
              confidence: 0.94,
              reason: "Same base address",
            },
          ],
          stale: false,
        },
      ],
      count: 1,
      complete: true,
    });
  });

  await page.route("**/api/v1/merge/apply", async (route) => {
    const body = route.request().postDataJSON() as { dry_run?: boolean };
    await fulfillJson(route, {
      primary_id: "subscriber-primary",
      duplicate_id: "subscriber-duplicate",
      dry_run: body.dry_run === true,
      plan: {
        tags: ["reader"],
        custom_fields: {},
        status: "enabled",
        gdpr_permissions: [],
        conflicts: [],
        preserved_on_duplicate: [],
      },
      events_moved: 3,
      suppressions_moved: 0,
      loser_soft_deleted: true,
      primary_updated_at: "2026-08-21T09:00:00Z",
      duplicate_updated_at: "2026-08-21T09:00:00Z",
      plan_fingerprint: "closure-fingerprint",
    });
  });

  await page.route("**/api/v1/subscriber-imports/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/preview")) {
      await fulfillJson(route, {
        id: "closure-import",
        status: "mapping",
        mapping: {
          path: "closure.csv",
          headers: ["email", "name"],
          columns: [
            { index: 0, name: "email", kind: "email" },
            { index: 1, name: "name", kind: "name" },
          ],
          rows: 2,
        },
        sample_rows: [
          { email: "ada@example.test", name: "Ada" },
          { email: "grace@example.test", name: "Grace" },
        ],
        rows_total: 2,
        rows_new: 1,
        rows_existing: 1,
        rows_file_dupes: 0,
        on_existing: "skip",
        configuration_revision: 1,
      });
      return;
    }
    if (pathname.endsWith("/remap-options")) {
      await fulfillJson(route, {
        merge_fields: [
          { kind: "email", label: "Email (required)" },
          { kind: "name", label: "Name" },
          { kind: "ignore", label: "Skip this column" },
        ],
        custom_fields: [],
      });
      return;
    }
    if (pathname.endsWith("/confirm")) {
      await fulfillJson(route, {
        id: "closure-import",
        status: "ready",
        dry_run_results: {
          rows_total: 2,
          would_create: 1,
          would_update: 0,
          would_skip: 1,
          would_fail: 0,
          file_dupes: 0,
          rows: [
            { row_number: 2, outcome: "create" },
            { row_number: 3, outcome: "skip" },
          ],
          detail_capped: false,
        },
      });
      return;
    }
    if (route.request().method() === "PATCH") {
      await fulfillJson(route, {
        id: "closure-import",
        status: "mapping",
        updated: true,
        configuration_revision: 2,
      });
      return;
    }
    await route.fallback();
  });

  await page.route(
    "**/api/v1/subscriber-imports/remap-options",
    async (route) => {
      await fulfillJson(route, {
        merge_fields: [
          { kind: "email", label: "Email (required)" },
          { kind: "name", label: "Name" },
          { kind: "ignore", label: "Skip this column" },
        ],
        custom_fields: [],
      });
    },
  );

  await page.route("**/api/v1/custom-fields", async (route) => {
    await fulfillJson(route, []);
  });
  await page.route("**/api/v1/lists**", async (route) => {
    await fulfillJson(route, []);
  });
  await page.route("**/api/v1/segments**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/v1/segments/preview") {
      await fulfillJson(route, {
        count: 248,
        workspace_total: 1000,
        workspace_percentage: 24.8,
        generated_at: "2026-08-21T09:00:00Z",
        archive_scope: "active_only",
        applied_exclusions: [],
      });
      return;
    }
    if (pathname === "/api/v1/segments/predicate-registry") {
      await fulfillJson(route, {
        registry_version: "closure-v1",
        boolean_ops: ["and", "or", "not"],
        predicates: [],
        metrics: [],
        custom_objects: [],
      });
      return;
    }
    if (pathname === "/api/v1/segments/overlap") {
      await fulfillJson(route, {
        a: SEGMENT_ID,
        b: OTHER_SEGMENT_ID,
        a_count: 248,
        b_count: 180,
        intersection: 72,
        jaccard: 0.202,
      });
      return;
    }
    if (pathname === "/api/v1/segments") {
      await fulfillJson(route, [SEGMENT, OTHER_SEGMENT]);
      return;
    }
    if (pathname.endsWith("/usage")) {
      await fulfillJson(route, { items: [], count: 0 });
      return;
    }
    if (pathname.endsWith("/size-history")) {
      await fulfillJson(route, {
        segment_id: SEGMENT_ID,
        window_days: 90,
        series: [
          { evaluated_at: "2026-08-14T09:00:00Z", count: 221 },
          { evaluated_at: "2026-08-21T09:00:00Z", count: 248 },
        ],
      });
      return;
    }
    if (pathname.endsWith("/engagement-summary")) {
      await fulfillJson(route, {
        segment_id: SEGMENT_ID,
        window_days: 30,
        member_count: 248,
        sends: 820,
        opens: 410,
        clicks: 104,
        unsubs: 2,
        bounces: 3,
        complaints: 0,
        open_rate: 0.5,
        click_rate: 0.127,
        unsub_rate: 0.0024,
        rate_basis: "delivered",
        generated_at: "2026-08-21T09:00:00Z",
      });
      return;
    }
    if (pathname.endsWith("/definition-history")) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (pathname.endsWith("/snapshots")) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (pathname.endsWith("/decay-events")) {
      await fulfillJson(route, { items: [] });
      return;
    }
    if (pathname.endsWith("/pnl")) {
      await fulfillJson(route, {
        segment_id: SEGMENT_ID,
        member_count: 248,
        window_days: 30,
        currency: "USD",
        revenue_cents: 125000,
        revenue_conversions: 22,
        revenue_per_member_cents: 504,
        revenue_scope: "attributed",
        aov_cents: 5682,
        aov_order_count: 22,
        aov_currency: "USD",
        clv_members_scored: 220,
        clv_historic_sum_cents: 180000,
        clv_predicted_sum_cents: 230000,
        clv_realised_vs_predicted: 0.78,
        unsub_count: 2,
        complaint_count: 0,
        total_cost_cents: 9200,
        cost_currency: "USD",
        cost_config_present: true,
        net_contribution_cents: 115800,
        net_contribution_per_member_cents: 467,
        lift: null,
        sequence_attribution_unsupported: false,
        cross_currency_revenue_excluded: false,
        generated_at: "2026-08-21T09:00:00Z",
      });
      return;
    }
    if (pathname === `/api/v1/segments/${OTHER_SEGMENT_ID}`) {
      await fulfillJson(route, OTHER_SEGMENT);
      return;
    }
    await fulfillJson(route, SEGMENT, 200);
  });

  await page.route("**/api/v1/topics", async (route) => {
    await fulfillJson(route, [TOPIC]);
  });

  await page.route("**/api/v1/webhooks**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/deliveries/${DELIVERY_ID}`)) {
      await fulfillJson(route, {
        ...DELIVERY,
        requestBody: JSON.stringify({
          id: "event-closure",
          type: "subscriber.created",
          data: { email: "reader@example.test" },
        }),
        payloadRetained: true,
      });
      return;
    }
    if (pathname.endsWith("/deliveries")) {
      await fulfillJson(route, [DELIVERY]);
      return;
    }
    await fulfillJson(route, [
      {
        id: WEBHOOK_ID,
        tenantId: "closure-tenant",
        url: "https://hooks.example.test/postwave",
        events: ["subscriber.created"],
        status: "active",
        createdAt: "2026-08-20T09:00:00Z",
        updatedAt: "2026-08-21T09:00:00Z",
        lastDelivery: DELIVERY,
      },
    ]);
  });
}

async function findTemplate(page: Page) {
  const response = await page.request.get(
    `/api/v1/campaign-templates/search?q=${encodeURIComponent(TEMPLATE_NAME)}&source=mine&kind=editable&archived=active&per_page=20`,
    { headers: TENANT_HEADERS },
  );
  if (!response.ok()) return null;
  const payload = (await response.json()) as {
    items?: Array<{ id: string; name: string }>;
  };
  return payload.items?.find((item) => item.name === TEMPLATE_NAME) ?? null;
}

async function ensureTemplate(page: Page) {
  const existing = await findTemplate(page);
  if (existing) return existing;
  const response = await page.request.post("/api/v1/campaign-templates", {
    headers: TENANT_HEADERS,
    data: {
      slug: "core-route-closure-fixture",
      name: TEMPLATE_NAME,
      subject: "A deterministic closure subject",
      description: "Browser certification fixture for strict route closure.",
      body_html:
        "<!doctype html><html><body><main><h1>Closure newsletter</h1><p>Deterministic browser fixture.</p></main></body></html>",
      tags: ["playwright", "closure"],
      goal: "newsletter",
    },
  });
  if (!response.ok() && response.status() !== 409) {
    throw new Error(
      `Template fixture create failed (${response.status()}): ${await response.text()}`,
    );
  }
  await expect
    .poll(async () => (await findTemplate(page))?.id, {
      message: "closure template should become searchable",
      timeout: 15_000,
    })
    .toBeTruthy();
  return (await findTemplate(page))!;
}

async function settleRoute(page: Page) {
  await page
    .locator('[data-slot="page-transition"]')
    .evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => undefined);
}

async function gotoRoute(
  page: Page,
  path: string,
  heading: string,
  detailHeading?: string,
) {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  expect(response?.status(), `${path}: document response`).toBeLessThan(400);
  await expect(
    page.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toHaveCount(1, { timeout: 30_000 });
  if (detailHeading) {
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: detailHeading,
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
  }
  await settleRoute(page);
}

function hasScriptFreeSandboxPreview(path: string): boolean {
  return (
    path === `/app/forms/${FORM_ID}` ||
    path === `/app/forms/${FORM_ID}/embed` ||
    /^\/app\/templates\/[^/]+\/(?:edit|preview)$/u.test(path)
  );
}

async function auditRoute(page: Page, path: string, mobile: boolean) {
  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("main#main-content");
    const root = main?.querySelector<HTMLElement>(
      '[data-slot="page-transition"]',
    );
    const undersized = Array.from(
      root?.querySelectorAll<HTMLElement>(
        "button, a[href], summary, input, select, textarea",
      ) ?? [],
    )
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !element.matches(":disabled")
        );
      })
      .map((element) => {
        const hitTarget =
          element instanceof HTMLInputElement
            ? (element.closest<HTMLElement>("label") ?? element)
            : element;
        const rect = hitTarget.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ??
            element.getAttribute("title") ??
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 70) ??
            element.tagName,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter(({ width, height }) => width < 24 || height < 24);
    const mainRect = main?.getBoundingClientRect();
    const overflowElements = Array.from(
      root?.querySelectorAll<HTMLElement>("*") ?? [],
    )
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 70) ??
            "",
          className:
            typeof element.className === "string"
              ? element.className.slice(0, 160)
              : "",
          right: Math.round(rect.right * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          ownOverflow: element.scrollWidth - element.clientWidth,
        };
      })
      .filter(
        ({ right, ownOverflow }) =>
          (mainRect != null && right > mainRect.right + 1) || ownOverflow > 1,
      )
      .sort((a, b) => b.right - a.right || b.ownOverflow - a.ownOverflow)
      .slice(0, 12);
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: document.querySelectorAll("h1").length,
      documentOverflow:
        document.documentElement.scrollWidth - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      overflowElements,
      undersized,
    };
  });
  expect.soft(layout.mainCount, `${path}: one main landmark`).toBe(1);
  expect.soft(layout.h1Count, `${path}: one h1`).toBe(1);
  expect
    .soft(layout.documentOverflow, `${path}: document overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      layout.mainOverflow,
      `${path}: dashboard main overflow ${JSON.stringify(layout.overflowElements, null, 2)}`,
    )
    .toBeLessThanOrEqual(1);
  if (mobile) {
    expect.soft(layout.undersized, `${path}: undersized targets`).toEqual([]);
  }

  const axeBuilder = new AxeBuilder({ page })
    .include("main#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  // The form/template previews deliberately use sandbox="" and therefore an
  // opaque origin. Axe's partial-run frame messenger can wait indefinitely for
  // a sandbox that cannot execute its injected script. Legacy mode audits the
  // requested main landmark without cross-origin frame messaging; the route
  // matrix separately proves that these preview frames remain script-free.
  if (hasScriptFreeSandboxPreview(path)) axeBuilder.setLegacyMode(true);
  const axe = await axeBuilder.analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect
    .soft(blocking, `${path}: ${JSON.stringify(blocking, null, 2)}`)
    .toEqual([]);
}

async function expectDialogQuality(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    const finiteAnimations = element
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      });
    await Promise.all(
      finiteAnimations.map((animation) =>
        animation.finished.catch(() => undefined),
      ),
    );
  });
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect.soft(geometry.left).toBeGreaterThanOrEqual(0);
  expect.soft(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect.soft(geometry.top).toBeGreaterThanOrEqual(0);
  expect.soft(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.describe("strict core route closure", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
    await installClientFixtures(page);
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: all 12 omitted routes are contained and accessible`, async ({
      page,
    }) => {
      const expectsMobileProject = viewport.label !== "desktop";
      test.skip(
        (test.info().project.name === "chromium-mobile") !==
          expectsMobileProject,
        "Desktop owns the wide matrix; mobile Chromium owns both narrow matrices.",
      );
      test.slow();
      // The route matrix deliberately runs axe, overflow, touch-target, and
      // console diagnostics on twelve independently hydrated pages. A cold
      // narrow-viewport run can exceed seven minutes before the final routes
      // even begin, which aborts an otherwise healthy navigation and masks the
      // remaining assertions. Keep one shared matrix, but give it enough time
      // to finish under development-server compilation load.
      test.setTimeout(720_000);
      await page.setViewportSize(viewport);
      const template =
        CORE_ROUTE_FILTER && !CORE_ROUTE_FILTER.includes("/templates/")
          ? { id: "unused-filtered-template" }
          : await ensureTemplate(page);
      const routes: ReadonlyArray<{
        path: string;
        heading: string;
        detailHeading?: string;
      }> = [
        { path: `/app/campaigns/${CAMPAIGN_ID}/ab`, heading: "A/B test" },
        {
          path: `/app/campaigns/${CAMPAIGN_ID}/ab-results`,
          heading: "A/B results",
        },
        { path: `/app/forms/${FORM_ID}`, heading: `Edit form: ${FORM.name}` },
        { path: `/app/forms/${FORM_ID}/embed`, heading: "Embed" },
        { path: "/app/subscribers/duplicates", heading: "Duplicate contacts" },
        { path: "/app/subscribers/import", heading: "Import subscribers" },
        {
          path: `/app/subscribers/segments/${SEGMENT_ID}`,
          heading: SEGMENT.name,
        },
        {
          path: `/app/subscribers/segments/${SEGMENT_ID}/edit`,
          heading: "Edit segment",
        },
        {
          path: `/app/templates/${template.id}/edit`,
          heading: "Edit template",
        },
        {
          path: `/app/templates/${template.id}/preview`,
          heading: "Inbox client preview",
        },
        {
          path: `/app/settings/topics/${TOPIC_ID}/edit`,
          heading: "Topics",
          detailHeading: "Edit topic",
        },
        {
          path: `/app/settings/webhooks/${WEBHOOK_ID}/deliveries`,
          heading: "Webhooks",
          detailHeading: "Webhook deliveries",
        },
      ];

      const auditedRoutes = CORE_ROUTE_FILTER
        ? routes.filter(({ path }) => path.includes(CORE_ROUTE_FILTER))
        : routes;
      expect(
        auditedRoutes.length,
        `No core route matched POSTWAVE_CORE_ROUTE_FILTER=${CORE_ROUTE_FILTER}`,
      ).toBeGreaterThan(0);

      for (const { path, heading, detailHeading } of auditedRoutes) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (message: { type(): string; text(): string }) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        };
        const onPageError = (error: Error) => pageErrors.push(error.message);
        page.on("console", onConsole);
        page.on("pageerror", onPageError);
        await gotoRoute(page, path, heading, detailHeading);
        await auditRoute(page, path, viewport.width <= 375);
        const sandboxPreview = hasScriptFreeSandboxPreview(path);
        if (sandboxPreview) {
          const frames = page.locator("iframe[sandbox][srcdoc]");
          await expect(frames.first()).toBeAttached();
          const authoredScripts = await frames.evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute("srcdoc") ?? "")
              .filter((source) => /<script(?:\s|>)/iu.test(source)),
          );
          expect
            .soft(
              authoredScripts,
              `${path}: filtered sandbox diagnostics must not mask authored scripts`,
            )
            .toEqual([]);
        }
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        const appErrors = consoleErrors.filter(
          (message) =>
            !message.includes("Failed to load resource") &&
            !(sandboxPreview && message === SANDBOX_INIT_SCRIPT_BLOCKED_ERROR),
        );
        const appPageErrors = pageErrors.filter(
          (message) =>
            !(sandboxPreview && message === SANDBOX_SERVICE_WORKER_PROBE_ERROR),
        );
        // `serviceWorkers: "block"` and this suite's auth/fixture init scripts
        // are injected into every frame by Playwright. The script-free preview
        // iframes above intentionally use sandbox="" (no scripts and an opaque
        // origin), so Chromium rejects those automation probes. Match both the
        // known routes and exact browser diagnostics; every other error stays
        // strict.
        expect.soft(appPageErrors, `${path}: page errors`).toEqual([]);
        expect.soft(appErrors, `${path}: console errors`).toEqual([]);
      }
    });
  }

  test("375px: campaign experiment tabs and evaluation dialog stay operable", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoRoute(page, `/app/campaigns/${CAMPAIGN_ID}/ab`, "A/B test");
    const tabs = page.getByRole("tablist", {
      name: "Campaign experiment section",
    });
    await tabs.getByRole("tab", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\?tab=settings/u);
    await tabs.getByRole("tab", { name: "Results" }).click();
    await expect(page).toHaveURL(/\?tab=results/u);
    const evaluate = page.getByRole("button", { name: "Evaluate winner" });
    await evaluate.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(evaluate).toBeFocused();

    await gotoRoute(
      page,
      `/app/campaigns/${CAMPAIGN_ID}/ab-results`,
      "A/B results",
    );
    await page.getByLabel("Metric").selectOption("click_rate");
    await page
      .getByRole("tablist", { name: "Experiment analysis method" })
      .getByRole("tab", { name: "Frequentist" })
      .click();
    await expect(page.getByText(/corrected α/u).first()).toBeVisible();
  });

  test("375px: form editor tabs, preview, archive, and embed controls are bounded", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoRoute(page, `/app/forms/${FORM_ID}`, `Edit form: ${FORM.name}`);
    const preview = page.getByRole("button", { name: "Preview", exact: true });
    await preview.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(preview).toBeFocused();
    const archive = page.getByRole("button", { name: "Archive", exact: true });
    await archive.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(archive).toBeFocused();
    const editorTabs = page.getByRole("tablist", {
      name: "Form editor section",
    });
    for (const tabName of [
      "Builder",
      "Design",
      "Settings",
      "Analytics",
      "A/B",
      "Activity",
    ]) {
      await editorTabs.getByRole("tab", { name: tabName, exact: true }).click();
      await expect(
        editorTabs.getByRole("tab", { name: tabName, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
    }
    await expect(page).toHaveURL(/\?tab=activity/u);

    await gotoRoute(page, `/app/forms/${FORM_ID}/embed`, "Embed");
    const embedTabs = page.getByRole("tablist", { name: "Embed code format" });
    for (const tabName of ["iframe", "JS popup", "JS inline"]) {
      await embedTabs.getByRole("tab", { name: tabName, exact: true }).click();
      await expect(
        embedTabs.getByRole("tab", { name: tabName, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
    }
    await expect(page.getByRole("button", { name: "Copy URL" })).toBeVisible();
    await auditRoute(page, `/app/forms/${FORM_ID}/embed`, true);
  });

  test("375px: duplicate review and CSV import review expose safe intermediate states", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoRoute(page, "/app/subscribers/duplicates", "Duplicate contacts");
    const review = page.getByRole("button", { name: "Review & merge" });
    await review.click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("button", { name: "Merge permanently" }),
    ).toBeEnabled();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await expect(review).toBeFocused();

    await gotoRoute(page, "/app/subscribers/import", "Import subscribers");
    await page.getByLabel("CSV file").setInputFiles({
      name: "closure.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("email,name\nada@example.test,Ada\n"),
    });
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText(/Map 2 columns/u)).toBeVisible();
    await page.getByRole("button", { name: "Preview outcome" }).click();
    await expect(page.getByText("Row preview", { exact: false })).toBeVisible();
    await page.getByRole("checkbox", { name: "Errors only" }).check();
    await expect(page.getByText("No errored rows.")).toBeVisible();
    await auditRoute(page, "/app/subscribers/import (review)", true);
  });

  test("375px: segment comparison and destructive/discard dialogs restore focus", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoRoute(
      page,
      `/app/subscribers/segments/${SEGMENT_ID}`,
      SEGMENT.name,
    );
    await page
      .getByLabel("Compare with segment")
      .selectOption(OTHER_SEGMENT_ID);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(page.getByText("72", { exact: true })).toBeVisible();

    await gotoRoute(
      page,
      `/app/subscribers/segments/${SEGMENT_ID}/edit`,
      "Edit segment",
    );
    const campaignAction = page.getByRole("button", {
      name: "Use in a campaign",
      exact: true,
    });
    await campaignAction.focus();
    const actionTooltip = page.getByRole("tooltip");
    await expect(actionTooltip).toBeVisible();
    const tooltipBounds = await actionTooltip.boundingBox();
    expect(tooltipBounds).not.toBeNull();
    expect(tooltipBounds!.x).toBeGreaterThanOrEqual(8);
    expect(tooltipBounds!.x + tooltipBounds!.width).toBeLessThanOrEqual(367);
    await page.keyboard.press("Escape");
    await expect(actionTooltip).toHaveCount(0);
    await expect(campaignAction).toBeFocused();
    const deleteTrigger = page.getByRole("button", {
      name: "Delete",
      exact: true,
    });
    await deleteTrigger.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(deleteTrigger).toBeFocused();
    await page.getByLabel("Name").fill("Engaged readers updated");
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    // The Next dev-tools launcher occupies the lower-left corner in dev and
    // can cover this bottom-of-page action at 375px. Keyboard activation is
    // also the contract this discard flow must support and avoids testing the
    // framework overlay instead of the product control.
    await cancel.focus();
    await page.keyboard.press("Enter");
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByText("Discard unsaved changes?"),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cancel).toBeFocused();
  });

  test("375px: template authoring groups plus use and test-send dialogs are complete", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    const template = await ensureTemplate(page);
    await gotoRoute(
      page,
      `/app/templates/${template.id}/edit`,
      "Edit template",
    );
    const authoring = page.getByRole("group", { name: "Authoring surface" });
    await expect(authoring.getByRole("button")).toHaveCount(2);
    await expect(
      authoring.getByRole("button", { name: "Code / import" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("group", { name: "Source format" }),
    ).toBeVisible();

    await gotoRoute(
      page,
      `/app/templates/${template.id}/preview`,
      "Inbox client preview",
    );
    const useTemplate = page.getByRole("button", { name: "Use template" });
    await useTemplate.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(useTemplate).toBeFocused();
    const sendTest = page.getByRole("button", {
      name: "Send a test to my inbox",
    });
    await sendTest.click();
    await expectDialogQuality(page);
    await expect(page.getByLabel("Test recipient")).toHaveValue(
      "owner@example.test",
    );
    await page.keyboard.press("Escape");
    await expect(sendTest).toBeFocused();
  });

  test("375px: webhook inspection and topic validation remain truthful", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.setViewportSize({ width: 375, height: 800 });
    await gotoRoute(
      page,
      `/app/settings/webhooks/${WEBHOOK_ID}/deliveries`,
      "Webhooks",
      "Webhook deliveries",
    );
    const inspect = page.getByRole("button", { name: "Inspect", exact: true });
    await inspect.click();
    await expectDialogQuality(page);
    const payload = page.getByLabel("Retained webhook request payload");
    await expect(payload).toContainText("reader@example.test");
    await payload.focus();
    await expect(payload).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(inspect).toBeFocused();

    await gotoRoute(
      page,
      `/app/settings/topics/${TOPIC_ID}/edit`,
      "Topics",
      "Edit topic",
    );
    await page.getByLabel("Name").fill("");
    await page.getByLabel("Slug").fill("");
    await expect(page.getByText("Name is required.")).toBeVisible();
    await expect(page.getByText("Slug is required.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await auditRoute(page, `/app/settings/topics/${TOPIC_ID}/edit`, true);
  });
});

async function auditAuthStage(page: Page) {
  await settleRoute(page);
  const structure = await page.evaluate(() => ({
    mainCount: document.querySelectorAll("main#auth-main").length,
    h1Count: document.querySelectorAll("h1").length,
    overflow:
      Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ) - window.innerWidth,
  }));
  expect.soft(structure.mainCount).toBe(1);
  expect.soft(structure.h1Count).toBe(1);
  expect.soft(structure.overflow).toBeLessThanOrEqual(1);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.describe("login hidden-stage closure", () => {
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 375, height: 800 });
  });

  test("375px: workspace chooser search, selection, empty state, and focus are complete", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.route("**/api/v1/auth/login", async (route) => {
      await fulfillJson(route, {
        needs_workspace: true,
        workspaces: Array.from({ length: 7 }, (_, index) => ({
          id: `workspace-${index + 1}`,
          name: index === 5 ? "Finance team" : `Workspace ${index + 1}`,
          slug: index === 5 ? "finance" : `workspace-${index + 1}`,
        })),
      });
    });
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-login-hydrated="true"]')).toHaveCount(1);
    await page.getByLabel("Email").fill("owner@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .and(page.locator('input[type="password"]'))
      .fill("correct-horse-battery-staple");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const heading = page.getByRole("heading", { name: "Choose a workspace" });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    const search = page.getByPlaceholder("Search workspaces…");
    await search.fill("does-not-exist");
    await expect(page.getByText("No matching workspaces")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await search.fill("finance");
    await page.getByRole("radio", { name: /Finance team/u }).check();
    await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
    await auditAuthStage(page);
  });

  test("375px: cancelling a passkey prompt is quiet and returns focus", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.addInitScript(() => {
      Object.defineProperty(window, "PublicKeyCredential", {
        configurable: true,
        value: function PublicKeyCredential() {},
      });
      const credentials = navigator.credentials;
      Object.defineProperty(credentials, "create", {
        configurable: true,
        value: async () => null,
      });
      Object.defineProperty(credentials, "get", {
        configurable: true,
        value: async () => {
          throw new DOMException(
            "The request was cancelled.",
            "NotAllowedError",
          );
        },
      });
    });
    await page.route("**/api/v1/auth/webauthn/login/begin", async (route) => {
      await fulfillJson(route, {
        publicKey: {
          challenge: "AQIDBA",
          timeout: 60_000,
          userVerification: "preferred",
        },
      });
    });
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-login-hydrated="true"]')).toHaveCount(1);
    const passkey = page.getByRole("button", {
      name: "Sign in with a passkey",
    });
    await expect(passkey).toBeVisible();
    await passkey.click();
    await expect(passkey).toBeEnabled();
    await expect(passkey).toBeFocused();
    await expect(page.locator("main#auth-main [role='alert']")).toHaveCount(0);
    await auditAuthStage(page);
  });

  test("375px: another-device stage renders a safe approval code and returns cleanly", async ({
    page,
  }) => {
    test.skip(test.info().project.name !== "chromium-mobile");
    await page.route("**/api/v1/auth/cli/device/start", async (route) => {
      const origin = new URL(route.request().url()).origin;
      await fulfillJson(route, {
        device_code: "closure-device-possession-secret",
        user_code: "ABCD-EFGH",
        grant_kind: "session",
        expires_in: 3600,
        interval: 60,
        remember: false,
        verification_uri: `${origin}/cli/auth`,
        verification_uri_complete: `${origin}/cli/auth?user_code=ABCD-EFGH`,
      });
    });
    await page.route("**/api/v1/auth/cli/device/token", async (route) => {
      await fulfillJson(route, { ok: true });
    });
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-login-hydrated="true"]')).toHaveCount(1);
    const deviceTrigger = page.getByRole("button", {
      name: "Sign in with another device",
    });
    // This control changes a client-only stage. Its disabled→enabled boundary
    // is the public hydration contract, so the click cannot be swallowed by
    // the server-rendered pre-hydration button.
    await expect(deviceTrigger).toBeEnabled();
    await deviceTrigger.click();
    const heading = page.getByRole("heading", {
      level: 1,
      name: "Sign in with another device",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
    await expect(
      page.getByLabel("QR code to approve this Moosewave browser sign-in"),
    ).toBeVisible();
    await auditAuthStage(page);
    await page
      .getByRole("button", { name: "Use another sign-in method" })
      .click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeFocused();
  });
});
