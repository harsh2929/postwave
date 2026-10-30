import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const PROGRAM = {
  id: "77777777-7777-4777-8777-777777777777",
  tenantId: "referrals-qualification-tenant",
  active: true,
  milestones: [
    {
      count: 3,
      reward_label: "Studio notebook",
      reward_kind: "swag",
    },
    {
      count: 10,
      reward_label: "One month membership",
      reward_kind: "free",
    },
    {
      count: 25,
      reward_label: "Annual membership",
      reward_kind: "annual",
    },
  ],
  expiresAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-05-10T08:30:00.000Z",
  updatedAt: "2026-07-25T10:15:00.000Z",
  verification_window_days: 7,
} as const;

const STATS = {
  funnel: {
    conversions_7d: 24,
    conversions_30d: 91,
    conversions_90d: 238,
    clicks_total: 2_481,
    fraud_filtered_count: 37,
  },
  top_referrers: [
    {
      subscriber_id: "8d42a190-historical-referrer-01",
      count: 42,
      last_at: "2026-07-24T13:05:00.000Z",
    },
    {
      subscriber_id: "f0c31b72-historical-referrer-02",
      count: 31,
      last_at: "2026-07-23T09:40:00.000Z",
    },
  ],
  recent: [
    {
      referrer_id: "8d42a190-historical-referrer-01",
      referee_id: "22ab98d1-historical-referee-91",
      created_at: "2026-07-24T13:05:00.000Z",
    },
    {
      referrer_id: "f0c31b72-historical-referrer-02",
      referee_id: "7c198ee4-historical-referee-90",
      created_at: "2026-07-23T09:40:00.000Z",
    },
  ],
} as const;

const LEADERS = [
  {
    referrer_email_masked: "a***@studio.example",
    conversions: 42,
    milestone: 25,
    rank: 1,
  },
  {
    referrer_email_masked: "m***@field.example",
    conversions: 31,
    milestone: 10,
    rank: 2,
  },
] as const;

type ProgramMode = "empty" | "failure" | "ready";
type ReferralRole = "admin" | "editor" | "viewer";

interface ReferralHarnessOptions {
  programMode?: ProgramMode;
  role?: ReferralRole;
}

