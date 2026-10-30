import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_MODE =
  process.env["POSTWAVE_DELIVERABILITY_E2E_SOURCE"] === "1"
    ? "source"
    : "optimized";
const EVIDENCE_DIR = fileURLToPath(
  new URL(
    `../../../../.audit-screenshots/deliverability-hub-evidence/${EVIDENCE_MODE}/`,
    import.meta.url,
  ),
);

export const DELIVERABILITY_FIXED_TIME = "2026-08-02T12:00:00.000Z";
export const DELIVERABILITY_SECRET_CANARY =
  "deliverability-private-secret-must-never-render";
const TENANT_ID = "70000000-0000-4000-8000-000000000001";
const MODEL_VERSION = "campaign-cohort-v2-2026-08-02";
const VERIFICATION_JOB_ID = "71000000-0000-4000-8000-000000000001";
const DECLARED_PLAYWRIGHT_TEST_COUNT = 4;
const DASHBOARD_LAYOUT_ERROR =
  "Couldn't load your saved Dashboard layout. The default layout is shown.";
const DASHBOARD_LAYOUT_ORDER = [
  "subs",
  "opens",
  "clicks",
  "bounces",
  "forecast",
  "anomalies",
  "goals",
  "benchmarks",
  "engagement",
  "parity",
  "inbox-health",
  "clv",
] as const;

export type DeliverabilityMode =
  | "qualified"
  | "unqualified"
  | "malformed-summary"
  | "viewer";

export interface DeliverabilityRequestEvidence {
  method: string;
  pathname: string;
  search: string;
}

