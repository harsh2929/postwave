import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const FORGE_SURFACES = [
  ["/forge", "Agent integration source, with explicit preview limits."],
  ["/forge/docs", "Forge docs"],
  ["/forge/motion-preview", "Seven motion.dev candidates."],
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function collectBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  return { consoleErrors, pageErrors };
}

test.describe("Forge surface quality", () => {
  for (const [path, heading] of FORGE_SURFACES) {
    test(`${path} is responsive, operable, and accessible`, async ({
      page,
      isMobile,
    }) => {
      test.slow();
      if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      const errors = collectBrowserErrors(page);

      const response = await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      expect(response?.status(), `${path} document response`).toBeLessThan(400);
      await expect(
        page.getByRole("heading", { level: 1, name: heading, exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("main#forge-main")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);

      const geometry = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
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

      const forgeNav = page.getByRole("navigation", {
        name: "Forge",
        exact: true,
      });
      await expect(forgeNav).toBeVisible();
      if (isMobile) {
        const targetHeights = await forgeNav
          .locator("a")
          .evaluateAll((links) =>
            links.map((link) => link.getBoundingClientRect().height),
          );
        expect(targetHeights.length).toBeGreaterThan(0);
        expect(
          Math.min(...targetHeights),
          `${path} mobile Forge navigation target height`,
        ).toBeGreaterThanOrEqual(43.5);
      }

      await page.keyboard.press("Home");
      await page.keyboard.press("Tab");
      const skipLink = page.getByRole("link", { name: "Skip to content" });
      await expect(skipLink).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("main#forge-main")).toBeFocused();

      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = result.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      expect(errors.pageErrors, `${path} uncaught page errors`).toEqual([]);
      expect(errors.consoleErrors, `${path} browser console errors`).toEqual(
        [],
      );
    });
  }

  test("motion preview remains complete and interactive with reduced motion", async ({
    page,
    isMobile,
  }) => {
    if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors = collectBrowserErrors(page);
    await page.goto("/forge/motion-preview", { waitUntil: "domcontentloaded" });

    const sectionNav = page.getByRole("navigation", {
      name: "Motion demo sections",
    });
    const sectionLinks = sectionNav.getByRole("link");
    await expect(sectionLinks).toHaveCount(7);
    for (let index = 0; index < 7; index += 1) {
      const sectionId = `demo-${index + 1}`;
      await sectionLinks.nth(index).click();
      await expect(page).toHaveURL(new RegExp(`#${sectionId}$`, "u"));
      await expect(page.locator(`#${sectionId}`)).toBeInViewport();
    }

    const terminal = page.getByRole("group", {
      name: "Terminal type-on motion example",
    });
    await terminal.scrollIntoViewIfNeeded();
    await expect(terminal).toContainText("setup: unavailable");

    const categories = page.getByRole("list", {
      name: "Source category counts",
    });
    await expect(categories.getByRole("listitem")).toHaveCount(19);
    await expect(categories).toContainText("audience");
    await expect(categories).toContainText("12");

    const sandboxCode = page.getByRole("group", {
      name: "Sandbox code motion example",
    });
    await sandboxCode.focus();
    await expect(sandboxCode).toBeFocused();
    await expect(
      page.locator("#demo-3").getByText("copy", { exact: true }),
    ).toHaveCount(1);

    const sourceSteps = page.getByRole("list", {
      name: "Source status steps",
    });
    await sourceSteps.scrollIntoViewIfNeeded();
    await expect(sourceSteps.getByRole("listitem")).toHaveCount(6);
    const stepOpacities = await sourceSteps
      .getByRole("listitem")
      .evaluateAll((steps) =>
        steps.map((step) => getComputedStyle(step).opacity),
      );
    expect(stepOpacities).toEqual(Array(6).fill("1"));

    const sidebarDemo = page.getByRole("group", {
      name: "Documentation sidebar demo",
    });
    const quickstart = sidebarDemo.getByRole("button", { name: "Quickstart" });
    const tools = sidebarDemo.getByRole("button", {
      name: "Tools",
      exact: true,
    });
    await expect(quickstart).toHaveAttribute("aria-pressed", "true");
    await tools.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const viewportHeight =
        window.visualViewport?.height ?? document.documentElement.clientHeight;
      const top =
        window.scrollY + rect.top - viewportHeight / 2 + rect.height / 2;
      window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
    });
    await expect(tools).toBeInViewport();
    const pointerTarget = await tools.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        ownsHit: hit === button || Boolean(hit && button.contains(hit)),
      };
    });
    expect(
      pointerTarget.ownsHit,
      "Tools button owns its visual hit target",
    ).toBe(true);
    if (isMobile) {
      await tools.tap();
    } else {
      await page.mouse.click(pointerTarget.x, pointerTarget.y);
    }
    await expect(tools).toHaveAttribute("aria-pressed", "true");
    await expect(quickstart).toHaveAttribute("aria-pressed", "false");

    const stats = page.locator("#demo-6");
    await stats.scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        stats
          .getByText("Source definitions", { exact: true })
          .locator("..")
          .locator("div")
          .first()
          .textContent(),
      )
      .not.toBe("0");
    await expect
      .poll(async () =>
        stats
          .getByText("Categories", { exact: true })
          .locator("..")
          .locator("div")
          .first()
          .textContent(),
      )
      .not.toBe("0");

    const pricingTiers = page.getByRole("list", {
      name: "Illustrative pricing tiers",
    });
    await expect(pricingTiers.getByRole("listitem")).toHaveCount(4);
    const featuredTier = pricingTiers.getByRole("listitem", {
      name: "cloud_sending, $29 monthly · up to 50K managed sends",
    });
    await featuredTier.focus();
    await expect(featuredTier).toBeFocused();
    await expect(featuredTier).toHaveCSS("transform", "none");

    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });
});
