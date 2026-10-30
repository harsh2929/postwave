/**
 * Visual regression tests for theme correctness.
 *
 * Each test boots the desktop app with one theme active and screenshots
 * a specific view at the viewport size. Playwright diffs against a
 * committed baseline in __screenshots__/. A pixel diff above the
 * threshold (configured in playwright.config.ts) fails the test.
 *
 * Why viewport (not fullPage):
 *   fullPage screenshots temporarily expand the viewport to capture
 *   beyond-the-fold content. For an app whose modal-backdrop uses
 *   `position: fixed; inset: 0` the backdrop only covers the original
 *   viewport — Playwright then captures the "extra" page region without
 *   the scrim, which reads as a layout bug. Capturing the viewport
 *   matches what the user actually sees.
 *
 * Adding a new view: copy a `test()` block. Use a distinctive selector
 * for the readiness wait rather than `waitForTimeout`. If the view
 * needs specific API data, extend `apiRouteStubs` in fixture.ts.
 */
import { test, expect, waitForPrimaryNavigation } from "./fixture";

const META_KEY = process.platform === "darwin" ? "Meta" : "Control";

for (const theme of ["dark", "light"] as const) {
  test(`landing-${theme}`, async ({ page, bootApp, setTheme }) => {
    await setTheme(page, theme);
    await bootApp(page);
    await page.goto("/");
    await waitForPrimaryNavigation(page);
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Finish setting up your workspace",
        exact: true,
      }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(`landing-${theme}.png`);
  });

  test(`command-palette-${theme}`, async ({ page, bootApp, setTheme }) => {
    await setTheme(page, theme);
    await bootApp(page);
    await page.goto("/");
    await waitForPrimaryNavigation(page);
    await page.waitForTimeout(300);
    await page.keyboard.press(`${META_KEY}+K`);
    await page
      .locator(".cmdk-overlay")
      .waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot(`cmdk-${theme}.png`);
  });

  test(`subscribers-${theme}`, async ({ page, bootApp, setTheme }) => {
    await setTheme(page, theme);
    await bootApp(page);
    await page.goto("/");
    await waitForPrimaryNavigation(page);
    // Click the sidebar item rather than relying on keyboard shortcuts
    // or URL routing — both are app-specific concerns, the click works
    // independent of the navigation strategy.
    await page
      .getByRole("navigation", { name: "Primary" })
      .locator('button[data-section="subscribers"]')
      .click();
    await expect(
      page.getByRole("heading", { name: "Subscribers", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Total", { exact: true }).first(),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(`subscribers-${theme}.png`);
  });

  test(`tags-${theme}`, async ({ page, bootApp, setTheme }) => {
    await setTheme(page, theme);
    await bootApp(page);
    await page.goto("/");
    await waitForPrimaryNavigation(page);
    await page
      .getByRole("navigation", { name: "Primary" })
      .locator('button[data-section="tags"]')
      .click();
    await expect(
      page.getByRole("heading", { name: "Tags", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search tags" }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(`tags-${theme}.png`);
  });
}

test("System theme follows a live operating-system palette change", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await setTheme(page, "system");
  await bootApp(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);

  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-theme-preference", "system");
  await expect(root).not.toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).not.toHaveAttribute("data-theme", "light");
});

/**
 * Reduced-motion test: the app's CSS has a `@media (prefers-reduced-motion: reduce)`
 * block (search styles.css for `prefers-reduced-motion`) that disables
 * tour/confetti animations. Catches regressions where someone adds a new
 * animation without honoring the media query.
 */
test("respects prefers-reduced-motion", async ({
  browser,
  bootApp,
  setTheme,
}) => {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  try {
    await setTheme(page, "dark");
    await bootApp(page);
    await page.goto("/");
    await waitForPrimaryNavigation(page);
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Finish setting up your workspace",
        exact: true,
      }),
    ).toBeVisible();
    await page.waitForTimeout(500);
    // A reduced-motion run should be visually identical to a normal-motion
    // run for the static shell (no animations are in-flight at this
    // moment). We use a separate snapshot so any drift is caught.
    await expect(page).toHaveScreenshot("landing-reduced-motion.png");
  } finally {
    await context.close();
  }
});
