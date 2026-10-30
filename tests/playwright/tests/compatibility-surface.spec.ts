import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function collectRuntimeFailures(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedApiResponses: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && response.url().includes("/api/")) {
      failedApiResponses.push(`${response.status()} ${response.url()}`);
    }
  });

  return { consoleErrors, failedApiResponses, pageErrors };
}

async function waitForCompatibilityData(page: Page): Promise<void> {
  await expect(
    page.getByText(/^\d\/6 areas with data$/, { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("heading", { level: 2, name: "Contact model" }),
  ).toBeVisible();
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(
    0,
  );
}

test.describe("compatibility dashboard quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
  });

  test("is responsive, quiet, accessible, and preserves section navigation", async ({
    page,
    isMobile,
  }) => {
    test.slow();
    if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const failures = collectRuntimeFailures(page);

    const response = await page.goto("/app/compatibility", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Mailchimp compatibility",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await waitForCompatibilityData(page);

    const layout = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main#main-content");
      const controls = Array.from(
        main?.querySelectorAll<HTMLElement>("button, a[href]") ?? [],
      )
        .filter((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            !element.matches(":disabled")
          );
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.textContent
              ?.trim()
              .replace(/\s+/g, " ")
              .slice(0, 80),
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          };
        })
        .filter(({ width, height }) => width < 24 || height < 24);

      return {
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
        mainCount: document.querySelectorAll("main").length,
        h1Count: main?.querySelectorAll("h1").length ?? 0,
        duplicateIds: Array.from(document.querySelectorAll("[id]"))
          .map((node) => node.id)
          .filter((id, index, ids) => ids.indexOf(id) !== index),
        controls,
      };
    });
    expect(layout.mainCount).toBe(1);
    expect(layout.h1Count).toBe(1);
    expect(layout.documentOverflow).toBeLessThanOrEqual(1);
    expect(layout.mainOverflow).toBeLessThanOrEqual(1);
    expect(layout.duplicateIds).toEqual([]);
    if (isMobile) expect(layout.controls).toEqual([]);

    const nav = page.getByRole("navigation", { name: "Parity sections" });
    await expect(nav).toBeVisible();
    const workbenchLink = nav.getByRole("link", { name: "Parity workbench" });
    const contentLink = nav.getByRole("link", { name: "Content & AI" });
    await expect(workbenchLink).toHaveAttribute("aria-current", "location");
    if (isMobile) {
      const heights = await nav
        .locator("a")
        .evaluateAll((links) =>
          links.map((link) => link.getBoundingClientRect().height),
        );
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(43.5);
    }

    await contentLink.click();
    await expect(page).toHaveURL(/#compat-content$/);
    await expect(contentLink).toHaveAttribute("aria-current", "location");
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: "P2 content, AI, and assets",
      }),
    ).toBeInViewport();

    await page.goBack();
    await expect(page).toHaveURL(/\/app\/compatibility$/);
    await page.goForward();
    await expect(page).toHaveURL(/#compat-content$/);
    await waitForCompatibilityData(page);
    await expect(contentLink).toHaveAttribute("aria-current", "location");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^postwave-compatibility-\d{4}-\d{2}-\d{2}\.json$/,
    );

    const previewButton = page.getByRole("button", {
      name: "Preview template",
    });
    if ((await previewButton.count()) > 0) {
      await page.route(
        "**/api/mailchimp/3.0/template-language/preview",
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              html: "<h1>Hi Maya</h1>",
              text: "Hi Maya",
              found_tags: ["FNAME", "ARCHIVE", "UNSUB"],
              unsupported_tags: [],
              warnings: [],
              required_footer_present: true,
            }),
          });
        },
      );
      await expect(previewButton).toBeEnabled();
      await previewButton.click();
      await expect(
        page.getByText("Mailchimp template preview rendered"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^Template tags:/)).toBeVisible();
    }

    await page.route("**/api/v1/mailchimp-compat/summary", async (route) => {
      const apiResponse = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 250));
      await route.fulfill({ response: apiResponse });
    });
    const refresh = page.getByRole("button", { name: "Refresh" });
    await refresh.click();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeEnabled({ timeout: 60_000 });

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = axe.violations.filter(
      (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
    expect(failures.pageErrors).toEqual([]);
    expect(failures.consoleErrors).toEqual([]);
    expect(failures.failedApiResponses).toEqual([]);
  });
});
