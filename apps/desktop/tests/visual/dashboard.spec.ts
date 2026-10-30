import type { ConsoleMessage, Locator, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const VIEWPORTS = [
  { name: "minimum", width: 880, height: 560 },
  { name: "compact", width: 1100, height: 720 },
  { name: "standard", width: 1280, height: 800 },
  { name: "large", width: 1600, height: 1000 },
] as const;

type DashboardRange = "7d" | "30d" | "90d";

interface RuntimeGuard {
  errors: string[];
  expectedResourceFailureUrlSubstrings: Set<string>;
  onConsole: (message: ConsoleMessage) => void;
  onPageError: (error: Error) => void;
}

const runtimeGuards = new WeakMap<Page, RuntimeGuard>();

test.beforeEach(({ page }) => {
  const guard: RuntimeGuard = {
    errors: [],
    expectedResourceFailureUrlSubstrings: new Set(),
    onConsole: (message) => {
      if (message.type() !== "error") return;
      const resourceUrl = message.location().url;
      if (
        message.text().startsWith("Failed to load resource:") &&
        [...guard.expectedResourceFailureUrlSubstrings].some((substring) =>
          resourceUrl.includes(substring),
        )
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

function allowExpectedResourceLoadFailures(
  page: Page,
  ...urlSubstrings: string[]
): void {
  const guard = runtimeGuards.get(page);
  if (!guard) {
    throw new Error("Dashboard runtime guard was not installed");
  }
  for (const substring of urlSubstrings) {
    guard.expectedResourceFailureUrlSubstrings.add(substring);
  }
}

test.afterEach(({ page }) => {
  const guard = runtimeGuards.get(page);
  if (!guard) return;
  page.off("console", guard.onConsole);
  page.off("pageerror", guard.onPageError);
  runtimeGuards.delete(page);
  expect(guard.errors, "Dashboard emitted renderer runtime errors").toEqual([]);
});

async function openDashboard(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  theme: "system" | "dark" | "light",
  configureRoutes?: () => Promise<void>,
): Promise<void> {
  await setTheme(page, theme);
  await bootApp(page);
  await installHealthyDashboardStatsStub(page);
  await installHealthyDashboardAnomalyStub(page);
  await installHealthyDashboardLayoutStub(page);
  await configureRoutes?.();
  const layoutResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.method() === "GET" &&
      new URL(response.url()).pathname === "/api/v1/dashboard/layout"
    );
  });
  await page.goto("/");
  await layoutResponse;
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }).first(),
  ).toBeVisible();
  await page.evaluate(async () => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: true,
    }),
  ).toHaveCount(0);
}

function healthyDashboardStats(range: DashboardRange): Record<string, unknown> {
  return {
    subscribers_total: 12_482,
    subscribers_added_30d: 418,
    subscribers_unsubbed_30d: 96,
    campaigns_sent_30d: 8,
    emails_sent_30d: 62_400,
    opens_total_30d: 26_270,
    clicks_total_30d: 5_242,
    bounces_total_30d: 374,
    unique_opens_30d: 26_113,
    unique_clicks_30d: 5_210,
    unique_bounces_30d: 374,
    unique_delivered_30d: 62_026,
    unique_sent_30d: 62_400,
    active_sequences_count: 4,
    range,
    previous: {
      subscribers_added: 371,
      subscribers_unsubbed: 112,
      campaigns_sent: 7,
      emails_sent: 59_200,
      opens_total: 23_502,
      clicks_total: 4_440,
      bounces_total: 474,
      unique_opens: 23_315,
      unique_clicks: 4_415,
      unique_bounces: 474,
      unique_delivered: 58_726,
      unique_sent: 59_200,
    },
    sparklines: {
      subscribers: [11_980, 12_044, 12_117, 12_165, 12_241, 12_386, 12_482],
      opens: [3_420, 3_812, 3_610, 4_042, 3_774, 3_966, 3_646],
      clicks: [612, 748, 701, 804, 776, 850, 751],
      bounces: [68, 54, 61, 49, 52, 46, 44],
    },
    anomalies: { opens: false, clicks: false, bounces: false },
    recent_audit: [
      {
        id: "audit-visual-1",
        action: "campaign.sent",
        actor: "visual-test@example.invalid",
        at: "2026-07-18T07:30:00.000Z",
        description: "Summer launch sent",
      },
      {
        id: "audit-visual-2",
        action: "sequence.activated",
        actor: "visual-test@example.invalid",
        at: "2026-07-18T06:45:00.000Z",
        description: "Welcome journey activated",
      },
    ],
  };
}

async function installHealthyDashboardStatsStub(page: Page): Promise<void> {
  await page.route("**/api/v1/dashboard/stats**", async (route) => {
    const requestedRange = new URL(route.request().url()).searchParams.get(
      "range",
    );
    const range: DashboardRange =
      requestedRange === "7d" || requestedRange === "90d"
        ? requestedRange
        : "30d";
    await fulfillJson(route, healthyDashboardStats(range));
  });
}

