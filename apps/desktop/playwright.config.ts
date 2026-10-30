import { defineConfig, devices } from "@playwright/test";

const visualPortValue = process.env.POSTWAVE_VISUAL_PORT ?? "1421";
if (!/^\d{1,5}$/u.test(visualPortValue)) {
  throw new Error("POSTWAVE_VISUAL_PORT must be a decimal TCP port");
}
const visualPort = Number(visualPortValue);
if (visualPort < 1024 || visualPort > 65_535) {
  throw new Error("POSTWAVE_VISUAL_PORT must be between 1024 and 65535");
}
const visualBaseURL = `http://localhost:${visualPort}`;

/**
 * Playwright config for desktop visual regression.
 *
 * Tests build and serve the optimized Vite renderer (port 1421 to avoid
 * clashing with a dev session on 1420) and visit it directly in Chromium.
 * The fixture in tests/visual/fixture.ts stubs the Tauri runtime so the
 * NotInTauri gate is bypassed, then mocks the few API endpoints the boot
 * pipeline touches.
 *
 * BASELINE WORKFLOW
 *   First run on a clean checkout will fail with "no baseline" errors.
 *   Generate baselines locally with `pnpm test:visual -- --update-snapshots`
 *   then commit the resulting `*.png` files in tests/visual/__screenshots__/.
 *   In CI, the test job is gated on these baselines staying within the diff
 *   threshold below.
 */
export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  expect: {
    // Allow tiny aliasing differences (subpixel anti-aliasing, font hinting)
    // without flapping. Anything above ~0.2% pixel diff fails — enough signal
    // to catch a wrong color token, not so tight it complains about fonts.
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.002,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL: visualBaseURL,
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
    // Production chunks match the Tauri payload and avoid source-transform
    // races on the largest lazy routes. Port 1421 keeps a real development
    // session on 1420 from clashing with the regression runner.
    command: `pnpm build && pnpm exec vite preview --port ${visualPort} --strictPort`,
    url: visualBaseURL,
    // Production builds default to api.moosewave.com. A deterministic browser
    // qualification must never probe a live host, so compile the visual
    // candidate against the local origin that the shared fixture intercepts.
    // This is build-time configuration; localStorage alone is too late because
    // the native broker bootstrap can restore the compiled default first.
    env: {
      VITE_API_URL: "http://localhost:8080",
      // Optimized renderer tests are packaged by Vite but intentionally use
      // an intercepted loopback API. Mark that profile explicitly so the
      // production-only HTTPS guard does not reject the harness before its
      // routes can answer.
      VITE_BUILD_PROFILE:
        process.env.VITE_BUILD_PROFILE ?? "visual-test",
    },
    // Keep the canonical command fail-closed, while allowing an explicitly
    // started source server to support route-level audits when an unrelated
    // dirty-worktree typecheck prevents the production bundle from building.
    // CI never sets this escape hatch.
    reuseExistingServer: process.env.POSTWAVE_VISUAL_REUSE_SERVER === "1",
    // Cold TypeScript builds on release-sized worktrees can legitimately
    // exceed two minutes. Keep the harness from killing a healthy candidate
    // before Chromium starts; per-test timeouts still catch renderer stalls.
    timeout: 240_000,
  },
});
