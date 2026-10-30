import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page } from "@playwright/test";

import { expect, test } from "./fixture";

const AUTH_SHOWCASE_SLIDE_COUNT = 5;
const AUTH_SHOWCASE_INTERVAL_MS = 10_000;
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
const AUTH_KEYS = [
  "postwave_api_key",
  "postwave_session",
  "postwave_session_user",
] as const;

type Theme = "dark" | "light";

interface RuntimeFailures {
  consoleErrors: string[];
  pageErrors: string[];
}

function observeRuntimeFailures(page: Page): RuntimeFailures {
  const failures: RuntimeFailures = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error: Error) => {
    failures.pageErrors.push(error.message);
  });
  return failures;
}

function expectCleanRuntime(failures: RuntimeFailures): void {
  expect(failures.consoleErrors, "renderer console errors").toEqual([]);
  expect(failures.pageErrors, "uncaught renderer errors").toEqual([]);
}

async function pauseInstalledClock(page: Page): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  // `pauseAt` advances before pausing. Give the browser a small amount of
  // headroom so the installed clock cannot tick past the sampled timestamp
  // between the evaluate and protocol calls on a busy CI worker.
  await page.clock.pauseAt(now + 1_000);
}

async function bootSignedOut(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | Theme) => Promise<void>,
  theme: Theme,
): Promise<{ authChecks: () => Promise<number> }> {
  await setTheme(page, theme);
  await bootApp(page);

  // The shared visual fixture normally supplies an authenticated workspace.
  // Block every legacy identity hint regardless of init-script ordering so
  // this spec exercises the real signed-out boot decision instead.
  await page.addInitScript((blockedKeys: readonly string[]) => {
    const blocked = new Set(blockedKeys);
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setSignedOutStorageItem(
      key: string,
      value: string,
    ): void {
      if (blocked.has(key)) return;
      originalSetItem.call(this, key, value);
    };
    for (const key of blocked) {
      window.localStorage.removeItem(key);
      window.sessionStorage.removeItem(key);
    }

    // Ask the shared Tauri harness to return the same authoritative native
    // session-broker response as the signed-out API. This preserves the
    // installed app's fail-closed transport boundary and avoids Chromium
    // reporting an intentionally fulfilled network 401 as a resource error.
    const authProbe = window as typeof window & {
      __authShowcaseAuthChecks?: number;
      __authShowcaseNativeSignedOut?: boolean;
    };
    authProbe.__authShowcaseAuthChecks = 0;
    authProbe.__authShowcaseNativeSignedOut = true;
  }, AUTH_KEYS);

  // Remove the authenticated fixture responses. Non-auth background probes
  // get a quiet empty response; /auth/me is handled by the native broker stub.
  await page.unroute("**/api/**");
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    },
  );

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Sign in to Moosewave", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".auth-showcase")).toBeVisible();
  const authChecks = async (): Promise<number> =>
    page.evaluate(
      () =>
        (window as typeof window & { __authShowcaseAuthChecks?: number })
          .__authShowcaseAuthChecks ?? 0,
    );
  await expect.poll(authChecks).toBeGreaterThan(0);
  await page.evaluate(async () => document.fonts.ready);
  await page.waitForLoadState("networkidle");

  return { authChecks };
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".auth-shell-v2");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      shell: shell ? shell.scrollWidth - shell.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.shell).toBeLessThanOrEqual(1);
}

