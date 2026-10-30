import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const WORKSPACES = [
  {
    label: "Release status",
    heading: "One safe boundary. Six explicit release gates.",
  },
  {
    label: "Attribution",
    heading: "Credit only what can be explained later.",
  },
  {
    label: "Commercial",
    heading: "Make the promise precise before publishing it.",
  },
  {
    label: "Settlement",
    heading: "Preview exactly what will move. Then prove what moved.",
  },
] as const;

interface AffiliateHarness {
  affiliateRequests: string[];
  failedRequests: string[];
  runtimeErrors: string[];
  unexpectedResponses: string[];
}

interface OpenAffiliatesOptions {
  height?: number;
  theme?: "dark" | "light";
  width?: number;
}

function isAffiliateApiPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") &&
    /(?:^|\/)affiliates?(?:\/|$)/u.test(pathname)
  );
}

async function installAffiliateHarness(page: Page): Promise<AffiliateHarness> {
  const affiliateRequests: string[] = [];
  const failedRequests: string[] = [];
  const runtimeErrors: string[] = [];
  const unexpectedResponses: string[] = [];

  // The shell resolves this preference while the route is changing. Keep the
  // unrelated global preference valid so qualification screenshots and focus
  // evidence are not obscured by a harness-only Dashboard fallback toast.
  await page.route("**/api/v1/dashboard/layout", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify({
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
      }),
      contentType: "application/json",
      status: 200,
    });
  });

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (isAffiliateApiPath(url.pathname)) {
      affiliateRequests.push(
        `${request.method()} ${url.pathname}${url.search}`,
      );
    }
  });

  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown failure"}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const request = response.request();
      unexpectedResponses.push(
        `${request.method()} ${response.url()} · ${response.status()}`,
      );
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });

  return {
    affiliateRequests,
    failedRequests,
    runtimeErrors,
    unexpectedResponses,
  };
}

async function openAffiliates(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: OpenAffiliatesOptions = {},
): Promise<AffiliateHarness> {
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await setTheme(page, options.theme ?? "dark");
  await bootApp(page);
  const harness = await installAffiliateHarness(page);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="affiliates"]');
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Qualify the partner engine before money moves.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", {
      name: "Affiliate qualification workspaces",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No enrollment, tracking, commission", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Review setup" })).toHaveCount(
    0,
  );

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
    const result = await axe.run(".aff-page", {
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
    const affiliates = document.querySelector<HTMLElement>(".aff-page");
    const content = document.querySelector<HTMLElement>(".content");
    return {
      affiliates: affiliates
        ? affiliates.scrollWidth - affiliates.clientWidth
        : 999,
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 999,
      document: document.documentElement.scrollWidth - window.innerWidth,
      windowScroll: window.scrollX,
    };
  });

  expect(overflow.affiliates).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

async function expectFocusedAndVisible(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeFocused();
  const evidence = await locator.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      bottom: rectangle.bottom,
      focusVisible: element.matches(":focus-visible"),
      height: rectangle.height,
      left: rectangle.left,
      right: rectangle.right,
      top: rectangle.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rectangle.width,
    };
  });

  expect(evidence.focusVisible).toBe(true);
  expect(evidence.left).toBeGreaterThanOrEqual(-1);
  expect(evidence.right).toBeLessThanOrEqual(evidence.viewportWidth + 1);
  expect(evidence.top).toBeGreaterThanOrEqual(-1);
  expect(evidence.bottom).toBeLessThanOrEqual(evidence.viewportHeight + 1);
  expect(evidence.width).toBeGreaterThanOrEqual(40);
  expect(evidence.height).toBeGreaterThanOrEqual(40);
}