interface ReferralHarness {
  allowedReads: string[];
  mutationRequests: string[];
  payoutReads: string[];
  publicRequests: string[];
  setProgramMode: (mode: ProgramMode) => void;
  subscriberReferralReads: string[];
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installReferralHarness(
  page: Page,
  options: ReferralHarnessOptions = {},
): Promise<ReferralHarness> {
  let programMode = options.programMode ?? "ready";
  const role = options.role ?? "admin";
  const allowedReads: string[] = [];
  const mutationRequests: string[] = [];
  const payoutReads: string[] = [];
  const publicRequests: string[] = [];
  const subscriberReferralReads: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: `referrals-${role}`,
        tenant_id: "referrals-qualification-tenant",
        email: `${role}@referrals.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Referrals qualification",
        workspace_slug: "referrals-qualification",
      });
      return;
    }

    if (pathname === "/api/v1/dashboard/layout" && method === "GET") {
      await json(route, {
        userId: `referrals-${role}`,
        tenantId: "referrals-qualification-tenant",
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
        updatedAt: "2026-07-26T10:00:00.000Z",
      });
      return;
    }

    const isReferralMutation =
      method !== "GET" &&
      (pathname.startsWith("/api/v1/referral-programs") ||
        pathname.startsWith("/api/v1/referrals") ||
        /\/api\/v1\/subscribers\/[^/]+\/referral(?:\/|$)/u.test(pathname));
    if (isReferralMutation) {
      mutationRequests.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "qualification_mutation_blocked",
            message: "Referral qualification never commits mutations.",
          },
        },
        409,
      );
      return;
    }

    if (pathname.startsWith("/api/v1/referrals/payouts")) {
      payoutReads.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "qualification_payout_read_blocked",
            message: "The payout read must not be requested.",
          },
        },
        409,
      );
      return;
    }

    if (/\/api\/v1\/subscribers\/[^/]+\/referral(?:\/|$)/u.test(pathname)) {
      subscriberReferralReads.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "qualification_subscriber_referral_blocked",
            message: "The token-minting read must not be requested.",
          },
        },
        409,
      );
      return;
    }

    if (pathname.startsWith("/api/public/r/")) {
      publicRequests.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "qualification_public_referral_blocked",
            message: "Public referral delivery must not be requested.",
          },
        },
        409,
      );
      return;
    }

    if (pathname === "/api/v1/referral-programs/current" && method === "GET") {
      allowedReads.push(`${method} ${pathname}`);
      if (programMode === "empty") {
        await json(
          route,
          {
            error: {
              code: "not_found",
              message: "No active referral program is configured.",
            },
          },
          404,
        );
        return;
      }
      if (programMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "referral_program_unavailable",
              message: "The program snapshot service is unavailable.",
            },
          },
          503,
        );
        return;
      }
      await json(route, PROGRAM);
      return;
    }

    if (pathname === "/api/v1/referrals/stats" && method === "GET") {
      allowedReads.push(`${method} ${pathname}`);
      await json(route, STATS);
      return;
    }

    if (pathname === "/api/v1/referrals/leaderboard" && method === "GET") {
      allowedReads.push(`${method} ${pathname}`);
      const rawWindow = url.searchParams.get("window") ?? "90d";
      const windowDays = Number.parseInt(rawWindow.replace(/\D/gu, ""), 10);
      await json(route, {
        window_days: Number.isFinite(windowDays) ? windowDays : 90,
        items: LEADERS,
      });
      return;
    }

    await route.fallback();
  });

  return {
    allowedReads,
    mutationRequests,
    payoutReads,
    publicRequests,
    setProgramMode: (mode) => {
      programMode = mode;
    },
    subscriberReferralReads,
  };
}

async function openReferrals(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: ReferralHarnessOptions & {
    height?: number;
    theme?: "dark" | "light";
    width?: number;
  } = {},
): Promise<ReferralHarness> {
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await setTheme(page, options.theme ?? "dark");
  await bootApp(page);
  const harness = await installReferralHarness(page, options);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="referrals"]');
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Understand your referral history. Qualify the loop before launch.",
      exact: true,
    }),
  ).toBeVisible();
  return harness;
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
) {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ disableColorContrast }) => {
    const axe = (
      window as typeof window & {
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
    const result = await axe.run(".ref-page", {
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
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
  }, options);
}

async function expectNoRootHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const referrals = document.querySelector<HTMLElement>(".ref-page");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
      referrals: referrals
        ? referrals.scrollWidth - referrals.clientWidth
        : 999,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.referrals).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

function expectNoUnsafeRequests(harness: ReferralHarness): void {
  expect(harness.mutationRequests).toEqual([]);
  expect(harness.payoutReads).toEqual([]);
  expect(harness.subscriberReferralReads).toEqual([]);
  expect(harness.publicRequests).toEqual([]);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { resetScroll?: boolean } = {},
): Promise<void> {
  if (options.resetScroll !== false) {
    await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>(".content");
      if (!content) return;
      const previousBehavior = content.style.scrollBehavior;
      content.style.scrollBehavior = "auto";
      content.scrollTop = 0;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      content.style.scrollBehavior = previousBehavior;
    });
  }
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const theme of ["dark", "light"] as const) {
  test(`populated historical inspection is truthful and contained in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openReferrals(page, bootApp, setTheme, { theme });

    await expect(
      page.getByRole("table", {
        name: "Stored referral program milestones",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Configuration evidence only:", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("Captured clicks", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Fraud-filtered records", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("2,481", { exact: true })).toBeVisible();
    await expect(page.getByText("37", { exact: true }).first()).toBeVisible();

    const edit = page.getByRole("button", {
      name: "Edit program",
      exact: true,
    });
    const install = page.getByRole("button", {
      name: "Install on website",
      exact: true,
    });
    await expect(edit).toHaveAttribute("aria-disabled", "true");
    await expect(install).toHaveAttribute("aria-disabled", "true");
    await edit.click({ force: true });
    await install.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const advocates = page.getByRole("tab", { name: /^Advocates/u });
    await advocates.click();
    await expect(
      page.getByRole("table", { name: "Referral leaderboard" }),
    ).toBeVisible();
    await expect(
      page.getByText("a***@studio.example", { exact: true }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /^Overview/u }).click();
    await expect(
      page.getByRole("table", {
        name: "Stored referral program milestones",
      }),
    ).toBeVisible();

    expectNoUnsafeRequests(harness);
    await expectNoRootHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await capture(page, testInfo, `referrals-populated-${theme}`);
    if (theme === "light") {
      await page
        .locator('[role="tabpanel"]:not([hidden])')
        .scrollIntoViewIfNeeded();
      await capture(page, testInfo, "referrals-overview-data-light", {
        resetScroll: false,
      });
    }
  });
}

test("verified empty state does not imply a live program or open creation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openReferrals(page, bootApp, setTheme, {
    programMode: "empty",
    theme: "light",
  });

  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No active program snapshot" }),
  ).toBeVisible();
  await expect(page.getByText("Verified empty", { exact: true })).toBeVisible();
  const create = page.getByRole("button", {
    name: "Create program",
    exact: true,
  });
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await create.click({ force: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("table", { name: "Stored referral program milestones" }),
  ).toHaveCount(0);
  expectNoUnsafeRequests(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await capture(page, testInfo, "referrals-empty-light");
});