async function expectDotOnlyNavigation(page: Page): Promise<void> {
  const showcase = page.locator(".auth-showcase");
  const pagination = showcase.locator(".auth-showcase-pagination");
  const dots = pagination.locator("button.auth-showcase-dot");
  const current = pagination.locator(
    'button.auth-showcase-dot[aria-current="true"]',
  );

  await expect(pagination).toHaveCount(1);
  await expect(dots).toHaveCount(AUTH_SHOWCASE_SLIDE_COUNT);
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("tabindex", "0");
  await expect(current).toHaveAttribute(
    "aria-label",
    "Pause automatic rotation. Campaigns, slide 1 of 5.",
  );
  await expect(
    pagination.locator(":scope > :not(.sr-only):not(.auth-showcase-dots)"),
  ).toHaveCount(0);
  await expect(
    pagination.locator(
      ".auth-showcase-actions, .auth-showcase-dock-count, .auth-showcase-control, .auth-showcase-progress, progress, [role='progressbar']",
    ),
  ).toHaveCount(0);
  await expect(pagination.locator("svg, img, [data-action-label]")).toHaveCount(
    0,
  );

  const semantics = await dots.evaluateAll((buttons) =>
    buttons.map((button) => ({
      current: button.getAttribute("aria-current"),
      tabIndex: (button as HTMLButtonElement).tabIndex,
      childClasses: Array.from(button.children).map(
        (child) => (child as HTMLElement).className,
      ),
    })),
  );
  expect(semantics.filter((dot) => dot.current === "true")).toHaveLength(1);
  expect(semantics.filter((dot) => dot.tabIndex === 0)).toHaveLength(1);
  expect(semantics.every((dot) => dot.childClasses.length === 1)).toBe(true);
  expect(
    semantics.every((dot) => dot.childClasses[0] === "auth-showcase-dot-track"),
  ).toBe(true);

  const visualDots = await dots.evaluateAll((buttons) =>
    buttons.map((button) => {
      const track = button.firstElementChild as HTMLElement;
      const style = getComputedStyle(track);
      return {
        width: Number.parseFloat(style.width),
        height: Number.parseFloat(style.height),
        borderRadius: style.borderRadius,
        trackAnimationName: style.animationName,
        progressAnimationName: getComputedStyle(track, "::after").animationName,
        progressAnimationDuration: getComputedStyle(track, "::after")
          .animationDuration,
        current: button.getAttribute("aria-current") === "true",
      };
    }),
  );
  expect(
    visualDots.every(
      (dot) =>
        dot.width >= 7 &&
        dot.width <= 9 &&
        dot.height >= 7 &&
        dot.height <= 9 &&
        (dot.borderRadius === "50%" ||
          Number.parseFloat(dot.borderRadius) >= 7),
    ),
  ).toBe(true);
  expect(visualDots.every((dot) => dot.trackAnimationName === "none")).toBe(
    true,
  );
  const currentVisualDot = visualDots.find((dot) => dot.current);
  expect(currentVisualDot?.progressAnimationName).toContain(
    "auth-showcase-dot-progress",
  );
  expect(currentVisualDot?.progressAnimationDuration).toBe("10s");
  expect(
    visualDots
      .filter((dot) => !dot.current)
      .every((dot) => dot.progressAnimationName === "none"),
  ).toBe(true);
}

