import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const SETTINGS_SURFACES = [
  ["/app/settings", "Workspace"],
  ["/app/settings/notifications", "Notifications"],
  ["/app/settings/team", "Team"],
  ["/app/settings/sender", "Sender Identity"],
  ["/app/settings/send-time", "Send-Time Optimization"],
  ["/app/settings/domain", "Domain & DNS"],
  ["/app/settings/custom-fields", "Custom Fields"],
  ["/app/settings/topics", "Topics"],
  ["/app/settings/api", "API Keys"],
  ["/app/settings/webhooks", "Webhooks"],
  ["/app/settings/integrations", "Integrations"],
  ["/app/settings/developer", "Developer"],
  ["/app/settings/offline", "Offline Sync"],
  ["/app/settings/security", "Security"],
  ["/app/settings/audit", "Audit Log"],
  ["/app/settings/audit-sinks", "Audit Streaming"],
  ["/app/settings/data-region", "Data Region"],
  ["/app/settings/privacy", "Privacy"],
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

async function settledAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      })
      .every((animation) => animation.playState === "finished"),
  );
}

test.describe("settings surface quality", () => {
  test.describe.configure({ mode: "serial" });

  for (const [path, label] of SETTINGS_SURFACES) {
    test(`${path} is structurally complete, responsive, and accessible`, async ({
      page,
    }) => {
      test.slow();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await loginAsDemo(page, { navigate: false });

      const consoleErrors: string[] = [];
      const consoleReads: Promise<void>[] = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleReads.push(
            (async () => {
              const location = message.location();
              const source = location.url
                ? ` (${location.url}:${location.lineNumber}:${location.columnNumber})`
                : "";
              const args = await Promise.all(
                message.args().map(async (argument) => {
                  try {
                    return await argument.jsonValue();
                  } catch {
                    return "[unserializable console argument]";
                  }
                }),
              );
              consoleErrors.push(
                `${message.text()}${source} args=${JSON.stringify(args)}`,
              );
            })(),
          );
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const response = await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      expect(response?.status(), `${path} document response`).toBeLessThan(400);

      await expect(
        page.getByRole("heading", { level: 1, name: label, exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("main#main-content")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
      await expect(page).toHaveTitle(
        new RegExp(`^${label} settings \\| Moosewave$`),
      );

      const mobile = (page.viewportSize()?.width ?? 1024) < 768;
      const settingsSelect = page.getByLabel("Settings section", {
        exact: true,
      });
      const settingsNav = page.getByRole("navigation", {
        name: "Settings sections",
        exact: true,
      });
      if (mobile) {
        await expect(settingsSelect).toBeVisible();
        await expect(settingsSelect).toHaveValue(path);
        const box = await settingsSelect.boundingBox();
        expect(
          box?.height ?? 0,
          "mobile settings selector target",
        ).toBeGreaterThanOrEqual(43.5);
        await expect(settingsNav).toBeHidden();
      } else {
        await expect(settingsNav).toBeVisible();
        await expect(settingsNav.locator(`a[href="${path}"]`)).toHaveAttribute(
          "aria-current",
          "page",
        );
      }

      const geometry = await page.evaluate(() => ({
        viewport: window.innerWidth,
        html: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        duplicateIds: Array.from(document.querySelectorAll("[id]"))
          .map((node) => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
      }));
      expect(
        Math.max(geometry.html, geometry.body),
        `${path} overflows ${geometry.viewport}px`,
      ).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.duplicateIds, `${path} duplicate DOM ids`).toEqual([]);

      await settledAnimations(page);
      const result = await new AxeBuilder({ page })
        .include("main#main-content")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = result.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      await Promise.all(consoleReads);
      expect(pageErrors, `${path} uncaught page errors`).toEqual([]);
      expect(consoleErrors, `${path} browser console errors`).toEqual([]);
    });
  }
});
