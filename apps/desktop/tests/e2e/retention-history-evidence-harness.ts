import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_DIR = fileURLToPath(
  new URL(
    "../../../../.audit-screenshots/retention-history-evidence",
    import.meta.url,
  ),
);

export const RETENTION_TENANT_ID = "10000000-0000-4000-8000-000000000001";
export const RETENTION_FIXED_TIME = "2026-07-30T07:15:00.000Z";
export const RETENTION_PRIVATE_ERROR_CANARY =
  "retention-provider-debug-secret-must-not-render";

const OFFER_IDS = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
  "20000000-0000-4000-8000-000000000004",
  "20000000-0000-4000-8000-000000000005",
  "20000000-0000-4000-8000-000000000006",
] as const;

const TIER_IDS = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
  "30000000-0000-4000-8000-000000000004",
  "30000000-0000-4000-8000-000000000005",
  "30000000-0000-4000-8000-000000000006",
] as const;

const OFFER_FIXTURES = [
  {
    id: OFFER_IDS[0],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[0],
    percent_off: 20,
    duration_months: 3,
    headline: "Keep the founder rate",
    body: "Stay with the plan you helped shape.\n\nYour next three months retain the founder discount.",
    stripe_coupon_id: "coupon-private-founder",
    active: true,
    created_at: "2026-07-20T09:00:00.000Z",
    updated_at: "2026-07-22T09:00:00.000Z",
  },
  {
    id: OFFER_IDS[1],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[1],
    percent_off: null,
    fixed_off_cents: 1250,
    duration_months: 1,
    headline: "Annual member save",
    body: "A retained fixed-amount term whose billing currency is not present in this API.",
    stripe_coupon_id: "",
    active: true,
    created_at: "2026-07-18T09:00:00.000Z",
    updated_at: "2026-07-19T09:00:00.000Z",
  },
  {
    id: OFFER_IDS[2],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[2],
    percent_off: 15,
    duration_months: 2,
    headline: "Continue the studio plan",
    body: "Historical copy for the studio tier.",
    stripe_coupon_id: "coupon-private-studio",
    active: true,
    created_at: "2026-07-16T09:00:00.000Z",
    updated_at: "2026-07-17T09:00:00.000Z",
  },
  {
    id: OFFER_IDS[3],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[3],
    percent_off: 10,
    duration_months: 6,
    headline: "Legacy team offer",
    body: "This historical row is marked inactive.",
    stripe_coupon_id: "coupon-private-team",
    active: false,
    created_at: "2026-07-14T09:00:00.000Z",
    updated_at: "2026-07-15T09:00:00.000Z",
  },
  {
    id: OFFER_IDS[4],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[4],
    percent_off: 25,
    duration_months: 1,
    headline: "Archive supporter offer",
    body: "A zero-shown historical row.",
    stripe_coupon_id: "",
    active: false,
    created_at: "2026-07-12T09:00:00.000Z",
    updated_at: "2026-07-13T09:00:00.000Z",
  },
  {
    id: OFFER_IDS[5],
    tenant_id: RETENTION_TENANT_ID,
    paywall_tier_id: TIER_IDS[5],
    percent_off: 30,
    duration_months: 2,
    headline: "Early access archive",
    body: "A final retained record for dense-list qualification.",
    stripe_coupon_id: "coupon-private-early",
    active: false,
    created_at: "2026-07-10T09:00:00.000Z",
    updated_at: "2026-07-11T09:00:00.000Z",
  },
] as const;

const RETENTION_SECRET_CANARIES = [
  RETENTION_PRIVATE_ERROR_CANARY,
  ...OFFER_FIXTURES.map((offer) => offer.stripe_coupon_id).filter(Boolean),
] as const;

const FUNNEL_FIXTURES = [
  [128, 31, 74, 12],
  [42, 8, 24, 6],
  [61, 14, 35, 5],
  [19, 3, 12, 2],
  [0, 0, 0, 0],
  [9, 1, 5, 1],
].map(([shown, accepted, declined, expired], index) => ({
  offer_id: OFFER_IDS[index],
  tier_id: TIER_IDS[index],
  shown,
  accepted,
  declined,
  expired,
  acceptance_rate: shown === 0 ? 0 : accepted / shown,
}));

const TIER_FIXTURES = [
  "Founders",
  "Annual",
  "Studio",
  "Teams",
  "Supporters",
  "Early access",
].map((name, index) => ({
  id: TIER_IDS[index],
  name,
  active: index < 4,
}));

export type RetentionFixtureMode =
  | "populated"
  | "funnel-error"
  | "integrity-conflict"
  | "empty"
  | "offers-retry"
  | "optional-errors"
  | "stale-refresh"
  | "editor";

export interface RetentionRequestEvidence {
  method: string;
  pathname: string;
  search: string;
}

export interface RetentionHttpFailureEvidence {
  method: "GET";
  pathname: string;
  status: number;
}