for (const theme of ["dark", "light"] as const) {
  test(`signed-out showcase is dot-only and overflow-free in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
    const failures = observeRuntimeFailures(page);
    const boot = await bootSignedOut(page, bootApp, setTheme, theme);
    await pauseInstalledClock(page);

    await expectDotOnlyNavigation(page);
    await expectNoHorizontalOverflow(page);
    expect(await boot.authChecks()).toBeGreaterThan(0);

    await expect(page.locator(".auth-shell-v2")).toHaveScreenshot(
      `auth-showcase-${theme}.png`,
    );
    expectCleanRuntime(failures);
  });
}

test("dot-only navigation reflows cleanly and yields to the compact sign-in shell", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");
  await pauseInstalledClock(page);

  const aside = page.locator(".auth-aside-showcase");
  const pagination = page.locator(".auth-showcase-pagination");
  for (const viewport of [
    { width: 1100, height: 900 },
    { width: 960, height: 700 },
    { width: 881, height: 620 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(aside).toBeVisible();
    await expect(pagination).toBeVisible();
    await expectDotOnlyNavigation(page);
    await expectNoHorizontalOverflow(page);
  }

  for (const viewport of [
    { width: 880, height: 900 },
    { width: 1200, height: 519 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(aside).toBeHidden();
    await expect(pagination).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Sign in to Moosewave", exact: true }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }

  expectCleanRuntime(failures);
});

test("showcase advances at exactly ten seconds and wraps with one current dot", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");
  await pauseInstalledClock(page);

  const activeStory = page.locator(".auth-showcase-copy.is-active");
  await expect(activeStory).toHaveAttribute("aria-label", "Campaigns, 1 of 5");

  // Entering and leaving the story is a transient pause. Resuming starts a
  // fresh interval, giving this renderer test an exact ten-second boundary.
  await page.locator(".auth-aside-showcase").dispatchEvent("mouseover");
  await expect(page.locator(".auth-showcase")).toHaveClass(/is-paused/);
  await page.locator(".auth-aside-showcase").dispatchEvent("mouseout");
  await expect(page.locator(".auth-showcase")).toHaveClass(/is-rotating/);

  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS - 1);
  await expect(activeStory).toHaveAttribute("aria-label", "Campaigns, 1 of 5");
  await page.clock.fastForward(1);
  await expect(activeStory).toHaveAttribute("aria-label", "Audience, 2 of 5");

  for (const label of [
    "Sequences, 3 of 5",
    "Deliverability, 4 of 5",
    "Analytics, 5 of 5",
    "Campaigns, 1 of 5",
  ]) {
    await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS);
    await expect(activeStory).toHaveAttribute("aria-label", label);
  }
  await expect(
    page.locator('.auth-showcase-dot[aria-current="true"]'),
  ).toHaveCount(1);
  expectCleanRuntime(failures);
});

test("hover, visibility, window, and focus pauses never spend a hidden partial interval", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");
  await pauseInstalledClock(page);

  const aside = page.locator(".auth-aside-showcase");
  const showcase = page.locator(".auth-showcase");
  const activeStory = page.locator(".auth-showcase-copy.is-active");

  await page.clock.fastForward(4_000);
  await aside.dispatchEvent("mouseover");
  await expect(showcase).toHaveClass(/is-paused/);
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 2);
  await expect(activeStory).toHaveAttribute("aria-label", "Campaigns, 1 of 5");
  await aside.dispatchEvent("mouseout");
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS - 1);
  await expect(activeStory).toHaveAttribute("aria-label", "Campaigns, 1 of 5");
  await page.clock.fastForward(1);
  await expect(activeStory).toHaveAttribute("aria-label", "Audience, 2 of 5");

  await page.clock.fastForward(4_000);
  await page.evaluate(() => {
    const controlledWindow = window as typeof window & {
      __authShowcaseVisibility?: DocumentVisibilityState;
    };
    controlledWindow.__authShowcaseVisibility = "hidden";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => controlledWindow.__authShowcaseVisibility,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(showcase).toHaveClass(/is-paused/);
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 2);
  await expect(activeStory).toHaveAttribute("aria-label", "Audience, 2 of 5");
  await page.evaluate(() => {
    const controlledWindow = window as typeof window & {
      __authShowcaseVisibility?: DocumentVisibilityState;
    };
    controlledWindow.__authShowcaseVisibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS - 1);
  await expect(activeStory).toHaveAttribute("aria-label", "Audience, 2 of 5");
  await page.clock.fastForward(1);
  await expect(activeStory).toHaveAttribute("aria-label", "Sequences, 3 of 5");

  await page.clock.fastForward(4_000);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(showcase).toHaveClass(/is-paused/);
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 2);
  await expect(activeStory).toHaveAttribute("aria-label", "Sequences, 3 of 5");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS - 1);
  await expect(activeStory).toHaveAttribute("aria-label", "Sequences, 3 of 5");
  await page.clock.fastForward(1);
  await expect(activeStory).toHaveAttribute(
    "aria-label",
    "Deliverability, 4 of 5",
  );

  const activeDot = showcase.locator(
    'button.auth-showcase-dot[aria-current="true"]',
  );
  await activeDot.focus();
  await expect(showcase).toHaveAttribute("data-autoplay", "off");
  await expect(showcase).toHaveClass(/is-paused/);
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 2);
  await expect(activeStory).toHaveAttribute(
    "aria-label",
    "Deliverability, 4 of 5",
  );
  expectCleanRuntime(failures);
});

test("manual dot selection pauses rotation without exposing a play bar", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");
  await pauseInstalledClock(page);

  const showcase = page.locator(".auth-showcase");
  const dots = showcase.locator("button.auth-showcase-dot");
  await dots.nth(4).evaluate((dot: HTMLButtonElement) => dot.click());
  await expect(showcase).toHaveAttribute("data-autoplay", "off");
  await expect(showcase).toHaveClass(/is-paused/);
  await expect(page.locator(".auth-showcase-copy.is-active")).toHaveAttribute(
    "aria-label",
    "Analytics, 5 of 5",
  );
  await expect(dots.nth(4)).toHaveAttribute("aria-current", "true");
  await expect(dots.nth(4)).toHaveAttribute(
    "aria-label",
    "Resume automatic rotation. Analytics, slide 5 of 5.",
  );

  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 3);
  await expect(page.locator(".auth-showcase-copy.is-active")).toHaveAttribute(
    "aria-label",
    "Analytics, 5 of 5",
  );
  await expectDotOnlyNavigationAfterManualSelection(page);
  expectCleanRuntime(failures);
});

test("reduced motion disables autoplay while preserving manual dot navigation", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install({ time: new Date("2026-07-18T08:00:00.000Z") });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");
  await pauseInstalledClock(page);

  const showcase = page.locator(".auth-showcase");
  const dots = showcase.locator("button.auth-showcase-dot");
  expect(
    await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await expect(showcase).toHaveAttribute("data-autoplay", "off");
  await expect(showcase).toHaveClass(/is-paused/);
  await expect(dots.nth(0)).toHaveAttribute(
    "aria-label",
    "Campaigns, current slide 1 of 5. Automatic rotation is disabled by reduced motion.",
  );
  await expect(dots.nth(0)).not.toHaveAttribute("data-action-label");
  await dots.nth(0).evaluate((dot: HTMLButtonElement) => dot.click());
  await expect(showcase).toHaveAttribute("data-autoplay", "off");
  await page.clock.fastForward(AUTH_SHOWCASE_INTERVAL_MS * 3);
  await expect(page.locator(".auth-showcase-copy.is-active")).toHaveAttribute(
    "aria-label",
    "Campaigns, 1 of 5",
  );

  await dots.nth(1).evaluate((dot: HTMLButtonElement) => dot.click());
  await expect(page.locator(".auth-showcase-copy.is-active")).toHaveAttribute(
    "aria-label",
    "Audience, 2 of 5",
  );
  expectCleanRuntime(failures);
});

test("forced colors keeps the signed-out shell WCAG-clean and system-colored", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const failures = observeRuntimeFailures(page);
  await bootSignedOut(page, bootApp, setTheme, "dark");

  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (tags) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options: {
              runOnly: { type: "tag" | "rule"; values: string[] };
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
    const submit = document.querySelector(".auth-submit-v2");
    if (!submit) throw new Error("Missing sign-in submit button");

    // In forced-colors emulation Axe compares unforced author text colors
    // against the forced Canvas background. Cover every non-contrast WCAG
    // rule globally, then run contrast on the system-color-owned control that
    // regressed. Computed-color assertions below verify the actual UA palette.
    const structural = await axe.run(document, {
      runOnly: { type: "tag", values: tags },
      rules: { "color-contrast": { enabled: false } },
    });
    const submitContrast = await axe.run(submit, {
      runOnly: { type: "rule", values: ["color-contrast"] },
    });
    return [
      ...structural.violations.map((violation) => ({
        scan: "signed-out shell",
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      })),
      ...submitContrast.violations.map((violation) => ({
        scan: "sign-in submit contrast",
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      })),
    ];
  }, WCAG_TAGS);
  expect(violations).toEqual([]);

  const colors = await page.evaluate(() => {
    const submit = document.querySelector<HTMLElement>(".auth-submit-v2");
    if (!submit) throw new Error("Missing sign-in submit button");
    const probe = document.createElement("span");
    probe.style.cssText =
      "color: HighlightText; background: Highlight; border: 1px solid Highlight; forced-color-adjust: none";
    document.body.appendChild(probe);
    const actual = getComputedStyle(submit);
    const expected = getComputedStyle(probe);
    const result = {
      actual: {
        color: actual.color,
        background: actual.backgroundColor,
        border: actual.borderColor,
        forcedColorAdjust: actual.forcedColorAdjust,
        boxShadow: actual.boxShadow,
      },
      expected: {
        color: expected.color,
        background: expected.backgroundColor,
        border: expected.borderColor,
      },
    };
    probe.remove();
    return result;
  });
  expect(colors.actual).toMatchObject({
    color: colors.expected.color,
    background: colors.expected.background,
    border: colors.expected.border,
    forcedColorAdjust: "none",
    boxShadow: "none",
  });

  const showcase = page.locator(".auth-showcase");
  await expect(showcase).toHaveAttribute("data-autoplay", "off");
  await expect(showcase).toHaveClass(/is-paused/);
  const activeDot = showcase.locator(
    'button.auth-showcase-dot[aria-current="true"]',
  );
  await activeDot.focus();
  await expect(activeDot).toHaveAttribute(
    "aria-label",
    "Campaigns, current slide 1 of 5. Automatic rotation is disabled by reduced motion.",
  );
  await expect(activeDot).not.toHaveAttribute("data-action-label");
  const motionAndFocus = await activeDot.evaluate((dot) => {
    const track = dot.querySelector<HTMLElement>(".auth-showcase-dot-track");
    if (!track) throw new Error("Missing active dot track");
    const dotStyle = getComputedStyle(dot);
    return {
      animationName: getComputedStyle(track).animationName,
      progressAnimationName: getComputedStyle(track, "::after").animationName,
      outlineStyle: dotStyle.outlineStyle,
      outlineWidth: dotStyle.outlineWidth,
    };
  });
  expect(motionAndFocus).toEqual({
    animationName: "none",
    progressAnimationName: "none",
    outlineStyle: "solid",
    outlineWidth: "2px",
  });
  expectCleanRuntime(failures);
});

async function expectDotOnlyNavigationAfterManualSelection(
  page: Page,
): Promise<void> {
  const pagination = page.locator(".auth-showcase-pagination");
  await expect(pagination.locator("button.auth-showcase-dot")).toHaveCount(
    AUTH_SHOWCASE_SLIDE_COUNT,
  );
  await expect(pagination.locator("button")).toHaveCount(
    AUTH_SHOWCASE_SLIDE_COUNT,
  );
  await expect(
    pagination.locator(
      ".auth-showcase-actions, .auth-showcase-dock-count, .auth-showcase-control, .auth-showcase-progress, progress, [role='progressbar']",
    ),
  ).toHaveCount(0);
}
