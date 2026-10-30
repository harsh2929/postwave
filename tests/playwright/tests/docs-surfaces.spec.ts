import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

const DOC_ROUTES = [
  "/docs/getting-started",
  "/docs/quickstart",
  "/docs/api",
  "/docs/api/get-campaigns-abresults",
  "/docs/skills",
  "/docs/skills/account-sending-identity-update",
  "/docs/migrations",
  "/docs/migrations/mailchimp",
  "/docs/integrations",
  "/docs/integrations/slack",
  "/docs/changelog",
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

function collectRuntimeErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { consoleErrors, pageErrors };
}

async function waitForClientClickHandler(control: Locator): Promise<void> {
  // `load` proves that the route chunks arrived, but React may still be
  // hydrating a large server-rendered document such as /docs/api. Checking the
  // attached props keeps interaction tests from clicking inert SSR markup and
  // is deliberately narrower than the unreliable `networkidle` signal (the
  // Next dev client maintains background connections).
  await expect
    .poll(
      () =>
        control.evaluate((element) => {
          const propsKey = Object.keys(element).find((key) =>
            key.startsWith("__reactProps$"),
          );
          if (!propsKey) return false;
          const props = (
            element as unknown as Record<
              string,
              { onClick?: unknown } | undefined
            >
          )[propsKey];
          return typeof props?.onClick === "function";
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe("documentation surface quality", () => {
  for (const path of DOC_ROUTES) {
    test(`${path} is responsive, structured, and accessible`, async ({
      page,
      isMobile,
    }) => {
      test.slow();
      if (isMobile) await page.setViewportSize({ width: 320, height: 800 });
      await page.emulateMedia({ reducedMotion: "reduce" });

      // Compile/warm a dev route before the browser requests its HTML and
      // chunks. This prevents a live compilation boundary from being mistaken
      // for an application hydration defect while runtime errors remain strict.
      const warmResponse = await page.request.get(path, { timeout: 90_000 });
      expect(warmResponse.status(), `${path} warm response`).toBeLessThan(400);

      const errors = collectRuntimeErrors(page);
      const response = await page.goto(path, {
        waitUntil: "load",
        timeout: 90_000,
      });
      expect(response?.status(), `${path} document response`).toBeLessThan(400);
      await expect(page.locator("main#docs-main")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator("main#docs-main h1")).toHaveCount(1);
      await expect(page).toHaveTitle(/\S+/);
      await waitForClientClickHandler(
        isMobile
          ? page.getByRole("button", {
              name: "Open documentation navigation",
            })
          : page.getByRole("button", { name: "Search docs…" }),
      );

      const layout = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>("main#docs-main");
        const scope = document.querySelector<HTMLElement>(
          "body > div, body > main",
        );
        const undersized = Array.from(
          document.querySelectorAll<HTMLElement>(
            "header button, header a[href], main button, main a[href], footer a[href]",
          ),
        )
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            // Inline links embedded in prose use WCAG's inline-target
            // exception; standalone controls and pills do not.
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.display !== "inline" &&
              rect.width > 0 &&
              rect.height > 0 &&
              !element.matches(":disabled")
            );
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label:
                element.getAttribute("aria-label") ||
                element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80),
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          })
          .filter(({ width, height }) => width < 24 || height < 24);

        return {
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
          mainCount: document.querySelectorAll("main").length,
          h1Count: main?.querySelectorAll("h1").length ?? 0,
          duplicateIds: Array.from(document.querySelectorAll("[id]"))
            .map((node) => node.id)
            .filter((id, index, ids) => ids.indexOf(id) !== index),
          scopeExists: Boolean(scope),
          undersized,
        };
      });

      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      const blocking = axe.violations.filter(
        (violation) =>
          violation.impact && BLOCKING_IMPACTS.has(violation.impact),
      );

      expect
        .soft(layout.scopeExists, `${path} rendered document root`)
        .toBe(true);
      expect.soft(layout.mainCount, `${path} main landmarks`).toBe(1);
      expect.soft(layout.h1Count, `${path} h1 count`).toBe(1);
      expect
        .soft(layout.documentOverflow, `${path} document overflow`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(layout.bodyOverflow, `${path} body overflow`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(layout.mainOverflow, `${path} main overflow`)
        .toBeLessThanOrEqual(1);
      expect.soft(layout.duplicateIds, `${path} duplicate ids`).toEqual([]);
      if (isMobile) {
        expect.soft(layout.undersized, `${path} small targets`).toEqual([]);
      }
      expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
      expect.soft(errors.pageErrors, `${path} page errors`).toEqual([]);
      expect.soft(errors.consoleErrors, `${path} console errors`).toEqual([]);
    });
  }

  test("mobile navigation, search, and copy affordances are fully operable", async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, "mobile interaction coverage");
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/docs/getting-started", {
      waitUntil: "load",
      timeout: 90_000,
    });
    await expect(page.locator("main#docs-main h1")).toBeVisible();

    const menu = page.getByRole("button", {
      name: "Open documentation navigation",
    });
    await waitForClientClickHandler(menu);
    await menu.focus();
    await menu.click();
    const drawer = page.getByRole("dialog", { name: "Documentation" });
    await expect(drawer).toBeVisible();
    // Radix mounts the panel at its off-canvas start position for a frame;
    // visibility alone does not mean it has entered the viewport yet.
    await expect(drawer).toBeInViewport();
    const drawerBox = await drawer.boundingBox();
    expect(drawerBox).not.toBeNull();
    expect(drawerBox!.x).toBeGreaterThanOrEqual(0);
    expect(drawerBox!.width).toBeLessThanOrEqual(320);

    const filter = drawer.getByRole("textbox", {
      name: "Filter documentation navigation",
    });
    await filter.fill("zzzz-not-a-doc");
    await expect(drawer.getByText("No matches for")).toBeVisible({
      timeout: 30_000,
    });
    await drawer.getByRole("button", { name: "Clear filter" }).click();
    await expect(filter).toHaveValue("");

    await drawer.getByRole("link", { name: "Quickstart" }).click();
    await expect(page).toHaveURL(/\/docs\/quickstart$/);
    await expect(drawer).toBeHidden();
    await expect(
      page.getByRole("heading", { level: 1, name: "Quickstart" }),
    ).toBeVisible();

    const search = page.getByRole("button", { name: "Search docs…" });
    await search.focus();
    await search.click();
    const palette = page.getByRole("dialog", {
      name: "Search documentation",
    });
    const query = palette.getByRole("combobox", { name: "Search query" });
    await expect(query).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");
    await query.fill("quickstart");
    await expect(palette.getByTestId("search-result").first()).toBeVisible({
      timeout: 30_000,
    });
    await query.press("ArrowDown");
    await expect(query).toHaveAttribute("aria-activedescendant", /opt-/);
    await palette.getByRole("button", { name: "Close search" }).click();
    await expect(palette).toBeHidden();
    await expect(search).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");

    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    // Keep this locator stable while its accessible name correctly changes
    // from "Copy code" to "Copied"; selecting by the old name would stop
    // matching at the exact moment the assertion should succeed.
    const copy = page.locator("figure button").first();
    await expect(copy).toBeVisible();
    await expect(copy).toHaveAccessibleName("Copy code");
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await waitForClientClickHandler(copy);
    await copy.click();
    await expect(copy).toHaveAccessibleName("Copied");

    const codeRegion = page.getByRole("group", { name: /code sample/ }).first();
    await codeRegion.focus();
    await expect(codeRegion).toBeFocused();
  });
});