export interface DeliverabilityHarness {
  requests: DeliverabilityRequestEvidence[];
  controls: DeliverabilityRequestEvidence[];
  mutations: DeliverabilityRequestEvidence[];
  verificationReads: DeliverabilityRequestEvidence[];
  billableVerificationCreates: DeliverabilityRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

const EXPECTED_VERIFICATION_READS = [
  "GET /api/v1/verification/credits?days=30",
  `GET /api/v1/verification/jobs/${VERIFICATION_JOB_ID}`,
  `GET /api/v1/verification/jobs/${VERIFICATION_JOB_ID}/results?limit=101`,
  "GET /api/v1/verification/jobs?limit=50",
  "GET /api/v1/verification/policy",
  "GET /api/v1/verification/providers",
] as const;

const BILLABLE_VERIFICATION_CREATE_PATHS = new Set([
  "/api/v1/verification/jobs",
  "/api/v1/verification/verify",
  "/api/v1/verification/verify-batch",
]);

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function summary(mode: DeliverabilityMode): Record<string, unknown> {
  const qualified = mode !== "unqualified";
  return {
    tenant_id: TENANT_ID,
    score: qualified ? 92 : 100,
    grade: "A",
    status: qualified ? "Healthy" : "Insufficient data",
    trend: qualified ? "up" : "flat",
    trend_delta: qualified ? 2 : 0,
    ...(qualified ? { trend_reference_at: "2026-07-26T12:00:00.000Z" } : {}),
    history: qualified ? [90, 91, 92] : [],
    bounce_rate: qualified ? 0.002 : 0,
    complaint_rate: qualified ? 0.0002 : 0,
    engagement_rate: qualified ? 0.42 : 0,
    opens_machine_pct: 0.12,
    event_rate_scope: "campaigns",
    model_version: MODEL_VERSION,
    sample_qualified: qualified,
    minimum_sample_sends: 1_000,
    ...(qualified
      ? {}
      : {
          sample_reason:
            "fewer than 1,000 successful campaign sends in the 30-day model window",
        }),
    window_days: 30,
    breaches: qualified
      ? []
      : [
          {
            code: "campaign_sample_insufficient",
            severity: "info",
            title: "More campaign sends are needed for a qualified rate score",
            metric: "campaign_sends_30d",
            threshold: 1_000,
            observed: 125,
          },
        ],
    dns_health: {},
    blocklist_hits: [],
    auto_throttled: false,
    totals: {
      sends_7d: qualified ? 1_500 : 50,
      sends_30d: qualified ? 4_000 : 125,
    },
    computed_at: DELIVERABILITY_FIXED_TIME,
  };
}

function history(mode: DeliverabilityMode): Record<string, unknown> {
  const qualified = mode !== "unqualified";
  return {
    snapshots: [
      {
        sampled_at: DELIVERABILITY_FIXED_TIME,
        score: qualified ? 92 : 100,
        model_version: MODEL_VERSION,
        sample_qualified: qualified,
        sample_size: qualified ? 4_000 : 125,
      },
    ],
    window_days: 30,
    count: 1,
    model_version: MODEL_VERSION,
  };
}

function controlResponse(path: string): { body: unknown } | null {
  if (path === "/api/v1/dashboard/stats") {
    return { body: { range: "30d" } };
  }
  if (path === "/api/v1/dashboard/anomalies") {
    return { body: { items: [] } };
  }
  if (path === "/api/v1/dashboard/benchmarks") {
    return { body: { rows: [], note: "" } };
  }
  if (path === "/api/v1/dashboard/layout") {
    return {
      body: {
        userId: "deliverability-evidence-user",
        tenantId: TENANT_ID,
        order: DASHBOARD_LAYOUT_ORDER,
        updatedAt: DELIVERABILITY_FIXED_TIME,
      },
    };
  }
  if (path === "/api/v1/goals/progress") {
    return {
      body: { as_of: DELIVERABILITY_FIXED_TIME, progress: [] },
    };
  }
  if (path === "/api/v1/onboarding-progress") {
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
  if (path === "/api/v1/custom-domains") return { body: [] };
  if (path === "/api/v1/subscribers") {
    return { body: { items: [], total: 0, page: 1, per_page: 1 } };
  }
  if (path === "/api/v1/track/stats") {
    return {
      body: {
        periodDays: 30,
        totalEvents: 0,
        uniqueSubscribers: 0,
        uniqueEventNames: 0,
        daily: [],
        timeZone: "UTC",
        asOf: DELIVERABILITY_FIXED_TIME,
      },
    };
  }
  if (path === "/api/v1/deliverability/dmarc-reports") {
    return { body: { items: [] } };
  }
  if (path === "/api/v1/deliverability/providers")
    return { body: { items: [] } };
  if (path === "/api/v1/domain-warmup") return { body: { plans: [] } };
  if (path === "/api/v1/bot-opens/signatures") {
    return { body: { signatures: [], count: 0 } };
  }
  if (path === "/api/v1/bot-opens/stats") {
    return {
      body: {
        since: "2026-07-03T12:00:00.000Z",
        total_opens: 100,
        bot_opens: 12,
        human_opens: 88,
        by_signature: [],
      },
    };
  }
  if (path === "/api/v1/deliverability-control/domain-setups") {
    return { body: { items: [] } };
  }
  if (path === "/api/v1/deliverability-control/click-tracking") {
    return {
      body: {
        tracking_domain: "click.mail.example.test",
        status: "active",
        ssl_status: "verified",
        disable_syntax: [],
      },
    };
  }
  if (path === "/api/v1/deliverability-control/ip-routing") {
    return {
      body: {
        status: "active",
        strategy: "shared",
        dedicated_pool: "",
        shared_pool: "shared-primary",
        dedicated_percentage_bp: 0,
        max_dedicated_percentage_bp: 10_000,
        effective_dedicated_percent: 0,
        effective_shared_percent: 100,
      },
    };
  }
  if (path === "/api/v1/deliverability-control/entitlements") {
    return {
      body: {
        period_start: "2026-08-01",
        plan_tier: "studio",
        inbox_tests_monthly: 50,
        render_previews_monthly: 100,
        inbox_tests_used: 8,
        render_previews_used: 12,
        overage_policy: "block",
        inbox_tests_remaining: 42,
        render_previews_remaining: 88,
      },
    };
  }
  if (path === "/api/v1/blocklist/auto-suppress") {
    return {
      body: {
        auto_suppress: false,
        eligible_now: 0,
        active_suppressions: 0,
        observed_at: DELIVERABILITY_FIXED_TIME,
      },
    };
  }
  if (path === "/api/v1/spam-trap-guard/stats") {
    return {
      body: {
        hits_last_30_days: 0,
        blocklisted_count: 0,
        eligible_now: 0,
        observed_at: DELIVERABILITY_FIXED_TIME,
      },
    };
  }
  if (path === "/api/v1/spam-trap-guard/hits") {
    return { body: { hits: [], count: 0 } };
  }
  if (path === "/api/v1/soft-bounce-recovery/stats") {
    return {
      body: {
        disabled_count: 0,
        eligible_now: 0,
        eligible_suppressions_now: 0,
        recovery_window_days: 30,
        automatic_reactivation_active: false,
      },
    };
  }
  if (path === "/api/v1/intelligent-retry/events")
    return { body: { items: [] } };
  if (path === "/api/v1/isp-breakdown") {
    return { body: { window_days: 30, buckets: [] } };
  }
  if (path === "/api/v1/auth-checks") return { body: [] };
  if (path === "/api/v1/campaigns") {
    return {
      body: {
        items: [
          {
            id: "80000000-0000-4000-8000-000000000001",
            name: "August product update",
            subject: "What shipped this month",
            status: "sent",
          },
        ],
      },
    };
  }
  return null;
}

function verificationJobFixture(): Record<string, unknown> {
  return {
    id: VERIFICATION_JOB_ID,
    status: "completed",
    source: "tag",
    source_ref: "August launch audience",
    provider: "zerobounce",
    total: 2,
    processed: 2,
    cache_hits: 1,
    local_filtered: 0,
    vendor_verified: 1,
    credits_spent: 1,
    duplicates: 0,
    created_at: "2026-08-02T09:00:00.000Z",
    started_at: "2026-08-02T09:00:01.000Z",
    completed_at: "2026-08-02T09:00:04.000Z",
  };
}

export async function installDeliverabilityHarness(
  page: Page,
  mode: DeliverabilityMode,
): Promise<DeliverabilityHarness> {
  const harness: DeliverabilityHarness = {
    requests: [],
    controls: [],
    mutations: [],
    verificationReads: [],
    billableVerificationCreates: [],
    runtimeErrors: [],
    unexpectedRequests: [],
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      harness.runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    harness.runtimeErrors.push(`pageerror: ${error.message}`);
  });

  await page.route("**/api/v1/dashboard/layout**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const evidence = {
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
    };
    harness.requests.push(evidence);
    harness.controls.push(evidence);
    if (request.method() !== "GET") {
      harness.mutations.push(evidence);
      harness.unexpectedRequests.push(
        `${request.method()} ${url.pathname}${url.search}`,
      );
      await route.abort("blockedbyclient");
      return;
    }
    // The global Dashboard controller mounts briefly before navigation. A
    // complete, valid preference keeps that unrelated controller from
    // publishing a fixture-only fallback toast over route evidence. The broad
    // route below returns this same contract because Playwright checks the
    // most recently registered matching handler first.
    await json(route, {
      userId: "deliverability-evidence-user",
      tenantId: TENANT_ID,
      order: DASHBOARD_LAYOUT_ORDER,
      updatedAt: DELIVERABILITY_FIXED_TIME,
    });
  });
  await page.route("**/src/lib/api/**", (route) => route.continue());
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const evidence = {
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
    };
    harness.requests.push(evidence);
    if (
      request.method() === "POST" &&
      BILLABLE_VERIFICATION_CREATE_PATHS.has(url.pathname)
    ) {
      harness.billableVerificationCreates.push(evidence);
    }
    if (
      request.method() === "POST" &&
      url.pathname === "/api/v1/streams/token"
    ) {
      harness.controls.push(evidence);
      await json(route, {
        token: "deliverability-evidence-stream-token",
        expires_at: "2026-08-02T12:01:00.000Z",
        ttl_seconds: 60,
      });
      return;
    }
    if (request.method() !== "GET") harness.mutations.push(evidence);

    if (url.pathname === "/api/v1/auth/me" && request.method() === "GET") {
      const role = mode === "viewer" ? "viewer" : "admin";
      await json(route, {
        user_id: "90000000-0000-4000-8000-000000000001",
        tenant_id: TENANT_ID,
        email: `${role}@example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Deliverability evidence",
        workspace_slug: "deliverability-evidence",
      });
      return;
    }
    if (url.pathname === "/api/v1/me" && request.method() === "GET") {
      await json(route, {
        user:
          mode === "viewer"
            ? "viewer@example.invalid"
            : "admin@example.invalid",
        tenant: TENANT_ID,
      });
      return;
    }
    if (
      url.pathname === "/api/v1/audit/my-scopes" &&
      request.method() === "GET"
    ) {
      const admin = mode !== "viewer";
      await json(route, {
        scopes: admin ? ["audit:read", "audit:read_pii"] : [],
        auditScopes: admin ? ["audit:read", "audit:read_pii"] : [],
        isAdmin: admin,
      });
      return;
    }
    if (request.method() !== "GET") {
      harness.unexpectedRequests.push(
        `${request.method()} ${url.pathname}${url.search}`,
      );
      await route.abort("blockedbyclient");
      return;
    }

    if (url.pathname.startsWith("/api/v1/verification/")) {
      const requestKey = `${request.method()} ${url.pathname}${url.search}`;
      if (
        !(EXPECTED_VERIFICATION_READS as readonly string[]).includes(requestKey)
      ) {
        harness.unexpectedRequests.push(requestKey);
        await json(route, { error: { code: "unexpected_test_request" } }, 500);
        return;
      }
      harness.verificationReads.push(evidence);
      harness.controls.push(evidence);
      if (url.pathname === `/api/v1/verification/jobs/${VERIFICATION_JOB_ID}`) {
        await json(route, {
          job: verificationJobFixture(),
          summary: { valid: 1, invalid: 1 },
          credits_saved: 1,
          credits_spent: 1,
          is_terminal: true,
        });
        return;
      }
      if (
        url.pathname ===
        `/api/v1/verification/jobs/${VERIFICATION_JOB_ID}/results`
      ) {
        await json(route, {
          results: [
            {
              email: "private.recipient@example.invalid",
              processed: true,
              status: "valid",
              score: 9,
              provider: "zerobounce",
              billable: true,
              cached: false,
              checked_at: "2026-08-02T09:00:03.000Z",
            },
            {
              email: "another.recipient@example.invalid",
              processed: true,
              status: "invalid",
              provider: "local",
              billable: false,
              cached: true,
              did_you_mean: "another.corrected@example.invalid",
              checked_at: "2026-08-02T09:00:02.000Z",
            },
          ],
        });
        return;
      }
      if (url.pathname === "/api/v1/verification/providers") {
        await json(route, {
          providers: [
            {
              provider: "zerobounce",
              credential_ref: "vault://example.invalid/verification-demo",
              enabled: true,
              settings: {},
              last_balance: 1_840,
              last_balance_at: "2026-08-02T11:45:00.000Z",
            },
          ],
          available: ["zerobounce", "kickbox"],
        });
        return;
      }
      if (url.pathname === "/api/v1/verification/policy") {
        await json(route, {
          policy: {
            forms_mode: "local",
            forms_reject_statuses: [
              "invalid",
              "spamtrap",
              "abuse",
              "do_not_mail",
            ],
            forms_suggest_typos: true,
            import_mode: "off",
            updated_at: "2026-08-01T09:30:00.000Z",
          },
          modes: ["off", "local", "full"],
          rejectable_statuses: [
            "invalid",
            "spamtrap",
            "abuse",
            "do_not_mail",
            "catch_all",
            "unknown",
          ],
        });
        return;
      }
      if (url.pathname === "/api/v1/verification/credits") {
        await json(route, {
          usage: [
            {
              day: "2026-08-02",
              provider: "zerobounce",
              verified: 1_240,
              credits_spent: 180,
              local_filtered: 730,
              cache_hits: 330,
            },
          ],
          totals: {
            verified: 1_240,
            credits_spent: 180,
            local_filtered: 730,
            cache_hits: 330,
            credits_saved: 1_060,
          },
          provider: "zerobounce",
          balance: 1_840,
          balance_checked_at: "2026-08-02T11:45:00.000Z",
        });
        return;
      }
      await json(route, { jobs: [verificationJobFixture()] });
      return;
    }

    if (url.pathname === "/api/v1/deliverability/hub") {
      await json(
        route,
        mode === "malformed-summary" ? { score: 92 } : summary(mode),
      );
      return;
    }
    if (url.pathname === "/api/v1/deliverability/hub/history") {
      await json(route, history(mode));
      return;
    }
    if (url.pathname === "/api/v1/deliverability/hub/dns-health") {
      await json(route, {
        identities: [
          {
            id: "a0000000-0000-4000-8000-000000000001",
            domain: "mail.example.test",
            verify_state: "verified",
            spf_verified_at: "2026-08-01T00:00:00.000Z",
            dkim_verified_at: "2026-08-01T00:00:00.000Z",
            dmarc_verified_at: "2026-08-01T00:00:00.000Z",
            last_attempt_at: "2026-08-02T11:00:00.000Z",
            is_stale: false,
            hours_since_last_check: 1,
          },
        ],
        count: 1,
      });
      return;
    }
    if (url.pathname === "/api/v1/deliverability/hub/blocklist-hits") {
      await json(route, { items: [], count: 0, window: "30d" });
      return;
    }
    if (url.pathname === "/api/v1/deliverability/hub/webhook-errors") {
      await json(route, {
        items: [],
        failed_verifications: [],
        count: 0,
        window: "7d",
      });
      return;
    }
    if (url.pathname === "/api/v1/deliverability/hub/bounce-class-breakdown") {
      await json(route, {
        window_days: 30,
        total_bounces: 2,
        classes: [{ class_code: "hard", label: "Hard", count: 2, share: 1 }],
        series: [],
      });
      return;
    }
    const response = controlResponse(url.pathname);
    if (response !== null) {
      harness.controls.push(evidence);
      await json(route, response.body);
      return;
    }
    harness.unexpectedRequests.push(`GET ${url.pathname}${url.search}`);
    await json(route, { error: { code: "unexpected_test_request" } }, 500);
  });
  return harness;
}

export async function openDeliverabilityHub(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  mode: DeliverabilityMode = "qualified",
  options: {
    theme?: "system" | "dark" | "light";
    width?: number;
    height?: number;
  } = {},
): Promise<DeliverabilityHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date(DELIVERABILITY_FIXED_TIME));
  await bootApp(page);
  const harness = await installDeliverabilityHarness(page, mode);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("region", { name: "Insights & delivery" })
    .getByRole("button", { name: "Deliverability hub", exact: true });
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".dhw-page")).toBeVisible();
  return harness;
}

export async function deliverabilityAxeViolations(
  page: Page,
): Promise<unknown[]> {
  const activeSurface = page.locator(".dhw-panel:not([hidden]) > .dhw-stack");
  if ((await activeSurface.count()) === 1) {
    await activeSurface.evaluate(async (element) => {
      // A tab panel's content stack fades from transparent for 220 ms. Auditing an
      // intermediate alpha frame reports contrast that no settled user state
      // has, so bind accessibility evidence to the completed panel state.
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
  }
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            context: string,
            options: unknown,
          ) => Promise<{ violations: unknown[] }>;
        };
      }
    ).axe;
    const result = await axe.run(".dhw-page", {
      resultTypes: ["violations"],
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
    });
    return result.violations;
  });
}

export async function expectNoDeliverabilityOverflow(
  page: Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".dhw-page");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function expectDeliverabilitySafety(
  page: Page,
  harness: DeliverabilityHarness,
): Promise<void> {
  expect(harness.mutations).toEqual([]);
  expect(harness.billableVerificationCreates).toEqual([]);
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(DELIVERABILITY_SECRET_CANARY);
}

export function expectVerificationReadLedger(
  harness: DeliverabilityHarness,
): void {
  const observed = harness.verificationReads
    .map(({ method, pathname, search }) => `${method} ${pathname}${search}`)
    .sort();
  const expected = [...EXPECTED_VERIFICATION_READS].sort();
  expect([...new Set(observed)].sort()).toEqual(expected);
  for (const request of expected) {
    const count = observed.filter((entry) => entry === request).length;
    // Source-mode React deliberately remounts effects under StrictMode. Every
    // verification read must still be known, bounded, and side-effect free;
    // the optimized candidate performs the same ledger once.
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2);
  }
  expect(harness.billableVerificationCreates).toEqual([]);
}

export async function captureDeliverabilityEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: DeliverabilityHarness,
): Promise<void> {
  // The harness returns the complete Dashboard-layout contract. A late shell
  // fallback notice is therefore a fixture failure, not something evidence is
  // allowed to dismiss or hide before capture.
  await expect(
    page.getByText(DASHBOARD_LAYOUT_ERROR, { exact: true }),
  ).toHaveCount(0);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });
  const requestLedgerPath = join(EVIDENCE_DIR, `${name}.requests.json`);
  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const baseCommitSha =
    typeof metadata["deliverabilityBaseCommitSha"] === "string"
      ? metadata["deliverabilityBaseCommitSha"]
      : "unavailable";
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    report: `../reports/${EVIDENCE_MODE}.json`,
  };
  await writeFile(
    join(EVIDENCE_DIR, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    requestLedgerPath,
    `${JSON.stringify(
      {
        ...receipt,
        requests: harness.requests,
        controls: harness.controls,
        mutations: harness.mutations,
        verificationReads: harness.verificationReads,
        billableVerificationCreates: harness.billableVerificationCreates,
        unexpectedRequests: harness.unexpectedRequests,
        runtimeErrors: harness.runtimeErrors,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await testInfo.attach(name, { path, contentType: "image/png" });
  await testInfo.attach(`${name}-requests`, {
    path: requestLedgerPath,
    contentType: "application/json",
  });
}

export async function scrollDeliverabilityWorkspaceIntoView(
  page: Page,
): Promise<void> {
  const content = page.locator(".content");
  const target = await content.evaluate((element) => {
    const heading = document.querySelector<HTMLElement>(
      ".dhw-workspace-heading",
    );
    if (!heading) throw new Error("Missing Deliverability workspace heading");
    const next = Math.max(
      0,
      heading.getBoundingClientRect().top + element.scrollTop - 90,
    );
    // The production shell intentionally uses smooth scrolling. Evidence
    // positioning must settle synchronously so a screenshot cannot catch a
    // transitional scroll frame.
    element.scrollTo({ top: next, behavior: "instant" });
    return element.scrollTop;
  });
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeCloseTo(target, 0);
}

export async function scrollDeliverabilityTargetIntoFrame(
  page: Page,
  target: Locator,
  viewportTop = 96,
): Promise<void> {
  await expect(page.locator(".content")).toBeVisible();
  await expect(target).toBeVisible();
  await expect
    .poll(async () =>
      target.evaluate(async (element, top) => {
        const scrollOwner = document.querySelector<HTMLElement>(".content");
        if (!scrollOwner) throw new Error("Missing shell content scroll owner");
        const requested = Math.max(
          0,
          element.getBoundingClientRect().top + scrollOwner.scrollTop - top,
        );
        scrollOwner.scrollTo({ top: requested, behavior: "instant" });
        // Absorb late scroll anchoring from a just-settled route panel. The
        // polling loop repositions the card if anchoring moves it away again.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > 72 && bounds.top < window.innerHeight - 72;
      }, viewportTop),
    )
    .toBe(true);
}

export async function positionDeliverabilityActiveTab(
  page: Page,
): Promise<void> {
  const rail = page.locator(".dhw-workspaces");
  const active = rail.locator('[role="tab"][aria-selected="true"]');
  await expect(active).toHaveCount(1);
  await active.evaluate((element) => {
    element.scrollIntoView({
      behavior: "instant",
      block: "nearest",
      inline: "start",
    });
  });
  await expect
    .poll(() =>
      rail.evaluate((element) => {
        const selected = element.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        );
        if (!selected) return false;
        const railBounds = element.getBoundingClientRect();
        const tabBounds = selected.getBoundingClientRect();
        const styles = getComputedStyle(element);
        const leftInset = Number.parseFloat(styles.paddingLeft) || 0;
        const rightInset = Number.parseFloat(styles.paddingRight) || 0;
        return (
          tabBounds.left >= railBounds.left + leftInset - 1 &&
          tabBounds.right <= railBounds.right - rightInset + 1
        );
      }),
    )
    .toBe(true);
}