async function installHealthyDashboardAnomalyStub(page: Page): Promise<void> {
  await page.route("**/api/v1/dashboard/anomalies**", async (route) => {
    await fulfillJson(route, { items: [] });
  });
}

async function installHealthyDashboardLayoutStub(page: Page): Promise<void> {
  await page.route("**/api/v1/dashboard/layout**", async (route) => {
    if (route.request().method() === "PUT") {
      await fulfillJson(route, { ok: true });
      return;
    }
    await fulfillJson(route, {
      userId: "visual-user",
      tenantId: "test-tenant",
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
    });
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
}

async function expectNoOverlap(first: Locator, second: Locator): Promise<void> {
  const [firstBox, secondBox] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
  ]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  if (!firstBox || !secondBox) return;
  const overlaps =
    firstBox.x < secondBox.x + secondBox.width &&
    firstBox.x + firstBox.width > secondBox.x &&
    firstBox.y < secondBox.y + secondBox.height &&
    firstBox.y + firstBox.height > secondBox.y;
  expect(overlaps, "Fixed help launcher obscured Dashboard content").toBe(
    false,
  );
}

async function focusWithKeyboard(
  page: Page,
  target: Locator,
  maxTabs = 40,
): Promise<void> {
  for (let index = 0; index < maxTabs; index += 1) {
    const focused = await target.evaluate(
      (node) => document.activeElement === node,
    );
    if (focused) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

const STATS_FAILURE_CASES = [
  {
    kind: "offline",
    theme: "light",
    initialTitle: "Dashboard is offline.",
    action: "Retry connection",
    retainedTitle: "Refresh paused while offline.",
  },
  {
    kind: "access",
    theme: "dark",
    initialTitle: "Workspace metrics are restricted.",
    action: "Check access again",
    retainedTitle: "Latest metrics are restricted.",
  },
  {
    kind: "unavailable",
    theme: "dark",
    initialTitle: "Dashboard reporting isn’t available here.",
    action: "Check availability",
    retainedTitle: "Latest reporting is unavailable.",
  },
  {
    kind: "invalid",
    theme: "dark",
    initialTitle: "Workspace metrics couldn’t be verified.",
    action: "Retry metrics",
    retainedTitle: "Latest metrics couldn’t be verified.",
  },
] as const;

type StatsFailureCase = (typeof STATS_FAILURE_CASES)[number];

async function setBrowserOnline(page: Page, online: boolean): Promise<void> {
  await page.evaluate((nextOnline) => {
    Object.defineProperty(Navigator.prototype, "onLine", {
      configurable: true,
      get: () => nextOnline,
    });
    window.dispatchEvent(new Event(nextOnline ? "online" : "offline"));
  }, online);
}

async function fulfillStatsFailure(
  page: Page,
  route: Route,
  failure: StatsFailureCase,
): Promise<void> {
  const privateDetail = `private-stats-${failure.kind}-infrastructure-detail`;
  if (failure.kind === "offline") {
    await setBrowserOnline(page, false);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: privateDetail } }),
    });
    return;
  }
  if (failure.kind === "access") {
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: privateDetail } }),
    });
    return;
  }
  if (failure.kind === "unavailable") {
    await route.abort("failed");
    return;
  }
  const range = new URL(route.request().url()).searchParams.get("range");
  await fulfillJson(route, {
    range: range ?? "30d",
    subscribers_total: privateDetail,
  });
}

