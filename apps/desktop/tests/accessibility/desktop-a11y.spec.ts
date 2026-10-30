import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page } from "@playwright/test";

import { expect, test } from "../visual/fixture";
import { PRIMARY_DESKTOP_SECTIONS } from "../visual/sections";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const WCAG_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
];

interface AxeNode {
  failureSummary?: string;
  target: string[];
}

interface AxeViolation {
  description: string;
  help: string;
  helpUrl: string;
  id: string;
  impact: string | null;
  nodes: AxeNode[];
}

const AUTH = {
  user_id: "accessibility-user",
  tenant_id: "accessibility-test",
  email: "accessibility-test@example.invalid",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Moosewave",
  workspace_slug: "accessibility-test",
};

const SUBSCRIBERS = {
  items: [
    {
      id: "sub-1",
      email: "ada@example.com",
      status: "enabled",
      tags: ["customer"],
      created_at: "2026-07-01T12:00:00.000Z",
      updated_at: "2026-07-01T12:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  per_page: 50,
};

const EMPTY_API_RESPONSE = {
  items: [],
  data: [],
  results: [],
  rows: [],
  points: [],
  series: [],
  buckets: [],
  deciles: [],
  schedules: [],
  goals: [],
  progress: [],
  profiles: [],
  conversions: [],
  runs: [],
  variants: [],
  steps: [],
  total: 0,
  count: 0,
  has_more: false,
  next_before: null,
};

const BARE_ARRAY_ENDPOINTS = [
  "/affiliates",
  "/auth-checks",
  "/check-links",
  "/commerce/integrations",
  "/conversions",
  "/feed-sources",
  "/form-variants",
  "/landing-pages",
  "/scoring/rules",
];

async function stubApi(page: Page): Promise<void> {
  const responses: Record<string, unknown> = {
    "/api/v1/auth/me": AUTH,
    "/api/v1/dashboard/stats": {
      range: "30d",
      subscribers_total: 12_482,
      subscribers_added_30d: 418,
      campaigns_sent_30d: 18,
      emails_sent_30d: 48_210,
      opens_total_30d: 20_297,
      clicks_total_30d: 4_050,
      bounces_total_30d: 289,
      unique_opens_30d: 20_110,
      unique_clicks_30d: 4_012,
      unique_bounces_30d: 289,
      unique_delivered_30d: 47_921,
      unique_sent_30d: 48_210,
      previous: {
        subscribers_added: 371,
        campaigns_sent: 16,
        emails_sent: 46_100,
        opens_total: 18_540,
        clicks_total: 3_612,
        bounces_total: 346,
        unique_opens: 18_361,
        unique_clicks: 3_580,
        unique_bounces: 346,
        unique_delivered: 45_754,
        unique_sent: 46_100,
      },
      sparklines: {
        subscribers: [11_920, 12_010, 12_090, 12_140, 12_240, 12_390, 12_482],
        opens: [2_710, 2_844, 2_690, 3_018, 2_921, 3_104, 3_010],
        clicks: [512, 544, 530, 602, 578, 631, 615],
        bounces: [48, 43, 46, 39, 41, 37, 35],
      },
      anomalies: {},
      recent_audit: [],
    },
    "/api/v1/dashboard/layout": {
      userId: AUTH.user_id,
      tenantId: AUTH.tenant_id,
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
      updatedAt: "2026-07-18T08:00:00.000Z",
    },
    "/api/v1/subscribers": SUBSCRIBERS,
    "/api/v1/subscribers/search": SUBSCRIBERS,
    "/api/v1/tags": {
      items: [
        {
          id: "tag-1",
          name: "customer",
          color: "teal",
          subscriber_count: 1,
          created_at: "2026-07-01T12:00:00.000Z",
        },
      ],
    },
    "/api/v1/audience-syncs": { items: [] },
    "/api/v1/audit/my-scopes": {
      scopes: ["audit:read", "audit:read_pii"],
      auditScopes: ["audit:read", "audit:read_pii"],
      isAdmin: true,
    },
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const isBareArray = BARE_ARRAY_ENDPOINTS.some(
      (suffix) => path.endsWith(suffix) || path.includes(`${suffix}/`),
    );
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        responses[path] ?? (isBareArray ? [] : EMPTY_API_RESPONSE),
      ),
    });
  });
}

