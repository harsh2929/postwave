import type { Page } from "@playwright/test";

import { expect, test } from "./fixture";
import {
  expectHorizontallyContained,
  expectNoProductEventsPageOverflow,
  expectViewportContained,
  openProductEvents,
  saveProductEventsEvidence,
  seriousProductEventsAxeViolations,
  settleProductEvents,
} from "./product-events-evidence-harness";

test.describe.configure({ timeout: 120_000 });

interface EvidenceViewport {
  height: number;
  name: string;
  width: number;
}

const ROUTE_VIEWPORTS: EvidenceViewport[] = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "compact-720", width: 720, height: 900 },
  { name: "narrow-400", width: 400, height: 800 },
  { name: "minimum-360", width: 360, height: 800 },
];

const ZOOM_PROXIES: Array<EvidenceViewport & { zoom: string }> = [
  {
    name: "zoom-200-proxy",
    width: 440,
    height: 280,
    zoom: "200%",
  },
  {
    name: "zoom-400-proxy",
    width: 320,
    height: 200,
    zoom: "400%",
  },
];

function composerTrigger(page: Page) {
  return page.locator(".track-composer > button[aria-controls]");
}

async function openComposer(page: Page) {
  const trigger = composerTrigger(page);
  await expect(trigger).toHaveAccessibleName("Send live event");
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const panel = page.locator(".track-composer-body");
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("textbox", { name: "Subscriber (id or email)" }),
  ).toBeFocused();
  return panel;
}

async function expectScopeSurfaces(page: Page): Promise<void> {
  const toolbar = page.locator(".track-scope-toolbar");
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toContainText("Focus the signal before you inspect it");

  const activeScope = page.getByLabel(
    "Active product event investigation scope",
  );
  await expect(activeScope).toContainText("Workspace");
  await expect(activeScope).toContainText("Last 7 UTC days");
  await expect(activeScope).toContainText("All event names");
  await expect(activeScope).toContainText("All subscribers");
  await expect(activeScope.locator(".track-scope-token")).toHaveCount(4);

  await expect(page.getByLabel("Analytics scope")).toContainText("Workspace");
  await expect(page.getByLabel("Analytics scope")).toContainText(
    "Last 7 UTC days",
  );
  await expect(page.getByLabel("Event feed scope")).toContainText("Workspace");
  await expect(page.getByLabel("Event feed scope")).toContainText(
    "Last 7 UTC days",
  );

  const subscriberInputHeight = await page
    .locator(".track-scope-subscriber-input .input")
    .evaluate((element) => element.getBoundingClientRect().height);
  expect(
    subscriberInputHeight,
    "The single-line subscriber scope input must not absorb a column flex basis",
  ).toBeLessThanOrEqual(56);

  await expectHorizontallyContained(toolbar, page);
  await expectHorizontallyContained(
    page
      .getByRole("region", { name: "Signal overview" })
      .or(page.locator('[aria-labelledby="track-signal-heading"]')),
    page,
  );
  await expectHorizontallyContained(
    page
      .getByRole("region", { name: "Activity stream" })
      .or(page.locator('[aria-labelledby="track-feed-heading"]')),
    page,
  );
}