async function expectTabPanelSemantics(
  page: Page,
  selectedTab: Locator,
): Promise<void> {
  const tabs = await page
    .locator('.aff-workspace-tabs [role="tab"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        controls: element.getAttribute("aria-controls"),
        id: element.id,
        selected: element.getAttribute("aria-selected"),
        tabIndex: (element as HTMLElement).tabIndex,
      })),
    );
  const panels = await page
    .locator('.aff-page [role="tabpanel"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        hidden: (element as HTMLElement).hidden,
        id: element.id,
        labelledBy: element.getAttribute("aria-labelledby"),
        tabIndex: (element as HTMLElement).tabIndex,
      })),
    );
  const selectedTabId = await selectedTab.getAttribute("id");
  const selectedPanelId = await selectedTab.getAttribute("aria-controls");
  if (!selectedTabId || !selectedPanelId) {
    throw new Error("Selected affiliate tab is missing its APG relationship.");
  }

  expect(tabs).toHaveLength(WORKSPACES.length);
  expect(panels).toHaveLength(WORKSPACES.length);
  expect(tabs.filter((tab) => tab.selected === "true")).toEqual([
    expect.objectContaining({
      controls: selectedPanelId,
      id: selectedTabId,
      tabIndex: 0,
    }),
  ]);
  expect(new Set(tabs.map((tab) => tab.controls)).size).toBe(WORKSPACES.length);
  expect(tabs.map((tab) => tab.controls).sort()).toEqual(
    panels.map((panel) => panel.id).sort(),
  );

  for (const panel of panels) {
    const controllingTab = tabs.find((tab) => tab.controls === panel.id);
    expect(controllingTab).toBeDefined();
    expect(panel.labelledBy).toBe(controllingTab?.id);
    if (panel.id === selectedPanelId) {
      expect(panel.hidden).toBe(false);
      expect(panel.tabIndex).toBe(0);
    } else {
      expect(panel.hidden).toBe(true);
      expect(panel.tabIndex).toBe(-1);
    }
  }
}