async function openApp(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
): Promise<void> {
  await bootApp(page);
  // The shared fixture dismisses onboarding for its default tenant. This
  // suite deliberately supplies a separate authenticated tenant, so seed the
  // matching tenant-scoped key as well; otherwise the first-run wizard can
  // appear asynchronously and intercept later keyboard/pointer assertions.
  await page.addInitScript((tenantId: string) => {
    window.localStorage.setItem(
      `postwave_onboarding_dismissed_at:${tenantId}`,
      new Date().toISOString(),
    );
  }, AUTH.tenant_id);
  await stubApi(page);
  await page.goto("/");
  await page.locator(".sidebar").waitFor({ state: "visible", timeout: 20_000 });
  // The shell renders before the lazily loaded domain-navigation catalog.
  // Waiting for a real destination makes every route assertion observe the
  // settled navigation tree instead of racing the Suspense boundary.
  await page
    .locator('.sidebar-item[data-section="dashboard"]')
    .waitFor({ state: "visible", timeout: 20_000 });
}

async function goSection(
  page: Page,
  label: string,
  heading = label,
): Promise<void> {
  const item = page
    .locator(".sidebar-item")
    .filter({
      hasText: new RegExp(
        `^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    })
    .first();
  await expect(item, `Missing desktop navigation item: ${label}`).toBeVisible();
  await item.click();
  await expect(
    page.getByRole("heading", { name: heading, exact: false }).first(),
  ).toBeVisible({
    timeout: 10_000,
  });
}

async function assertWcag(page: Page, surface: string): Promise<void> {
  // Route transitions and staggered KPI entrances temporarily blend text
  // through a transparent opacity. Axe must inspect the settled UI that an
  // operator reads, not a sub-frame captured midway through that animation.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      const timing = animation.effect?.getComputedTiming();
      if (timing?.iterations !== Infinity) {
        try {
          animation.finish();
        } catch {
          // CSS animations without a finite end time are intentionally left
          // alone; they are not used for readable text in this renderer.
        }
      }
    }
  });
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (tags) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: { runOnly: { type: "tag"; values: string[] } },
          ) => Promise<{ violations: AxeViolation[] }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: { type: "tag", values: tags },
    });
    return result.violations;
  }, WCAG_TAGS);

  const report = violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failure: node.failureSummary,
    })),
  }));
  expect(
    report,
    `${surface} WCAG violations:\n${JSON.stringify(report, null, 2)}`,
  ).toEqual([]);
}

test("desktop shell and command palette meet WCAG A/AA", async ({
  page,
  bootApp,
}) => {
  await openApp(page, bootApp);
  await assertWcag(page, "desktop shell");

  const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Search commands" }),
  ).toBeFocused();
  await assertWcag(page, "command palette");
});

test("Dashboard interaction and failure states meet the executable accessibility gate", async ({
  page,
  bootApp,
}) => {
  await openApp(page, bootApp);
  await expect(
    page.getByRole("heading", { name: "Workspace performance" }),
  ).toBeVisible();
  await assertWcag(page, "Dashboard populated state");

  const editLayout = page.getByRole("button", {
    name: "Rearrange the dashboard's card sections",
  });
  await editLayout.focus();
  await page.keyboard.press("Enter");
  const finishLayout = page.getByRole("button", {
    name: "Finish rearranging dashboard sections",
  });
  await expect(finishLayout).toHaveAttribute("aria-pressed", "true");
  await expect(finishLayout).toBeFocused();
  await expect(page.getByText("Rearrange metrics and sections")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Move Subscribers later" }),
  ).toBeVisible();
  await assertWcag(page, "Dashboard layout editing state");

  await finishLayout.click();
  await page.getByRole("button", { name: "View all steps" }).click();
  const setupDisclosure = page.getByRole("button", { name: /Show less/ });
  await expect(setupDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Path to your first send")).toBeVisible();
  await assertWcag(page, "Dashboard expanded setup state");

  const failDashboard = async (route: import("@playwright/test").Route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "private upstream infrastructure detail" }),
    });
  };
  await page.route("**/api/v1/dashboard/stats**", failDashboard);
  await page.reload();
  await expect(
    page.getByText("Workspace metrics are temporarily unavailable."),
  ).toBeVisible();
  await expect(
    page.getByText("private upstream infrastructure detail"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Retry metrics" }),
  ).toBeVisible();
  await assertWcag(page, "Dashboard initial failure state");
  await page.unroute("**/api/v1/dashboard/stats**", failDashboard);
});

test("audience data surfaces meet WCAG A/AA", async ({ page, bootApp }) => {
  await openApp(page, bootApp);

  await goSection(page, "Subscribers");
  await expect(page.getByText("ada@example.com").first()).toBeVisible();
  await assertWcag(page, "Subscribers");

  await goSection(page, "Tags");
  await expect(
    page.getByRole("searchbox", { name: "Search tags" }),
  ).toBeVisible();
  await assertWcag(page, "Tags");

  await goSection(page, "Audience syncs");
  await expect(
    page.getByRole("searchbox", {
      name: "Search audience syncs by name or destination URL",
    }),
  ).toBeVisible();
  await assertWcag(page, "Audience syncs");
});

test.describe("every primary renderer destination meets WCAG A/AA", () => {
  for (const section of PRIMARY_DESKTOP_SECTIONS) {
    test(`route:${section.id}`, async ({ page, bootApp }) => {
      await openApp(page, bootApp);
      if (section.id === "dashboard") {
        await expect(
          page
            .getByRole("heading", { name: section.heading, exact: false })
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      } else {
        await goSection(page, section.label, section.heading);
      }
      await expect(page.locator('.pw-screen[role="alert"]')).toHaveCount(0);
      await assertWcag(page, section.heading);
    });
  }
});

test("modal focus, isolation, keyboard loop, and restoration are executable", async ({
  page,
  bootApp,
}) => {
  await openApp(page, bootApp);
  await goSection(page, "Tags");

  const trigger = page.getByRole("button", { name: "New tag" });
  const bodyOverflowBefore = await page
    .locator("body")
    .evaluate((element) => element.style.overflow);
  await trigger.focus();
  const triggerHandle = await trigger.elementHandle();
  expect(triggerHandle).not.toBeNull();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /new tag/i });
  await expect(dialog).toBeVisible();
  expect(
    await page.locator("body").evaluate((element) => element.style.overflow),
  ).toBe("hidden");
  const isolated = await triggerHandle!.evaluate((element) => {
    let current: Element | null = element;
    while (current && current !== document.body) {
      if (
        (current instanceof HTMLElement && current.inert) ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  });
  expect(isolated).toBe(true);
  await assertWcag(page, "New tag modal");

  const focusables = dialog.locator(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const count = await focusables.count();
  expect(count).toBeGreaterThan(1);
  await focusables.nth(count - 1).focus();
  await page.keyboard.press("Tab");
  await expect(focusables.first()).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  const remainsIsolated = await triggerHandle!.evaluate((element) => {
    let current: Element | null = element;
    while (current && current !== document.body) {
      if (
        (current instanceof HTMLElement && current.inert) ||
        current.getAttribute("aria-hidden") === "true"
      ) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  });
  expect(remainsIsolated).toBe(false);
  expect(
    await page.locator("body").evaluate((element) => element.style.overflow),
  ).toBe(bodyOverflowBefore);
});

test("reduced motion and forced colors remain operable", async ({
  browser,
  bootApp,
}) => {
  const reducedContext = await browser.newContext({ reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  try {
    await openApp(reducedPage, bootApp);
    await expect
      .poll(() =>
        reducedPage.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      )
      .toBe(true);
    const motion = await reducedPage.evaluate(() => {
      const milliseconds = (value: string): number =>
        value
          .split(",")
          .map((part) => part.trim())
          .reduce((max, part) => {
            const parsed = Number.parseFloat(part);
            if (!Number.isFinite(parsed)) return max;
            const duration = part.endsWith("ms") ? parsed : parsed * 1_000;
            return Math.max(max, duration);
          }, 0);
      const offenders = Array.from(
        document.querySelectorAll<HTMLElement>("body *"),
      )
        .map((element) => {
          const style = getComputedStyle(element);
          return {
            element: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
              element.className && typeof element.className === "string"
                ? `.${element.className.trim().split(/\s+/).join(".")}`
                : ""
            }`,
            durationMs: Math.max(
              milliseconds(style.animationDuration),
              milliseconds(style.transitionDuration),
            ),
          };
        })
        .filter(({ durationMs }) => durationMs > 10.1)
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10);
      return {
        longestMotionMs: offenders[0]?.durationMs ?? 0,
        offenders,
      };
    });
    expect(
      motion.longestMotionMs,
      `Reduced-motion durations exceeded 10ms:\n${JSON.stringify(motion.offenders, null, 2)}`,
    ).toBeLessThanOrEqual(10.1);
  } finally {
    await reducedContext.close();
  }

  const contrastContext = await browser.newContext({ forcedColors: "active" });
  const contrastPage = await contrastContext.newPage();
  try {
    await openApp(contrastPage, bootApp);
    const firstNavigationButton = contrastPage.locator(".sidebar-item").first();
    await firstNavigationButton.focus();
    const focusStyle = await firstNavigationButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThanOrEqual(
      2,
    );
  } finally {
    await contrastContext.close();
  }
});