export interface RetentionHarness {
  allowOffersRetry: () => void;
  beginStaleSupportingFailure: () => void;
  expectedHttpFailures: RetentionHttpFailureEvidence[];
  expectedNetworkErrors: string[];
  requests: RetentionRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function installRetentionHarness(
  page: Page,
  mode: RetentionFixtureMode,
): Promise<RetentionHarness> {
  let offersRetryAllowed = mode !== "offers-retry";
  let staleSupportingFailure = false;
  const pendingConsoleFailures: RetentionHttpFailureEvidence[] = [];
  const harness: RetentionHarness = {
    allowOffersRetry: () => {
      offersRetryAllowed = true;
    },
    beginStaleSupportingFailure: () => {
      staleSupportingFailure = true;
    },
    expectedHttpFailures: [],
    expectedNetworkErrors: [],
    requests: [],
    runtimeErrors: [],
    unexpectedRequests: [],
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      const text = message.text();
      const match =
        /^Failed to load resource: the server responded with a status of (\d{3}) \(([^)]+)\)$/u.exec(
          text,
        );
      const status = match ? Number(match[1]) : null;
      const expectedIndex =
        status === null
          ? -1
          : pendingConsoleFailures.findIndex(
              (failure) => failure.status === status,
            );
      if (expectedIndex >= 0) {
        const [failure] = pendingConsoleFailures.splice(expectedIndex, 1);
        harness.expectedNetworkErrors.push(
          `${failure?.method ?? "GET"} ${failure?.pathname ?? "unknown"} -> ${status}: ${text}`,
        );
      } else {
        harness.runtimeErrors.push(`console: ${text}`);
      }
    }
  });
  page.on("pageerror", (error) => {
    harness.runtimeErrors.push(`pageerror: ${error.message}`);
  });

  // Keep the shell's unrelated saved-layout read valid so Retention evidence
  // is never obscured by a harness-only Dashboard fallback toast.
  await page.route("**/api/v1/dashboard/layout", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await json(route, {
      order: [
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
      ],
    });
  });

  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/v1/auth/me" && request.method() === "GET") {
      await json(route, {
        user_id: "40000000-0000-4000-8000-000000000001",
        tenant_id: RETENTION_TENANT_ID,
        email: "retention-admin@example.invalid",
        role: mode === "editor" ? "editor" : "admin",
        effective_role: mode === "editor" ? "editor" : "admin",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Retention evidence",
        workspace_slug: "retention-evidence",
      });
      return;
    }
    if (path === "/api/v1/me" && request.method() === "GET") {
      await json(route, {
        user: "retention-admin@example.invalid",
        tenant: RETENTION_TENANT_ID,
      });
      return;
    }

    const isAllowedRetentionRead =
      path === "/api/v1/retention-offers" ||
      path === "/api/v1/retention-offers/funnel" ||
      path === "/api/v1/retention-offers/winback-settings" ||
      path === "/api/v1/paywall/tiers";
    const isRetentionNamespace =
      path === "/api/v1/retention-offers" ||
      path.startsWith("/api/v1/retention-offers/");
    if (!isRetentionNamespace && path !== "/api/v1/paywall/tiers") {
      await route.fallback();
      return;
    }

    const evidence = {
      method: request.method(),
      pathname: path,
      search: url.search,
    };
    harness.requests.push(evidence);
    if (request.method() !== "GET") {
      harness.unexpectedRequests.push(`${request.method()} ${path}`);
      await json(
        route,
        {
          error: {
            code: "retention_e2e_write_blocked",
            message: "The retention evidence fixture permits reads only.",
          },
        },
        405,
      );
      return;
    }
    if (!isAllowedRetentionRead) {
      harness.unexpectedRequests.push(`${request.method()} ${path}`);
      await json(
        route,
        {
          error: {
            code: "retention_e2e_unexpected_read",
            message: "The retention evidence fixture permits four known reads.",
          },
        },
        404,
      );
      return;
    }

    const failExpectedRead = async (
      code: string,
      message: string,
    ): Promise<void> => {
      const failure: RetentionHttpFailureEvidence = {
        method: "GET",
        pathname: path,
        status: 503,
      };
      harness.expectedHttpFailures.push(failure);
      pendingConsoleFailures.push(failure);
      await json(
        route,
        {
          error: {
            code,
            message,
            details: {
              diagnostic: RETENTION_PRIVATE_ERROR_CANARY,
            },
          },
        },
        503,
      );
    };

    if (path === "/api/v1/retention-offers") {
      if (mode === "offers-retry" && !offersRetryAllowed) {
        await failExpectedRead(
          "retention_history_temporarily_unavailable",
          "Retention history is temporarily unavailable.",
        );
        return;
      }
      const offers = mode === "empty" ? [] : OFFER_FIXTURES;
      await json(route, { offers, count: offers.length });
      return;
    }
    if (path === "/api/v1/retention-offers/funnel") {
      if (
        mode === "funnel-error" ||
        (mode === "stale-refresh" && staleSupportingFailure)
      ) {
        await failExpectedRead(
          "funnel_unavailable",
          "Private aggregation detail",
        );
        return;
      }
      const tiles =
        mode === "empty"
          ? []
          : mode === "integrity-conflict"
            ? FUNNEL_FIXTURES.map((tile, index) =>
                index === 0
                  ? {
                      ...tile,
                      shown: 2,
                      accepted: 3,
                      declined: 1,
                    }
                  : tile,
              )
            : FUNNEL_FIXTURES;
      await json(route, { tiles, count: tiles.length });
      return;
    }
    if (path === "/api/v1/retention-offers/winback-settings") {
      if (
        mode === "optional-errors" ||
        (mode === "stale-refresh" && staleSupportingFailure)
      ) {
        await failExpectedRead(
          "winback_settings_unavailable",
          "Stored settings are temporarily unavailable.",
        );
        return;
      }
      await json(route, {
        enabled: true,
        churn_threshold: 0.7,
        churn_profiles_scored: 328,
      });
      return;
    }
    if (
      mode === "optional-errors" ||
      (mode === "stale-refresh" && staleSupportingFailure)
    ) {
      await failExpectedRead(
        "tier_names_unavailable",
        "Tier names are temporarily unavailable.",
      );
      return;
    }
    await json(route, { tiers: mode === "empty" ? [] : TIER_FIXTURES });
  });

  return harness;
}

