/**
 * Audit walkthrough — comprehensive UI/UX review screenshot capture.
 *
 * NOT a regression test. Walks every sidebar section, both themes,
 * plus a few key modal/slideover states, and writes screenshots to
 * a custom dir so the auditor (human or agent) can review them.
 *
 *   pnpm test:visual -- audit-walkthrough.spec.ts
 *
 * Output: <repo>/audit-screenshots/<YYYY-MM-DD>/<section>-<theme>.png
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { test, expect, waitForPrimaryNavigation } from "./fixture";
import { PRIMARY_DESKTOP_SECTIONS } from "./sections";

const today = new Date().toISOString().slice(0, 10);
const outDirRoot = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "audit-screenshots",
  today,
);

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

for (const theme of ["dark", "light"] as const) {
  test.describe(`walkthrough-${theme}`, () => {
    /* One test per section + theme — keeps each capture isolated so
     * a single failing nav doesn't cascade. */
    for (const section of PRIMARY_DESKTOP_SECTIONS) {
      test(`${section.id}-${theme}`, async ({ page, bootApp, setTheme }) => {
        await ensureDir(outDirRoot);
        await setTheme(page, theme);
        /* P3 audit (2026-06-02): re-shoot at 1440x900 because three pages
         * (Webhook simulator, Agency, SMS inbox) appeared blank above the
         * fold at the original 1280x800 viewport. Larger viewport closer
         * to real desktop usage; matches the Tauri shell's default size. */
        await page.setViewportSize({ width: 1440, height: 900 });
        await bootApp(page);
        await page.goto("/");
        await waitForPrimaryNavigation(page);

        if (section.id !== "dashboard") {
          /* Click the sidebar item rather than relying on URL routing
           * or keyboard shortcuts — the click works independent of how
           * routing is implemented. */
          const item = page
            .getByRole("navigation", { name: "Primary" })
            .locator(`button[data-section="${section.id}"]`);
          await item.click({ trial: false });
          await expect(item).toHaveAttribute("aria-current", "page");
        }
        const destinationHeading = page
          .getByRole("heading", { name: section.heading, exact: false })
          .first();
        await expect(destinationHeading).toBeVisible({ timeout: 15_000 });
        /* Give entrance animations + lazy-mounted content time to
         * settle. The fixture turns animations off via
         * toHaveScreenshot, but custom screenshot() calls don't honor
         * that config — wait deterministically instead. */
        await page.waitForTimeout(800);

        const out = path.join(outDirRoot, `${section.id}-${theme}.png`);
        await page.screenshot({ path: out, fullPage: false });
        await expect(page.locator('.pw-screen[role="alert"]')).toHaveCount(0);
        await expect(
          page.getByRole("navigation", { name: "Primary" }),
        ).toBeVisible();
        await expect(destinationHeading).toBeVisible();
      });
    }
  });
}