function expectHealthyHarness(harness: AffiliateHarness): void {
  expect(harness.affiliateRequests).toEqual([]);
  expect(harness.failedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(harness.unexpectedResponses).toEqual([]);
}

async function settleReflow(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
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
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

for (const theme of ["dark", "light"] as const) {
  test(`admin qualification route renders every static workspace in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openAffiliates(page, bootApp, setTheme, { theme });
    const tablist = page.getByRole("tablist", {
      name: "Affiliate qualification workspaces",
    });

    for (const workspace of WORKSPACES) {
      const tab = tablist.getByRole("tab", {
        name: new RegExp(workspace.label, "u"),
      });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectTabPanelSemantics(page, tab);
      const panel = page.getByRole("tabpanel");
      const tabId = await tab.getAttribute("id");
      if (!tabId) throw new Error(`${workspace.label} tab has no id.`);
      await expect(panel).toHaveAttribute("aria-labelledby", tabId);
      await expect(
        panel.getByRole("heading", {
          name: workspace.heading,
          exact: true,
        }),
      ).toBeVisible();
    }

    await expectNoRootHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expectHealthyHarness(harness);
    await capture(page, testInfo, `affiliates-settlement-${theme}`);
  });
}

test("workspace tabs use automatic APG keyboard activation with wrap, Home, and End", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openAffiliates(page, bootApp, setTheme);
  const tablist = page.getByRole("tablist", {
    name: "Affiliate qualification workspaces",
  });
  const release = tablist.getByRole("tab", { name: /Release status/u });
  const attribution = tablist.getByRole("tab", { name: /Attribution/u });
  const commercial = tablist.getByRole("tab", { name: /Commercial/u });
  const settlement = tablist.getByRole("tab", { name: /Settlement/u });

  await expect(release).toHaveAttribute("aria-selected", "true");
  await release.click();
  await page.keyboard.press("ArrowRight");
  await expectFocusedAndVisible(attribution);
  await expect(attribution).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, attribution);
  await expect(
    page.getByRole("heading", {
      name: "Credit only what can be explained later.",
      exact: true,
    }),
  ).toBeVisible();

  await attribution.press("ArrowRight");
  await expectFocusedAndVisible(commercial);
  await expect(commercial).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, commercial);

  await commercial.press("End");
  await expectFocusedAndVisible(settlement);
  await expect(settlement).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, settlement);

  await settlement.press("Home");
  await expectFocusedAndVisible(release);
  await expect(release).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, release);

  await release.press("ArrowLeft");
  await expectFocusedAndVisible(settlement);
  await expect(settlement).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, settlement);
  await expect(
    page.getByRole("heading", {
      name: "Preview exactly what will move. Then prove what moved.",
      exact: true,
    }),
  ).toBeVisible();

  await expectNoRootHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHealthyHarness(harness);
});

test("1440, 1280, 1024, 800, and narrow layouts reflow without clipping focus", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAffiliates(page, bootApp, setTheme, {
    height: 1_000,
    width: 1_440,
  });
  const tablist = page.getByRole("tablist", {
    name: "Affiliate qualification workspaces",
  });
  const sizes = [
    { height: 1_000, label: "1440", tab: /Release status/u, width: 1_440 },
    { height: 900, label: "1280", tab: /Attribution/u, width: 1_280 },
    { height: 768, label: "1024", tab: /Commercial/u, width: 1_024 },
    { height: 650, label: "800", tab: /Settlement/u, width: 800 },
    { height: 720, label: "narrow", tab: /Commercial/u, width: 560 },
  ] as const;

  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height });
    await settleReflow(page);
    const tab = tablist.getByRole("tab", { name: size.tab });
    await tab.click();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expectFocusedAndVisible(tab);
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expectTabPanelSemantics(page, tab);
    await expectNoRootHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    if (size.label === "narrow") {
      await capture(page, testInfo, "affiliates-narrow-reflow");
    }
  }

  expectHealthyHarness(harness);
});

test("800px window at a 200-percent proxy remains operable and contained", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAffiliates(page, bootApp, setTheme, {
    height: 600,
    theme: "light",
    width: 800,
  });

  // Chromium does not expose an installed-app zoom control. 400×300 CSS
  // pixels models the layout pressure of an 800×600 window at 200%.
  await page.setViewportSize({ width: 400, height: 300 });
  await settleReflow(page);
  const settlement = page.getByRole("tab", { name: /Settlement/u });
  await settlement.scrollIntoViewIfNeeded();
  await settlement.click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expectFocusedAndVisible(settlement);
  await expect(settlement).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, settlement);
  await expect(
    page.getByRole("heading", {
      name: "Preview exactly what will move. Then prove what moved.",
      exact: true,
    }),
  ).toBeVisible();

  await expectNoRootHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHealthyHarness(harness);
  await capture(page, testInfo, "affiliates-200-percent-proxy");
});

test("reduced motion neutralizes signals and makes tab transitions imperceptible", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openAffiliates(page, bootApp, setTheme, {
    height: 650,
    width: 800,
  });

  const motion = await page.evaluate(() => {
    const signals = Array.from(
      document.querySelectorAll<HTMLElement>(".aff-flow-signal span"),
    ).map((element) => {
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
      };
    });
    const tab = document.querySelector<HTMLElement>(
      '.aff-workspace-tabs [role="tab"]',
    );
    const indicator = tab ? getComputedStyle(tab, "::after") : null;
    const durationToMilliseconds = (duration: string): number =>
      duration.endsWith("ms")
        ? Number.parseFloat(duration)
        : Number.parseFloat(duration) * 1_000;
    return {
      indicatorTransitionDurationMs: indicator
        ? Math.max(
            ...indicator.transitionDuration
              .split(",")
              .map((duration) => durationToMilliseconds(duration.trim())),
          )
        : Number.POSITIVE_INFINITY,
      signals,
    };
  });

  expect(motion.signals).toHaveLength(3);
  expect(
    motion.signals.every((signal) => signal.animationName === "none"),
  ).toBe(true);
  // The shell's global reduced-motion contract keeps a maximum 10ms duration
  // so transition-end listeners still settle. That is below a perceptible
  // frame and the decorative signal itself has no animation name.
  expect(motion.indicatorTransitionDurationMs).toBeLessThanOrEqual(10);
  await expectNoRootHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHealthyHarness(harness);
  await capture(page, testInfo, "affiliates-reduced-motion");
});

test("forced colors preserve selected workspace and keyboard-focus evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  const harness = await openAffiliates(page, bootApp, setTheme, {
    theme: "dark",
  });
  const release = page.getByRole("tab", { name: /Release status/u });
  const attribution = page.getByRole("tab", { name: /Attribution/u });

  await release.focus();
  await release.press("ArrowRight");
  await expectFocusedAndVisible(attribution);
  await expect(attribution).toHaveAttribute("aria-selected", "true");
  await expectTabPanelSemantics(page, attribution);

  const evidence = await attribution.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement("span");
    probe.style.cssText =
      "color: Highlight; background: Canvas; forced-color-adjust: none";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const result = {
      focusVisible: element.matches(":focus-visible"),
      highlight: expected.color,
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
    probe.remove();
    return result;
  });

  expect(evidence.focusVisible).toBe(true);
  expect(evidence.outlineStyle).toBe("solid");
  expect(evidence.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(evidence.outlineColor).toBe(evidence.highlight);
  await expectNoRootHorizontalOverflow(page);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  expectHealthyHarness(harness);
  await capture(page, testInfo, "affiliates-forced-colors");
});