export async function openRetentionHistory(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  _testInfo: TestInfo,
  options: {
    height?: number;
    mode?: RetentionFixtureMode;
    theme?: "system" | "dark" | "light";
    width?: number;
  } = {},
): Promise<RetentionHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date(RETENTION_FIXED_TIME));
  await bootApp(page);
  const harness = await installRetentionHarness(
    page,
    options.mode ?? "populated",
  );
  await page.goto("/");
  await waitForPrimaryNavigation(page);

  const destination = page
    .locator('section[aria-labelledby="sidebar-domain-growth"]')
    .locator('button[data-section="retentionOffers"]');
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");

  if (options.mode === "editor") {
    await expect(
      page.getByRole("heading", { name: "Access required", exact: true }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", {
        name: "See what the retention record can prove—and where it stops.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".rhs-page")).toBeVisible();
  }

  return harness;
}

export function requestCount(
  harness: RetentionHarness,
  pathname: string,
): number {
  return harness.requests.filter(
    (request) => request.method === "GET" && request.pathname === pathname,
  ).length;
}

export function expectAutomaticRetentionReadCount(
  actual: number,
  options: { expectedFailure?: boolean } = {},
): void {
  const expectedFailure = options.expectedFailure === true;
  if (process.env["POSTWAVE_RETENTION_E2E_SOURCE"] === "1") {
    // Vite source mode can mount the lazy route against both the provisional
    // and resolved identity while React StrictMode replays effects. Failed
    // idempotent GETs also exercise the client's bounded retry policy. The
    // exact source-mode replay count is intentionally not a production
    // contract.
    expect(actual).toBeGreaterThanOrEqual(expectedFailure ? 3 : 2);
    expect(actual).toBeLessThanOrEqual(8);
    return;
  }
  // Optimized preview performs one successful automatic read. A deliberate
  // 503 consumes the initial attempt plus a bounded client-specific retry
  // budget (the funnel client retries once; the other clients retry twice).
  if (expectedFailure) {
    expect(actual).toBeGreaterThanOrEqual(2);
    expect(actual).toBeLessThanOrEqual(3);
    return;
  }
  expect(actual).toBe(1);
}

export function expectedHttpFailureCount(
  harness: RetentionHarness,
  pathname: string,
): number {
  return harness.expectedHttpFailures.filter(
    (failure) => failure.method === "GET" && failure.pathname === pathname,
  ).length;
}

export async function expectRetentionSafety(
  page: Page,
  harness: RetentionHarness,
): Promise<void> {
  expect(
    harness.requests.filter((request) => request.method !== "GET"),
  ).toEqual([]);
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);

  const renderedText = await page.locator("body").innerText();
  for (const canary of RETENTION_SECRET_CANARIES) {
    expect(renderedText).not.toContain(canary);
  }
}

export async function expectNoRetentionOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".rhs-page");
    const dialog = document.querySelector<HTMLElement>(".rhs-detail");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function retentionAxeViolations(
  page: Page,
  selector = ".rhs-page",
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
              options: unknown,
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
      const result = await axe.run(rootSelector, {
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
    },
    { rootSelector: selector },
  );
}

export async function captureRetentionEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness?: RetentionHarness,
): Promise<void> {
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });
  await testInfo.attach(name, { path, contentType: "image/png" });
  if (harness) {
    await testInfo.attach(`${name}-requests`, {
      body: Buffer.from(JSON.stringify(harness.requests, null, 2)),
      contentType: "application/json",
    });
  }
}