test("hard program failure is explicit and recovers without fabricating state", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openReferrals(page, bootApp, setTheme, {
    programMode: "failure",
  });

  await expect(
    page.locator(".ref-status-chip").getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("alert").filter({
      hasText: "The referral program is unavailable.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No verified program snapshot" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Stored referral program milestones" }),
  ).toHaveCount(0);

  const readsBeforeRecovery = harness.allowedReads.filter((request) =>
    request.includes("referral-programs/current"),
  ).length;
  harness.setProgramMode("ready");
  await page
    .getByRole("button", { name: "Refresh program", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Stored referral program milestones" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".ref-status-chip")
      .getByText("Snapshot verified", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        harness.allowedReads.filter((request) =>
          request.includes("referral-programs/current"),
        ).length,
    )
    .toBeGreaterThan(readsBeforeRecovery);
  expectNoUnsafeRequests(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("failed refresh retains the last verified snapshot and locks program actions", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openReferrals(page, bootApp, setTheme);
  const table = page.getByRole("table", {
    name: "Stored referral program milestones",
  });
  await expect(table).toBeVisible();

  harness.setProgramMode("failure");
  await page
    .getByRole("button", { name: "Refresh program", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText: "Refresh failed; showing the last verified program.",
    }),
  ).toBeVisible();
  await expect(table).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Edit program", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Last verified", { exact: true })).toBeVisible();
  expectNoUnsafeRequests(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

for (const role of ["admin", "editor", "viewer"] as const) {
  test(`${role} access contains program, reward, subscriber-link, and public-delivery actions`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openReferrals(page, bootApp, setTheme, { role });
    const install = page.getByRole("button", {
      name: "Install on website",
      exact: true,
    });
    await expect(install).toHaveAttribute("aria-disabled", "true");
    await install.click({ force: true });

    const edit = page.getByRole("button", {
      name: "Edit program",
      exact: true,
    });
    if (role === "admin") {
      await expect(edit).toHaveAttribute("aria-disabled", "true");
      await edit.click({ force: true });
    } else {
      await expect(edit).toHaveCount(0);
      await expect(
        page.getByText("Read-only access", { exact: true }),
      ).toBeVisible();
    }

    await page.getByRole("tab", { name: /^Rewards/u }).click();
    const payout = page.getByRole("button", {
      name: "Open payout queue",
      exact: true,
    });
    await expect(payout).toHaveAttribute("aria-disabled", "true");
    await payout.click({ force: true });
    await expect(
      page.getByText(
        "Safe behavior now: zero payout reads and zero payout mutation controls are mounted from this workspace.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.getByRole("tab", { name: /^Distribution/u }).click();
    const widget = page.getByRole("button", {
      name: "Install widget",
      exact: true,
    });
    await expect(widget).toHaveAttribute("aria-disabled", "true");
    await widget.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expectNoUnsafeRequests(harness);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("workspace tabs use manual activation and retain safe read surfaces", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openReferrals(page, bootApp, setTheme);
  const tablist = page.getByRole("tablist", { name: "Referral workspaces" });
  const overview = tablist.getByRole("tab", { name: /^Overview/u });
  const advocates = tablist.getByRole("tab", { name: /^Advocates/u });
  const rewards = tablist.getByRole("tab", { name: /^Rewards/u });
  const distribution = tablist.getByRole("tab", { name: /^Distribution/u });

  await expect(overview).toHaveAttribute("aria-selected", "true");
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(advocates).toBeFocused();
  await expect(advocates).toHaveAttribute("aria-selected", "false");
  await expect(overview).toHaveAttribute("aria-selected", "true");

  await advocates.press("Enter");
  await expect(advocates).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("table", { name: "Referral leaderboard" }),
  ).toBeVisible();

  await advocates.press("ArrowRight");
  await expect(rewards).toBeFocused();
  await rewards.press("Space");
  await expect(rewards).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Reward operations stay closed",
    }),
  ).toBeVisible();

  await rewards.press("End");
  await expect(distribution).toBeFocused();
  await expect(rewards).toHaveAttribute("aria-selected", "true");
  await distribution.press("Enter");
  await expect(distribution).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Know what is inspectable—and what is not yet releasable.",
    }),
  ).toBeVisible();

  await distribution.press("Home");
  await expect(overview).toBeFocused();
  await expect(distribution).toHaveAttribute("aria-selected", "true");
  expect(
    harness.allowedReads.some((request) => request.includes("/stats")),
  ).toBe(true);
  expect(
    harness.allowedReads.some((request) => request.includes("/leaderboard")),
  ).toBe(true);
  expectNoUnsafeRequests(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("880 by 560 reduced motion and 200-percent proxy reflow stay operable", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openReferrals(page, bootApp, setTheme, {
    height: 560,
    theme: "light",
    width: 880,
  });

  const animationNames = await page
    .locator(".ref-growth-steps")
    .evaluate((node) => [
      getComputedStyle(node, "::after").animationName,
      getComputedStyle(node).animationName,
    ]);
  expect(animationNames.every((name) => name === "none")).toBe(true);
  await expectNoRootHorizontalOverflow(page);
  await capture(page, testInfo, "referrals-880x560-reduced-motion");

  // Chromium does not expose an installed-app zoom control. 440×280 CSS
  // pixels models the layout pressure of an 880×560 window at 200%.
  await page.setViewportSize({ width: 440, height: 280 });
  const install = page.getByRole("button", {
    name: "Install on website",
    exact: true,
  });
  await install.scrollIntoViewIfNeeded();
  const installBox = await install.boundingBox();
  expect(installBox).not.toBeNull();
  expect(installBox!.width).toBeGreaterThanOrEqual(40);
  expect(installBox!.height).toBeGreaterThanOrEqual(40);

  const overview = page.getByRole("tab", { name: /^Overview/u });
  await overview.scrollIntoViewIfNeeded();
  const tabBox = await overview.boundingBox();
  expect(tabBox).not.toBeNull();
  expect(tabBox!.width).toBeGreaterThanOrEqual(40);
  expect(tabBox!.height).toBeGreaterThanOrEqual(40);
  await expectNoRootHorizontalOverflow(page);
  expectNoUnsafeRequests(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.locator(".ref-hero").evaluate((element) => {
    element.scrollIntoView({ block: "start", behavior: "auto" });
  });
  await capture(page, testInfo, "referrals-200-percent-proxy", {
    resetScroll: false,
  });
});

test("forced colors preserve selected, focused, and review-gated distinctions", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  const harness = await openReferrals(page, bootApp, setTheme, {
    theme: "dark",
  });
  const overview = page.getByRole("tab", { name: /^Overview/u });
  const advocates = page.getByRole("tab", { name: /^Advocates/u });
  await overview.focus();
  await overview.press("ArrowRight");
  await expect(advocates).toBeFocused();

  const colors = await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(
      '.ref-workspace-tabs [role="tab"].is-selected',
    );
    const focused = document.activeElement as HTMLElement | null;
    const gated = document.querySelector<HTMLElement>(
      '.ref-hero-actions [aria-disabled="true"]',
    );
    if (!active || !focused || !gated) {
      throw new Error("Missing Referrals forced-color evidence targets.");
    }
    const probe = document.createElement("span");
    probe.style.cssText =
      "color: GrayText; background: Highlight; border: 1px solid Highlight; forced-color-adjust: none";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const activeStyle = getComputedStyle(active);
    const focusedStyle = getComputedStyle(focused);
    const gatedStyle = getComputedStyle(gated);
    const result = {
      activeOutline: activeStyle.outlineColor,
      focusedOutline: focusedStyle.outlineColor,
      gatedColor: gatedStyle.color,
      grayText: expected.color,
      highlight: expected.backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(colors.activeOutline).toBe(colors.highlight);
  expect(colors.focusedOutline).toBe(colors.highlight);
  expect(colors.gatedColor).toBe(colors.grayText);
  expectNoUnsafeRequests(harness);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await capture(page, testInfo, "referrals-forced-colors");
});