async function installBelowFoldDashboardStubs(page: Page): Promise<void> {
  const responses: Record<string, unknown> = {
    "/api/v1/goals/progress": {
      as_of: "2026-07-18T08:00:00.000Z",
      progress: [
        {
          goal: {
            id: "goal-audience-visual",
            name: "Grow the audience",
            metric: "subscribers",
            target: 15_000,
            period: "quarterly",
            starts_at: "2026-07-01T00:00:00.000Z",
            created_by: "visual-user",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-18T08:00:00.000Z",
          },
          current: 12_482,
          target: 15_000,
          pct: 0.8321,
          pace: "on_track",
          period_start: "2026-07-01T00:00:00.000Z",
          period_end: "2026-09-30T23:59:59.000Z",
          as_of: "2026-07-18T08:00:00.000Z",
        },
        {
          goal: {
            id: "goal-open-rate-visual",
            name: "Sustain quality engagement",
            metric: "open_rate",
            target: 45,
            period: "monthly",
            starts_at: "2026-07-01T00:00:00.000Z",
            created_by: "visual-user",
            created_at: "2026-07-01T00:00:00.000Z",
            updated_at: "2026-07-18T08:00:00.000Z",
          },
          current: 42.1,
          target: 45,
          pct: 0.9356,
          pace: "ahead",
          period_start: "2026-07-01T00:00:00.000Z",
          period_end: "2026-07-31T23:59:59.000Z",
          as_of: "2026-07-18T08:00:00.000Z",
        },
      ],
    },
    "/api/v1/dashboard/benchmarks": {
      rows: [
        {
          metric: "opens",
          average: 0.381,
          source: "Moosewave commerce cohort · trailing 30 days",
        },
        {
          metric: "clicks",
          average: 0.071,
          source: "Moosewave commerce cohort · trailing 30 days",
        },
        {
          metric: "bounces",
          average: 0.009,
          source: "Moosewave commerce cohort · trailing 30 days",
        },
      ],
      note: "Illustrative industry baseline for established commerce senders.",
    },
    "/api/mailchimp/3.0/campaign-manager/calendar": {
      touchpoints: [{ id: "email" }, { id: "social" }, { id: "retarget" }],
      tasks: [{ id: "copy" }, { id: "approval" }, { id: "schedule" }],
    },
    "/api/mailchimp/3.0/audience/insights": {
      segment_dimensions: ["lifecycle", "engagement", "value", "region"],
    },
    "/api/mailchimp/3.0/content-studio": {
      files: [{ id: "hero" }, { id: "product-grid" }, { id: "logo" }],
      status: "ready to use",
    },
    "/api/mailchimp/3.0/growth/channels": {
      channels: ["email", "sms", "social"],
    },
    "/api/v1/clv-dashboard": {
      profile_count: 12_482,
      scored_profiles: 10_936,
      total_clv_cents: 1_363_732_400,
      predicted_clv_cents: 286_450_000,
      avg_total_clv_cents: 109_256,
      percentiles: {
        p10_cents: 11_900,
        p25_cents: 28_400,
        p50_cents: 63_700,
        p75_cents: 112_500,
        p90_cents: 189_000,
        p99_cents: 426_000,
      },
      tiers: [
        {
          key: "champions",
          label: "Champions",
          profiles: 1_842,
          avg_total_clv_cents: 214_800,
          avg_churn_risk: 0.08,
        },
        {
          key: "high_value",
          label: "High value",
          profiles: 3_406,
          avg_total_clv_cents: 128_300,
          avg_churn_risk: 0.18,
        },
        {
          key: "growth",
          label: "Growth",
          profiles: 5_813,
          avg_total_clv_cents: 62_100,
          avg_churn_risk: 0.27,
        },
        {
          key: "at_risk",
          label: "At risk",
          profiles: 1_421,
          avg_total_clv_cents: 119_700,
          avg_churn_risk: 0.67,
        },
      ],
      top_profiles: [
        {
          email: "champion-01@example.invalid",
          subscriber_id: "visual-clv-1",
          total_clv_cents: 648_900,
          churn_risk: 0.04,
          segment_key: "champions",
        },
        {
          email: "champion-02@example.invalid",
          subscriber_id: "visual-clv-2",
          total_clv_cents: 512_400,
          churn_risk: 0.09,
          segment_key: "high_value",
        },
      ],
      at_risk_profiles: [
        {
          email: "priority-save@example.invalid",
          subscriber_id: "visual-clv-risk-1",
          total_clv_cents: 384_200,
          churn_risk: 0.78,
          segment_key: "at_risk",
        },
      ],
      last_calculated_at: "2026-07-18T07:45:00.000Z",
    },
  };

  await page.route("**/api/**", async (route) => {
    const response = responses[new URL(route.request().url()).pathname];
    if (response === undefined) {
      await route.fallback();
      return;
    }
    await fulfillJson(route, response);
  });
}

async function scrollDashboardTarget(
  page: Page,
  target: Locator,
): Promise<number> {
  await target.waitFor({ state: "attached" });
  const scrollTop = await target.evaluate((node) => {
    const scroller = node.closest<HTMLElement>(".content");
    if (!scroller) throw new Error("Dashboard content scroller was not found");
    const scrollerRect = scroller.getBoundingClientRect();
    const targetRect = node.getBoundingClientRect();
    scroller.style.scrollBehavior = "auto";
    scroller.scrollTop =
      scroller.scrollTop + targetRect.top - scrollerRect.top - 24;
    return scroller.scrollTop;
  });
  await expect(target).toBeVisible();
  await expectNoHorizontalOverflow(page);
  return scrollTop;
}