for (const viewport of ROUTE_VIEWPORTS) {
  test(`Product Events scope and live composer remain contained at ${viewport.name}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const control = await openProductEvents({
      page,
      bootApp,
      setTheme,
      theme: viewport.width <= 400 ? "light" : "dark",
    });
    await expect(
      page.getByRole("table", { name: "Event catalog" }),
    ).toContainText("checkout.completed");
    await expect(
      page.getByRole("table", { name: "Product event feed" }),
    ).toContainText("ada@example.invalid");
    await expectScopeSurfaces(page);
    await expectNoProductEventsPageOverflow(page);

    const panel = await openComposer(page);
    await expectViewportContained(panel, page);
    await expectNoProductEventsPageOverflow(page);
    expect(control.unexpectedTrackRequests).toEqual([]);
    if (viewport.width === 1440) {
      expect(await seriousProductEventsAxeViolations(page)).toEqual([]);
    }
    await settleProductEvents(page);
    await saveProductEventsEvidence(
      page,
      testInfo,
      `product-events-${viewport.name}-composer`,
    );
  });
}

for (const viewport of ZOOM_PROXIES) {
  test(`Product Events composer stays operable in the ${viewport.zoom} reflow proxy`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    // Chromium does not expose a stable cross-platform browser-zoom API.
    // These CSS-pixel viewports model 880×560 at 200% and 1280×800 at
    // 400%. The installed Tauri package still owns the native scaling gate.
    await page.setViewportSize(viewport);
    await openProductEvents({
      page,
      bootApp,
      setTheme,
      theme: "light",
    });
    await expectScopeSurfaces(page);
    await expectNoProductEventsPageOverflow(page);

    const panel = await openComposer(page);
    await expectViewportContained(panel, page);
    const scrollEvidence = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clientHeight: element.clientHeight,
        overflowY: style.overflowY,
        scrollHeight: element.scrollHeight,
      };
    });
    expect(scrollEvidence.overflowY).toMatch(/auto|scroll/u);
    expect(scrollEvidence.scrollHeight).toBeGreaterThan(
      scrollEvidence.clientHeight,
    );

    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("textbox", { name: "Event name" }),
    ).toBeFocused();
    await saveProductEventsEvidence(
      page,
      testInfo,
      `product-events-${viewport.name}-composer`,
    );
  });
}

test("Product Events distinguishes a true workspace empty state", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProductEvents({
    page,
    bootApp,
    setTheme,
    state: "true-empty",
    theme: "light",
  });

  await expect(
    page.getByText("Watch your product breathe in real time.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No events were found for this investigation scope.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText("No loaded events occurred during Last 7 UTC days.", {
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("table", { name: "Event catalog" }),
  ).toContainText("No product events yet");
  await saveProductEventsEvidence(
    page,
    testInfo,
    "product-events-true-workspace-empty",
  );
});

test("Product Events exposes a scoped empty state without relabeling it as a new workspace", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 900 });
  const control = await openProductEvents({
    page,
    bootApp,
    setTheme,
    state: "scoped-empty",
  });
  const catalog = page.getByRole("table", { name: "Event catalog" });
  await catalog
    .getByRole("button", {
      name: "Filter events to checkout.completed",
      exact: true,
    })
    .click();

  await expect(
    page.getByText("No events were found for this investigation scope.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Active product event investigation scope"),
  ).toContainText("Event: checkout.completed");
  await expect
    .poll(() =>
      control.eventQueries.some((query) =>
        query.includes("event_name=checkout.completed"),
      ),
    )
    .toBe(true);
  await expectNoProductEventsPageOverflow(page);
  await saveProductEventsEvidence(
    page,
    testInfo,
    "product-events-scoped-empty-720",
  );
});

test("Product Events explains a range empty state and widens the period in place", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await openProductEvents({
    page,
    bootApp,
    setTheme,
    state: "range-empty",
    theme: "light",
  });

  await expect(
    page.getByText("No loaded events occurred during Last 7 UTC days.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Subscriber ID or email", exact: true })
    .fill("sub-archive");
  await page.getByRole("button", { name: "Load events", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Remove the sub-archive subscriber scope",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show the widest period", exact: true })
    .click();
  await expect(
    page
      .getByRole("group", { name: "Product event reporting period" })
      .getByRole("button", { name: "Last 90 UTC days", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("table", { name: "Product event feed" }),
  ).toContainText("archive@example.invalid");
  await expect(
    page.getByRole("button", {
      name: "Remove the sub-archive subscriber scope",
      exact: true,
    }),
  ).toBeVisible();
  await expectNoProductEventsPageOverflow(page);
  await saveProductEventsEvidence(
    page,
    testInfo,
    "product-events-range-empty-and-widened-400",
  );
});

test("a 200-row event catalog has one keyboard stop per row, not one per chart", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProductEvents({
    page,
    bootApp,
    setTheme,
    catalogSize: 200,
  });

  const catalog = page.getByRole("table", { name: "Event catalog" });
  await expect(catalog.locator("tbody tr")).toHaveCount(200);
  const filterButtons = catalog.getByRole("button", {
    name: /^Filter events to /u,
  });
  await expect(filterButtons).toHaveCount(200);
  await expect(
    catalog.locator(
      '.track-sparkline[tabindex="0"], svg[tabindex="0"], [role="img"][tabindex="0"]',
    ),
  ).toHaveCount(0);

  const focusableCount = await catalog
    .locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    .count();
  expect(focusableCount).toBe(200);
  await filterButtons.first().focus();
  await page.keyboard.press("Tab");
  await expect(filterButtons.nth(1)).toBeFocused();

  await catalog.scrollIntoViewIfNeeded();
  await saveProductEventsEvidence(
    page,
    testInfo,
    "product-events-200-row-catalog-keyboard-budget",
  );
});

test("forced colours and reduced motion preserve Product Events scope and composer semantics", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  await openProductEvents({
    page,
    bootApp,
    setTheme,
    theme: "dark",
  });
  await expectScopeSurfaces(page);
  const panel = await openComposer(page);
  await expectViewportContained(panel, page);

  const mediaEvidence = await page
    .locator(".track-scope-toolbar")
    .evaluate((element) => {
      const scopeStyle = getComputedStyle(element);
      const composer = document.querySelector<HTMLElement>(
        ".track-composer-body",
      );
      const composerStyle = composer ? getComputedStyle(composer) : null;
      return {
        composerBorderStyle: composerStyle?.borderStyle,
        forced: matchMedia("(forced-colors: active)").matches,
        reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
        scopeBorderStyle: scopeStyle.borderStyle,
        scopeTransition: scopeStyle.transitionDuration,
      };
    });
  expect(mediaEvidence.forced).toBe(true);
  expect(mediaEvidence.reduced).toBe(true);
  expect(mediaEvidence.scopeBorderStyle).toBe("solid");
  expect(mediaEvidence.composerBorderStyle).toBe("solid");
  expect(mediaEvidence.scopeTransition).toMatch(/^0(?:s|ms)(?:, 0(?:s|ms))*$/u);
  expect(
    await seriousProductEventsAxeViolations(page, { forcedColors: true }),
  ).toEqual([]);
  await saveProductEventsEvidence(
    page,
    testInfo,
    "product-events-forced-colors-reduced-motion",
  );
});
