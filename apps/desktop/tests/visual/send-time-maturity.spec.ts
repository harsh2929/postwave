import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const SEGMENT_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIBER_ID = "22222222-2222-4222-8222-222222222222";
const AS_OF = "2026-07-26T09:45:00.000Z";

type AnalysisMode = "ready" | "insufficient" | "error";

interface SendTimeHarness {
  analysisRequests: string[];
  subscriberRequests: string[];
}

function weeklyGrid(): number[][] {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  grid[1][9] = 1;
  grid[2][14] = 0.82;
  grid[4][18] = 0.64;
  grid[6][10] = 0.46;
  return grid;
}

async function installSendTimeHarness(
  page: Page,
  mode: AnalysisMode = "ready",
): Promise<SendTimeHarness> {
  const harness: SendTimeHarness = {
    analysisRequests: [],
    subscriberRequests: [],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/v1/settings/send-time-optimization") {
      await json(route, { enabled: true });
      return;
    }
    if (path === "/api/v1/segments") {
      await json(route, [
        {
          id: SEGMENT_ID,
          name: "High-intent readers",
          lastCount: 1_248,
        },
      ]);
      return;
    }
    if (
      path === "/api/v1/send-time-opt/heatmap" ||
      path === "/api/v1/send-time-opt"
    ) {
      harness.analysisRequests.push(request.url());
      if (mode !== "ready") {
        await json(
          route,
          {
            error: {
              code:
                mode === "insufficient"
                  ? "insufficient_data"
                  : "temporarily_unavailable",
              message:
                mode === "insufficient"
                  ? "not enough members with signal"
                  : "model worker is unavailable",
            },
          },
          mode === "insufficient" ? 404 : 503,
        );
        return;
      }
      if (path.endsWith("/heatmap")) {
        await json(route, {
          segment_id: SEGMENT_ID,
          subscribers_with_data: 936,
          grid: weeklyGrid(),
          best_dow: 1,
          best_hour: 9,
          secondary_dow: 2,
          secondary_hour: 14,
          has_secondary_window: true,
          computed_at: AS_OF,
        });
        return;
      }
      await json(route, {
        segment_id: SEGMENT_ID,
        best_hour_utc: "09:00",
        confidence: 0.75,
        sample_size: 936,
        computed_at: AS_OF,
      });
      return;
    }
    if (path === `/api/v1/subscribers/${SUBSCRIBER_ID}/best-send-time`) {
      harness.subscriberRequests.push(request.url());
      await json(route, {
        email: "reader@example.com",
        best_hour_utc: 33,
        computed_at: AS_OF,
        sample_size: 18,
      });
      return;
    }
    if (path === `/api/v1/subscribers/${SUBSCRIBER_ID}/open-pattern`) {
      harness.subscriberRequests.push(request.url());
      await json(route, {
        email: "reader@example.com",
        sample_size: 18,
        grid: weeklyGrid(),
        best_dow: 1,
        best_hour: 9,
        secondary_dow: 2,
        secondary_hour: 14,
        bimodal: true,
        computed_at: AS_OF,
      });
      return;
    }
    await route.fallback();
  });

  return harness;
}

async function bootSendTime(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: {
    theme?: "dark" | "light";
    mode?: AnalysisMode;
    width?: number;
    height?: number;
  } = {},
): Promise<SendTimeHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  const harness = await installSendTimeHarness(page, options.mode ?? "ready");
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="sendtime"]');
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Send-time intelligence",
      exact: true,
    }),
  ).toBeVisible();
  return harness;
}

async function chooseAudience(page: Page): Promise<void> {
  await page
    .getByRole("combobox", { name: "Audience scope" })
    .selectOption(SEGMENT_ID);
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
    const result = await axe.run(".stx-page", {
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    page:
      (document.querySelector<HTMLElement>(".stx-page")?.scrollWidth ?? 0) -
      (document.querySelector<HTMLElement>(".stx-page")?.clientWidth ?? 0),
  }));
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.page).toBeLessThanOrEqual(1);
}

async function attachPage(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main");
    if (main) main.scrollTop = 0;
  });
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

