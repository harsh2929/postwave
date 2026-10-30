import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for Storybook visual regression.
 *
 * Sibling to `playwright.config.ts` (which screenshots the running
 * desktop app shell). This config drives Storybook instead — one
 * snapshot per story, captured against the built static Storybook
 * bundle served from `storybook-static/`.
 *
 * The harness exists primarily to catch design-system regressions:
 *   - someone changes a token in styles.css and Modal/Sparkline drift
 *   - someone bumps Storybook's bundle and the chrome layout shifts
 *   - someone adds a story without realising the markup looks wrong
 *
 * BASELINE WORKFLOW
 *   First run will fail with "no baseline" errors. Generate locally:
 *     pnpm test:stories:update
 *   then commit the .png files under tests/storybook/__screenshots__/.
 *   CI runs `pnpm test:stories` against those baselines.
 */
export default defineConfig({
  testDir: "./tests/storybook",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  expect: {
    // Slightly looser than the app's visual config because Storybook's
    // own chrome (preview iframe wrapper) renders a few pixels of
    // padding that vary across Chromium minor versions.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: "http://localhost:6007",
    viewport: { width: 1280, height: 800 },
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    deviceScaleFactor: 1,
    colorScheme: "no-preference",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Serve the already-built static Storybook bundle on a non-default
    // port so a running `pnpm storybook` dev session (6006) doesn't
    // clash with CI runs.
    command: "npx http-server storybook-static -p 6007 -s",
    url: "http://localhost:6007",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
