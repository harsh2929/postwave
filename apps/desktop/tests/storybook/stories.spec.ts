/**
 * Storybook visual regression — one reference snapshot per story.
 *
 * Each entry below maps to a single Storybook URL (`?id=<slug>&viewMode=story`).
 * Playwright navigates to that URL inside the built Storybook bundle,
 * waits for the preview iframe's `#storybook-root` to render, then
 * captures a viewport screenshot.
 *
 * Adding a new story → add a new entry here. The story ID slug is the
 * lower-case title path joined with dashes, plus the export name
 * dasherised. Example: `Primitives/Modal` + `Plain` → `primitives-modal--plain`.
 *
 * We use the iframe URL (`/iframe.html?...`) directly rather than the
 * full Storybook UI so the snapshot only contains the story, not the
 * sidebar + addons panel chrome.
 */
import { test, expect } from "@playwright/test";

interface StoryEntry {
  id: string;
  /** Optional CSS selector to wait for before snapshotting. Defaults to #storybook-root. */
  ready?: string;
}

const STORIES: StoryEntry[] = [
  // Modal
  { id: "primitives-modal--plain" },
  { id: "primitives-modal--no-description" },
  // ConfirmModal
  { id: "primitives-confirmmodal--plain" },
  { id: "primitives-confirmmodal--destructive" },
  { id: "primitives-confirmmodal--type-to-confirm" },
  { id: "primitives-confirmmodal--busy" },
  // Slideover
  { id: "primitives-slideover--medium" },
  { id: "primitives-slideover--large" },
  { id: "primitives-slideover--small" },
  // Charts — LineChart
  { id: "charts-linechart--thirty-day-growth" },
  { id: "charts-linechart--flat" },
  // Charts — Sparkline
  { id: "charts-sparkline--up" },
  { id: "charts-sparkline--down" },
  { id: "charts-sparkline--empty" },
  // Charts — Heatmap
  { id: "charts-heatmap--retention" },
  { id: "charts-heatmap--empty" },
  // Toast
  { id: "primitives-toast--success" },
  { id: "primitives-toast--error" },
  { id: "primitives-toast--info" },
  { id: "primitives-toast--soon" },
  { id: "primitives-toast--with-action" },
  // SaveBar
  { id: "primitives-savebar--dirty" },
  { id: "primitives-savebar--saving" },
  { id: "primitives-savebar--error" },
  { id: "primitives-savebar--just-saved" },
  // Design-system convergence primitives
  { id: "primitives-notice--danger" },
  { id: "primitives-notice--assertive-override" },
  { id: "primitives-banner--dismissible" },
  { id: "primitives-card--with-header" },
  { id: "primitives-skeleton--multi-line" },
  { id: "primitives-skeleton--decorative-group" },
];

for (const story of STORIES) {
  test(`story: ${story.id}`, async ({ page }) => {
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    // Storybook injects `#storybook-root` once the story has mounted.
    // For overlay-style stories (modals, slideovers) the actual
    // content lives in a portal sibling; #storybook-root is still
    // the right "story has started rendering" signal.
    await page
      .locator(story.ready ?? "#storybook-root")
      .waitFor({ state: "attached", timeout: 15_000 });
    // Small settle for any RO-driven layout (LineChart uses
    // ResizeObserver) and font swap.
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot(`${story.id}.png`);
  });
}