for (const theme of ["dark", "light"] as const) {
  test(`ready audience is truthful, accessible, and polished in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await bootSendTime(page, bootApp, setTheme, { theme });

    await expect(
      page.getByText("Analysis · Scope required", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".stx-heatmap-shell")).toHaveCount(0);
    await expect(
      page.getByText("Delivery changes stay locked", { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator(
        "select#send-time-campaign, input[name='send_time_strategy'], input#send-time-reference",
      ),
    ).toHaveCount(0);
    expect(harness.analysisRequests).toEqual([]);

    await chooseAudience(page);
    await expect(
      page.getByText("Measured recommendation", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Analysis · Measured", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Weekly engagement density", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("75%", { exact: true })).toBeVisible();
    await expect(
      page.locator(".stx-heatmap-shell [title*=' UTC · ']"),
    ).toHaveCount(168);
    expect(harness.analysisRequests).toHaveLength(2);
    expect(
      harness.analysisRequests.every(
        (url) => new URL(url).searchParams.get("segment_id") === SEGMENT_ID,
      ),
    ).toBe(true);

    await page
      .getByRole("button", { name: "Show hours in this device's timezone" })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Show hours in this device's timezone",
      }),
    ).toHaveAttribute("aria-pressed", "true");

    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await attachPage(page, testInfo, `send-time-ready-${theme}`);
  });
}

for (const state of ["insufficient", "error"] as const) {
  test(`audience ${state} remains distinct and terminal`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await bootSendTime(page, bootApp, setTheme, { mode: state });
    await chooseAudience(page);

    if (state === "insufficient") {
      await expect(
        page.getByText("The pattern is still taking shape.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Analysis · Learning", { exact: true }),
      ).toBeVisible();
    } else {
      await expect(
        page.getByText("The audience analysis could not be loaded.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Analysis · Unavailable", { exact: true }),
      ).toBeVisible();
    }
    await expect(page.locator(".stx-heatmap-shell")).toHaveCount(0);
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("subscriber inspection validates locally and reveals only masked identity", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await bootSendTime(page, bootApp, setTheme);
  const input = page.getByRole("textbox", { name: "Subscriber UUID" });

  await input.fill("reader@example.com");
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.locator("#send-time-subscriber-error")).toContainText(
    "Enter a full subscriber UUID",
  );
  expect(harness.subscriberRequests).toEqual([]);

  await input.fill(SUBSCRIBER_ID);
  await input.press("Enter");
  await expect(
    page.getByText("Recommended UTC window", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".stx-window-primary").getByText("Monday", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("re…@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Weekly engagement pattern", { exact: true }),
  ).toBeVisible();
  expect(harness.subscriberRequests).toHaveLength(2);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("narrow reduced-motion layout replaces the dense heatmap with ranked times", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await bootSendTime(page, bootApp, setTheme, {
    width: 700,
    height: 960,
  });
  await chooseAudience(page);

  await expect(page.getByText("Top send times", { exact: true })).toBeVisible();
  await expect(
    page.locator(".stx-heatmap-shell [title*=' UTC · ']"),
  ).toHaveCount(0);
  const animationNames = await page
    .locator(".stx-orbit-ring, .stx-orbit-point")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).animationName),
    );
  expect(animationNames.every((name) => name === "none")).toBe(true);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await attachPage(page, testInfo, "send-time-narrow-reduced-motion");
});

test("forced colors keeps route controls and locked status distinguishable", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ forcedColors: "active" });
  await bootSendTime(page, bootApp, setTheme);
  await chooseAudience(page);

  await expect(
    page.getByRole("combobox", { name: "Audience scope" }),
  ).toBeVisible();
  await expect(
    page.getByText("Delivery changes stay locked", { exact: true }),
  ).toBeVisible();
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);

  const colors = await page.evaluate(() => {
    const select = document.querySelector<HTMLElement>("#send-time-segment");
    const primary = document.querySelector<HTMLElement>(
      ".stx-heatmap-cell.is-primary",
    );
    if (!select || !primary) throw new Error("Missing forced-color controls");
    const probe = document.createElement("span");
    probe.style.cssText =
      "color: CanvasText; background: Highlight; border: 1px solid CanvasText; forced-color-adjust: none";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const actualSelect = getComputedStyle(select);
    const actualPrimary = getComputedStyle(primary);
    const result = {
      selectColor: actualSelect.color,
      canvasText: expected.color,
      primaryBackground: actualPrimary.backgroundColor,
      highlight: expected.backgroundColor,
      primaryBorder: actualPrimary.borderTopColor,
    };
    probe.remove();
    return result;
  });
  expect(colors.selectColor).toBe(colors.canvasText);
  expect(colors.primaryBackground).toBe(colors.highlight);
  expect(colors.primaryBorder).toBe(colors.highlight);
});

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