for (const theme of ["dark", "light"] as const) {
  for (const viewport of VIEWPORTS) {
    test(`dashboard-populated-${theme}-${viewport.name}`, async ({
      page,
      bootApp,
      setTheme,
    }) => {
      await page.setViewportSize(viewport);
      await openDashboard(page, bootApp, setTheme, theme);
      await expect(
        page.locator("#dashboard-metrics").getByText("12,482", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "Finish setting up your workspace",
          exact: true,
        }),
      ).toBeVisible();
      const launcher = page.locator(".tour-launcher");
      await expect(launcher).toBeVisible();
      expect(
        await launcher.evaluate((node) =>
          node.parentElement?.classList.contains("topbar"),
        ),
      ).toBe(true);
      await expectNoOverlap(launcher, page.locator(".pw-dashboard"));
      if (viewport.name === "large") {
        const rateCardHeights = await page
          .locator("#dashboard-metrics .dash-stat-card")
          .evaluateAll((cards) =>
            cards.slice(1).map((card) => card.getBoundingClientRect().height),
          );
        expect(rateCardHeights).toHaveLength(3);
        expect(Math.max(...rateCardHeights)).toBeLessThanOrEqual(190);
      }
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(
        `dashboard-populated-${theme}-${viewport.name}.png`,
      );
      if (viewport.name === "large") {
        const launcher = page.getByRole("button", {
          name: /Open help for this screen/,
        });
        await launcher.click();
        const panel = page.getByRole("dialog", {
          name: "Help for this screen",
        });
        await expect(panel).toBeVisible();
        await expectNoOverlap(panel, page.locator(".content"));
        await page.keyboard.press("Escape");
        await expect(panel).toHaveCount(0);
      }
    });
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`dashboard-empty-${theme}`, async ({ page, bootApp, setTheme }) => {
    await openDashboard(page, bootApp, setTheme, theme, async () => {
      await page.route("**/api/v1/dashboard/stats**", async (route) => {
        const range = new URL(route.request().url()).searchParams.get("range");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            range: range ?? "30d",
            subscribers_total: 0,
            subscribers_added_30d: 0,
            campaigns_sent_30d: 0,
            emails_sent_30d: 0,
            opens_total_30d: 0,
            clicks_total_30d: 0,
            bounces_total_30d: 0,
            unique_opens_30d: 0,
            unique_clicks_30d: 0,
            unique_bounces_30d: 0,
            unique_delivered_30d: 0,
            unique_sent_30d: 0,
            previous: {
              unique_opens: 0,
              unique_clicks: 0,
              unique_bounces: 0,
              unique_delivered: 0,
              unique_sent: 0,
            },
            sparklines: {},
            anomalies: {},
            recent_audit: [],
          }),
        });
      });
    });
    const values = page.locator("#dashboard-metrics .stat-value");
    await expect(values).toHaveText(["0", "—", "—", "—"]);
    await expect(
      page.locator("#dashboard-metrics .stat-evidence-status"),
    ).toHaveText([
      "No verified delivery evidence",
      "No verified delivery evidence",
      "No verified send evidence",
    ]);
    await expect(page.locator("#dashboard-metrics .dash-ask-why")).toHaveCount(
      3,
    );
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot(`dashboard-empty-${theme}.png`);
  });
}

test("dashboard-initial-loading-dark", async ({ page, bootApp, setTheme }) => {
  await openDashboard(page, bootApp, setTheme, "dark", async () => {
    await page.route("**/api/v1/dashboard/stats**", async () => {
      await new Promise<never>(() => undefined);
    });
  });
  await expect(page.locator("#dashboard-metrics")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("dashboard-initial-loading-dark.png");
});

test("dashboard-load-error-dark", async ({ page, bootApp, setTheme }) => {
  allowExpectedResourceLoadFailures(page, "/api/v1/dashboard/stats");
  await openDashboard(page, bootApp, setTheme, "dark", async () => {
    await page.route("**/api/v1/dashboard/stats**", async (route) => {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "sensitive upstream detail" }),
      });
    });
  });
  await expect(
    page.getByText("Workspace metrics are temporarily unavailable."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry metrics" }),
  ).toBeVisible();
  await expect(page.getByText("sensitive upstream detail")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("dashboard-load-error-dark.png");
});

for (const failure of STATS_FAILURE_CASES) {
  test(`dashboard-stats-${failure.kind}-initial-and-retained`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    let phase: "failure" | "success" = "failure";
    allowExpectedResourceLoadFailures(page, "/api/v1/dashboard/stats");
    await openDashboard(page, bootApp, setTheme, failure.theme, async () => {
      await page.route("**/api/v1/dashboard/stats**", async (route) => {
        if (phase === "failure") {
          await fulfillStatsFailure(page, route, failure);
          return;
        }
        const requestedRange = new URL(route.request().url()).searchParams.get(
          "range",
        );
        const range: DashboardRange =
          requestedRange === "7d" || requestedRange === "90d"
            ? requestedRange
            : "30d";
        await fulfillJson(route, healthyDashboardStats(range));
      });
    });

    await expect(
      page.getByText(failure.initialTitle, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    const recovery = page.getByRole("button", {
      name: failure.action,
      exact: true,
    });
    await expect(recovery).toBeVisible();
    await expect(page.locator("#dashboard-metrics")).toHaveCount(0);
    await expect(
      page.getByText(`private-stats-${failure.kind}-infrastructure-detail`),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    if (failure.kind === "invalid") {
      await expect(page).toHaveScreenshot(
        "dashboard-stats-invalid-initial-dark.png",
      );
    }

    phase = "success";
    if (failure.kind === "offline") {
      // Reconnection resumes the paused query automatically. Keeping a stale
      // locator to the now-replaced offline recovery action would turn that
      // correct lifecycle transition into a test-only detached-node race.
      await setBrowserOnline(page, true);
    } else {
      await recovery.focus();
      await recovery.press("Enter");
    }
    await expect(
      page.locator("#dashboard-metrics").getByText("12,482", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".dash-load-error")).toHaveCount(0);

    phase = "failure";
    if (failure.kind === "offline") await setBrowserOnline(page, false);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByText(failure.retainedTitle, { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator("#dashboard-metrics").getByText("12,482", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".dash-refresh-warning")).toContainText(
      "Showing the last confirmed metrics.",
    );
    await expect(
      page.getByText(`private-stats-${failure.kind}-infrastructure-detail`),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    if (failure.kind === "offline") {
      await expect(page.locator(".statusbar")).toContainText("Disconnected");
      await expect(page).toHaveScreenshot(
        "dashboard-stats-offline-retained-light.png",
      );
    }
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`dashboard-edit-layout-${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await openDashboard(page, bootApp, setTheme, theme);
    await page
      .getByRole("button", { name: "Rearrange the dashboard's card sections" })
      .click();
    await expect(
      page.getByText("Rearrange metrics and sections"),
    ).toBeVisible();
    const moveSubscribersLater = page.getByRole("button", {
      name: "Move Subscribers later",
    });
    await expect(moveSubscribersLater).toBeVisible();
    await focusWithKeyboard(page, moveSubscribersLater);
    await expect(moveSubscribersLater).toBeFocused();
    const focusStyle = await moveSubscribersLater.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        focusVisible: node.matches(":focus-visible"),
        boxShadow: style.boxShadow,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focusStyle.focusVisible).toBe(true);
    expect(focusStyle.boxShadow).not.toBe("none");
    expect(focusStyle.outlineStyle).toBe("solid");
    expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
    await expectNoHorizontalOverflow(page);
    await expect(page).toHaveScreenshot(`dashboard-edit-layout-${theme}.png`);
  });
}

test("dashboard-expanded-setup-light", async ({ page, bootApp, setTheme }) => {
  await openDashboard(page, bootApp, setTheme, "light");
  await page.getByRole("button", { name: "View all steps" }).click();
  const pathToFirstSend = page.getByText("Path to your first send", {
    exact: true,
  });
  await expect(pathToFirstSend).toBeVisible();
  await expect(page.getByRole("button", { name: /Show less/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const expandedChecklist = page.locator(".checklist-compact-expanded");
  await expect(expandedChecklist).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expect(expandedChecklist).toHaveScreenshot(
    "dashboard-expanded-setup-light.png",
  );
});

test("dashboard-200-percent-reflow-light", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 440, height: 280 });
  await openDashboard(page, bootApp, setTheme, "light");
  await expectNoOverlap(
    page.locator(".tour-launcher"),
    page.locator(".pw-dashboard"),
  );
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("dashboard-200-percent-reflow-light.png");
});

test("dashboard-help-offline-minimum-light", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 880, height: 560 });
  await openDashboard(page, bootApp, setTheme, "light");
  await setBrowserOnline(page, false);
  await expect(page.locator(".offline-banner")).toContainText(
    "No network connection",
  );

  const launcher = page.locator(".tour-launcher");
  await expect(launcher).toHaveAccessibleName(/Open help for this screen/);
  await launcher.click();
  const panel = page.getByRole("dialog", { name: "Help for this screen" });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByText("Orient your workspace")).toBeVisible();
  await expectNoOverlap(launcher, page.locator(".pw-dashboard"));
  await expectNoOverlap(panel, page.locator(".offline-banner"));
  await expectNoOverlap(panel, page.locator(".statusbar"));
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot(
    "dashboard-help-offline-minimum-light.png",
  );
});

test("dashboard-long-copy-light", async ({ page, bootApp, setTheme }) => {
  await openDashboard(page, bootApp, setTheme, "light");
  await page.locator(".dash-hero-subtitle").evaluate((node) => {
    node.textContent =
      "Audience momentum, campaign engagement, deliverability health, and workspace readiness across every connected region and reporting source.";
  });
  await page.locator(".checklist-compact .checklist-title").evaluate((node) => {
    node.textContent =
      "Finish configuring your international production workspace";
  });
  await page.locator(".dash-section-context").evaluate((node) => {
    node.textContent =
      "Compared with the preceding 30-day reporting window. Open any metric to inspect its underlying audience and analytics evidence.";
  });
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot("dashboard-long-copy-light.png");
});

test("dashboard-forced-colors-and-reduced-motion", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openDashboard(page, bootApp, setTheme, "system");
  await page
    .getByRole("button", {
      name: "Rearrange the dashboard's card sections",
    })
    .click();
  const moveSubscribersLater = page.getByRole("button", {
    name: "Move Subscribers later",
  });
  await focusWithKeyboard(page, moveSubscribersLater);
  await expect(moveSubscribersLater).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot(
    "dashboard-forced-colors-reduced-motion.png",
  );
});

test("dashboard-range-change-keeps truthful provenance", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const requestedRanges: string[] = [];
  await openDashboard(page, bootApp, setTheme, "dark", async () => {
    await page.route("**/api/v1/dashboard/stats**", async (route) => {
      const requestedRange =
        new URL(route.request().url()).searchParams.get("range") ?? "30d";
      requestedRanges.push(requestedRange);
      const range: DashboardRange =
        requestedRange === "7d" || requestedRange === "90d"
          ? requestedRange
          : "30d";
      await fulfillJson(route, healthyDashboardStats(range));
    });
  });

  for (const selected of ["7d", "90d"] as const) {
    const accessibleName = selected === "7d" ? "Last 7 days" : "Last 90 days";
    await page.getByRole("button", { name: accessibleName }).click();
    await expect(
      page.getByText(
        new RegExp(`Compared with the preceding ${selected} window`),
      ),
    ).toBeVisible();
    await expect(
      page.locator("#dashboard-metrics").getByText("12,482", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel(
        new RegExp(`${accessibleName} metrics poll every 5 seconds`),
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Data freshness")).toContainText(
      "Polling every 5s",
    );
    await expect(
      page.getByText("Live updates on", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".dash-load-error")).toHaveCount(0);
  }

  expect(requestedRanges).toEqual(expect.arrayContaining(["30d", "7d", "90d"]));
  await expectNoHorizontalOverflow(page);
});

test("dashboard-campaign-failure-retry-and-retained-stale-dark", async ({
  page,
  bootApp,
  setTheme,
}) => {
  let phase: "initial-failure" | "success" | "stale-failure" =
    "initial-failure";
  allowExpectedResourceLoadFailures(page, "/api/v1/campaigns");
  await openDashboard(page, bootApp, setTheme, "dark", async () => {
    await page.route("**/api/v1/campaigns**", async (route) => {
      if (phase !== "success") {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "private campaign infrastructure detail" },
          }),
        });
        return;
      }
      await fulfillJson(route, {
        items: [
          {
            id: "campaign-retained-visual",
            name: "Last confirmed launch",
            subject: "A confirmed campaign row",
            status: "sent",
            sent_at: "2026-07-17T14:00:00.000Z",
            open_rate: 0.448,
            click_rate: 0.091,
          },
        ],
      });
    });
  });

  const campaigns = page.locator(".pw-dash-secondary-campaigns");
  await scrollDashboardTarget(
    page,
    page.getByRole("heading", { name: "Recent campaigns", exact: true }),
  );
  await expect(campaigns.getByRole("alert")).toContainText(
    "Recent campaigns are unavailable",
    { timeout: 15_000 },
  );
  await expect(campaigns.getByText("No campaigns yet")).toHaveCount(0);
  await expect(
    page.getByText("private campaign infrastructure detail"),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(campaigns).toHaveScreenshot(
    "dashboard-campaign-initial-failure-dark.png",
  );

  phase = "success";
  const retry = campaigns.getByRole("button", { name: "Try again" });
  await retry.focus();
  await retry.press("Enter");
  await expect(
    campaigns.getByRole("button", {
      name: /Open campaign Last confirmed launch/,
    }),
  ).toBeVisible({ timeout: 15_000 });

  phase = "stale-failure";
  const refresh = page
    .getByRole("group", { name: "Dashboard controls" })
    .getByRole("button", { name: "Refresh", exact: true });
  await refresh.scrollIntoViewIfNeeded();
  await refresh.click();
  await scrollDashboardTarget(
    page,
    page.getByRole("heading", { name: "Recent campaigns", exact: true }),
  );
  await expect(campaigns.getByRole("alert")).toContainText(
    "Showing the last confirmed campaign list.",
    { timeout: 15_000 },
  );
  await expect(campaigns.getByText("Last confirmed launch")).toBeVisible();
  await expect(campaigns.getByText("No campaigns yet")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(campaigns).toHaveScreenshot(
    "dashboard-campaign-retained-stale-dark.png",
  );
});

test("dashboard-clv-empty-and-refresh-error-light", async ({
  page,
  bootApp,
  setTheme,
}) => {
  let phase: "empty" | "error" = "empty";
  allowExpectedResourceLoadFailures(page, "/api/v1/clv-dashboard");
  await openDashboard(page, bootApp, setTheme, "light", async () => {
    await page.route("**/api/v1/clv-dashboard**", async (route) => {
      if (phase === "empty") {
        await fulfillJson(route, null);
        return;
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "private CLV infrastructure detail" },
        }),
      });
    });
  });

  const content = page.locator(".content");
  await content.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const clv = page.locator(".pw-clv-dashboard");
  await expect(clv).toBeVisible({ timeout: 15_000 });
  await expect(
    clv.getByRole("heading", {
      name: "No predicted customer-value snapshot",
      exact: true,
    }),
  ).toBeVisible();
  await expect(clv.locator(".pw-clv-snapshot")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await expect(clv).toHaveScreenshot("dashboard-clv-empty-light.png");

  phase = "error";
  await clv.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(clv.getByRole("alert")).toContainText(
    "CLV projection could not be verified",
    { timeout: 15_000 },
  );
  await expect(clv.getByRole("alert")).toContainText(
    "The last verified response contained no CLV projection",
  );
  await expect(clv.getByRole("alert")).not.toContainText(
    "The last verified projection remains visible below",
  );
  await expect(
    clv.getByRole("button", { name: "Retry CLV dashboard", exact: true }),
  ).toBeVisible();
  await expect(clv.locator(".pw-clv-snapshot")).toHaveCount(0);
  await expect(page.getByText("private CLV infrastructure detail")).toHaveCount(
    0,
  );
  await expectNoHorizontalOverflow(page);
  await expect(clv).toHaveScreenshot(
    "dashboard-clv-empty-refresh-error-light.png",
  );
});

test("dashboard-anomaly-malformed-recovery-dense-and-private-brief-dark", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const privateValues = [
    "PRIVATE-SUBSCRIBER-ID",
    "PRIVATE-TENANT-ID",
    "jane.doe@example.invalid",
    "sk-private-token-123456",
    "2f1c4f42-57d1-4ab3-941f-9b23d9f9b8f1",
    "campaign-private-identifier",
  ];
  let phase: "malformed" | "valid" = "malformed";
  await openDashboard(page, bootApp, setTheme, "dark", async () => {
    await page.route("**/api/v1/dashboard/anomalies**", async (route) => {
      if (phase === "malformed") {
        await fulfillJson(route, {
          items: [
            {
              id: privateValues[0],
              tenantId: privateValues[1],
              metric: "",
              value: "not-a-count",
              mean: "not-a-mean",
              zScore: "not-a-z-score",
              rangeUsed: "90d",
              detectedAt: "2026-07-18T08:00:00.000Z",
            },
          ],
        });
        return;
      }
      await fulfillJson(route, {
        items: Array.from({ length: 8 }, (_, index) => ({
          id: `anomaly-visual-${index + 1}`,
          metric:
            index === 0 ? "bounces" : index % 2 === 0 ? "opens" : "clicks",
          value: 1_250 - index * 37,
          mean: 320 + index * 11.5,
          zScore: 4.8 - index * 0.2,
          rangeUsed: "90d",
          detectedAt: `2026-07-${String(18 - index).padStart(2, "0")}T08:00:00.000Z`,
        })),
      });
    });
    await page.route("**/api/v1/analytics/anomaly-brief**", async (route) => {
      await fulfillJson(route, {
        metric: "bounces",
        window_days: 90,
        summary: `Bounces rose after ${privateValues[2]} used token=${privateValues[3]} for subscriber_id=${privateValues[4]}.`,
        probable_causes: [
          `A list tied to ${privateValues[2]} contributed most of the increase.`,
        ],
        suggested_actions: [
          `Review the affected campaign without exposing subscriber_id=${privateValues[4]}.`,
        ],
        aggregates: {
          metric: "bounces",
          window_days: 90,
          current_total: 1_250,
          previous_total: 320,
          daily: [{ day: "2026-07-17", value: 125 }],
          top_campaigns: [
            {
              campaign_id: privateValues[5],
              campaign_name: `Retention alert for ${privateValues[2]} using api_key=${privateValues[3]}`,
              value: 800,
            },
          ],
        },
        trace: {
          reasoning: `Private trace for ${privateValues[2]}`,
          prompt_tokens: 100,
          response_tokens: 80,
          summary_tokens: 40,
          generated_at: "2026-07-18T08:00:00.000Z",
        },
      });
    });
  });

  const anomalies = page.locator(".pw-dash-secondary-anomalies");
  await scrollDashboardTarget(
    page,
    page.getByRole("heading", { name: "Recent anomalies", exact: true }),
  );
  await expect(anomalies.getByRole("alert")).toContainText(
    "Anomaly history is unavailable",
  );
  await expect(anomalies.locator("li")).toHaveCount(0);
  await expect(page.getByText(privateValues[0])).toHaveCount(0);
  await expect(page.getByText(privateValues[1])).toHaveCount(0);

  phase = "valid";
  const retry = anomalies.getByRole("button", { name: "Try again" });
  await retry.focus();
  await retry.press("Enter");
  await expect(anomalies.getByText("8 detected", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    anomalies.locator(".pw-dash-secondary-anomaly-list > li"),
  ).toHaveCount(8);
  await expect(anomalies).not.toContainText("NaN");
  await expect(anomalies).not.toContainText("Infinity");
  await expectNoHorizontalOverflow(page);
  await expect(anomalies).toHaveScreenshot("dashboard-anomaly-dense-dark.png");

  const explain = anomalies
    .getByRole("button", {
      name: "Ask AI to explain the bounces anomaly",
      exact: true,
    })
    .first();
  await explain.focus();
  await explain.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Explain bounce-event volume",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(/Raw event counts/);
  await expect(
    dialog.locator(".modal-footer").getByRole("button", {
      name: "Close",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("heading", { name: "What the numbers say" }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    dialog.getByRole("region", {
      name: "Campaign evidence for bounce-event volume",
    }),
  ).toBeVisible();
  await expect(dialog.getByText("1,250", { exact: true })).toBeVisible();
  const dialogMarkup = await dialog.evaluate((node) => node.outerHTML);
  for (const privateValue of privateValues) {
    expect(dialogMarkup).not.toContain(privateValue);
  }
  await expect(dialog).toContainText("[email redacted]");
  await expect(dialog).toContainText("[credential redacted]");
  await expect(dialog).toContainText("[identifier redacted]");
  await expectNoHorizontalOverflow(page);
  await expect(page).toHaveScreenshot(
    "dashboard-anomaly-private-brief-dark.png",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(explain).toBeFocused();
});

for (const theme of ["dark", "light"] as const) {
  test(`dashboard-below-fold-integrated-${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDashboard(page, bootApp, setTheme, theme, async () => {
      await installBelowFoldDashboardStubs(page);
    });

    const content = page.locator(".content");
    await expectNoOverlap(page.locator(".tour-launcher"), content);
    const contentDimensions = await content.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(contentDimensions.scrollHeight).toBeGreaterThan(
      contentDimensions.clientHeight,
    );
    const clv = page.locator(".pw-clv-dashboard");
    await expect(clv).toHaveCount(0);

    const scrollPositions: number[] = [];

    const forecast = page.getByRole("note", { name: "Subscriber forecast" });
    scrollPositions.push(await scrollDashboardTarget(page, forecast));
    await expect(forecast).toContainText("At this rate, you'll cross");
    await expect(
      forecast.getByText("Projection", { exact: true }),
    ).toBeVisible();

    const goalsHeading = page.getByRole("heading", {
      name: "Goals & pacing",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, goalsHeading));
    await expect(
      page
        .getByRole("list", { name: "Goal progress", exact: true })
        .getByText("Grow the audience", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Grow the audience progress" }),
    ).toHaveAttribute("aria-valuenow", "83");
    await expect(content).toHaveScreenshot(
      `dashboard-below-fold-goals-${theme}.png`,
    );

    const benchmarksHeading = page.getByRole("heading", {
      name: "How you stack up",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, benchmarksHeading));
    const rateComparisons = page.getByRole("list", {
      name: "Rate comparisons",
    });
    await expect(rateComparisons).toBeVisible();
    await expect(
      rateComparisons.getByText("Open rate", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Moosewave commerce cohort · trailing 30 days").first(),
    ).toBeVisible();

    const campaignsHeading = page.getByRole("heading", {
      name: "Recent campaigns",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, campaignsHeading));
    await expect(
      page.getByText("Summer launch", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Open campaign Summer launch/ }),
    ).toBeVisible();

    const activityHeading = page.getByRole("heading", {
      name: "What's happening",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, activityHeading));
    await expect(
      page.getByText("Summer launch sent", { exact: true }),
    ).toBeVisible();
    await expect(clv).toHaveCount(1, { timeout: 10_000 });
    await expect(content).toHaveScreenshot(
      `dashboard-below-fold-engagement-${theme}.png`,
    );

    const parityHeading = page.getByRole("heading", {
      name: "Mailchimp parity surfaces",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, parityHeading));
    await expect(
      page.getByText("touchpoints/tasks", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("ready to use", { exact: true })).toBeVisible();

    const healthHeading = page.getByRole("heading", {
      name: "Inbox health",
      exact: true,
    });
    scrollPositions.push(await scrollDashboardTarget(page, healthHeading));
    await expect(
      page.getByText(/No recent inbox-health snapshot is available/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review deliverability", exact: true }),
    ).toBeVisible();

    await content.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(clv).toBeVisible({ timeout: 10_000 });
    scrollPositions.push(await scrollDashboardTarget(page, clv));
    await expect(
      page.getByRole("heading", {
        name: /^Predicted customer value/,
      }),
    ).toBeVisible();
    await expect(
      clv.locator('dl[aria-label="Customer value summary"]'),
    ).toBeVisible();
    await expect(clv.getByText("10,936", { exact: true })).toBeVisible();
    await expect(
      clv.getByRole("region", { name: "At-risk high-value profiles" }),
    ).toBeVisible();
    await expect(clv.getByText("Profile A01", { exact: true })).toBeVisible();
    await expect(clv.getByText("At-risk B01", { exact: true })).toBeVisible();

    const dashboardMarkup = await page
      .locator("html")
      .evaluate((node) => node.outerHTML);
    for (const privateIdentity of [
      "champion-01@example.invalid",
      "champion-02@example.invalid",
      "priority-save@example.invalid",
      "visual-clv-1",
      "visual-clv-2",
      "visual-clv-risk-1",
    ]) {
      expect(dashboardMarkup).not.toContain(privateIdentity);
    }

    const clvHelp = clv.getByRole("button", { name: "More information" });
    const clvTooltipId = await clvHelp.getAttribute("aria-describedby");
    expect(clvTooltipId).not.toBeNull();
    const clvTooltip = page.locator(`[id="${clvTooltipId}"]`);
    await clvHelp.focus();
    await expect(clvTooltip).toHaveAttribute("data-open", "true");
    await expect(clvTooltip).toContainText(
      "CLV and churn figures are heuristic projections",
    );
    await clvHelp.press("Escape");
    await expect(clvTooltip).toHaveAttribute("data-open", "false");
    await expect(content).toHaveScreenshot(
      `dashboard-below-fold-clv-${theme}.png`,
    );

    expect(Math.max(...scrollPositions)).toBeGreaterThan(
      Math.min(...scrollPositions),
    );
    await expectNoHorizontalOverflow(page);
  });
}
