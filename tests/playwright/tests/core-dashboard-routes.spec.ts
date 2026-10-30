import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { seedSampleData } from "../fixtures/test-data";
import { loginAsDemo } from "../helpers/auth";

const ROUTES = [
  { path: "/app", heading: /welcome|good |dashboard/i },
  { path: "/app/campaigns", heading: "Campaigns" },
  { path: "/app/subscribers", heading: "Subscribers" },
  { path: "/app/templates", heading: "Newsletter templates" },
  { path: "/app/forms", heading: "Forms" },
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

const DASHBOARD_STATS = {
  subscribers_total: 2,
  subscribers_added_30d: 2,
  subscribers_unsubbed_30d: 0,
  campaigns_sent_30d: 1,
  opens_total_30d: 8,
  clicks_total_30d: 3,
  bounces_total_30d: 0,
  emails_sent_30d: 12,
  unique_opens_30d: 2,
  unique_clicks_30d: 1,
  unique_bounces_30d: 0,
  unique_delivered_30d: 2,
  unique_sent_30d: 2,
  active_sequences_count: 0,
  range: "30d",
  previous: {
    subscribers_added: 1,
    subscribers_unsubbed: 0,
    campaigns_sent: 1,
    opens_total: 5,
    clicks_total: 2,
    bounces_total: 0,
    emails_sent: 10,
  },
  sparklines: {
    subscribers: [0, 1, 0, 1],
    opens: [1, 2, 2, 3],
    clicks: [0, 1, 1, 1],
    bounces: [0, 0, 0, 0],
  },
  anomalies: {},
  inbox_health: { score: 96, state: "healthy" },
  recent_audit: [],
};

async function dismissTour(page: Page): Promise<void> {
  await page.route("**/api/v1/onboarding/steps", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        steps: { dashboard_tour: { state: "dismissed" } },
      }),
    });
  });
}

async function waitForRoute(page: Page, heading: string | RegExp) {
  await expect(
    page.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("main#main-content")).toBeVisible();
  // Route transitions briefly lower the whole page's opacity. Running axe in
  // that interval reports contrast for pixels users never interact with.
  await page
    .locator('[data-slot="page-transition"]')
    .evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    });
}

async function waitForRouteData(page: Page, path: string): Promise<void> {
  if (path === "/app") {
    await expect(page.getByTestId("dashboard-last-updated")).toHaveAttribute(
      "data-updated-at",
      /\S+/,
      { timeout: 30_000 },
    );
  } else if (path === "/app/campaigns" || path === "/app/subscribers") {
    await expect(page.locator('tbody tr[aria-hidden="true"]')).toHaveCount(0, {
      timeout: 30_000,
    });
  } else if (path === "/app/templates") {
    await expect(
      page.getByText("Finding designs…", { exact: true }),
    ).toHaveCount(0, {
      timeout: 30_000,
    });
  }
}

async function expectDialogQuality(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });

  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
  expect.soft(geometry.left).toBeGreaterThanOrEqual(0);
  expect.soft(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect.soft(geometry.top).toBeGreaterThanOrEqual(0);
  expect.soft(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);

  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );
  expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

test.describe("core dashboard route quality", () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await seedSampleData(baseURL!);
    await page.route("**/api/v1/dashboard/stats**", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(DASHBOARD_STATS),
      });
    });
    await page.route("**/api/v1/campaign-templates/search**", async (route) => {
      const request = route.request();
      const query = new URL(request.url()).searchParams.get("q");
      if (request.method() !== "GET" || query !== "no-such-template-99p9") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          items: [],
          next_cursor: null,
          page: 1,
          per_page: 24,
          total: 0,
          facets: {},
        }),
      });
    });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await dismissTour(page);
    await loginAsDemo(page, { navigate: false });
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: routes keep one main, no overflow, and no blocking axe findings`, async ({
      page,
    }) => {
      const mobileProject = test.info().project.name.includes("mobile");
      test.skip(
        viewport.label === "desktop" ? mobileProject : !mobileProject,
        "Each viewport runs once in its matching browser project.",
      );
      test.slow();
      await page.setViewportSize(viewport);

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      for (const route of ROUTES) {
        consoleErrors.length = 0;
        pageErrors.length = 0;
        await page.goto(route.path, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await waitForRoute(page, route.heading);
        await waitForRouteData(page, route.path);

        const layout = await page.evaluate(() => {
          const routeRoot = document.querySelector(
            '#main-content [data-slot="page-transition"]',
          );
          const undersized = Array.from(
            routeRoot?.querySelectorAll<HTMLElement>(
              "button, a[href], summary, input, select, textarea",
            ) ?? [],
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
              // A checkbox nested in a label uses the label as its effective
              // pointer target even when the native control is visually small.
              const hitTarget =
                element instanceof HTMLInputElement
                  ? (element.closest<HTMLElement>("label") ?? element)
                  : element;
              const rect = hitTarget.getBoundingClientRect();
              return {
                label:
                  element.getAttribute("aria-label") ||
                  element.getAttribute("title") ||
                  element.textContent
                    ?.trim()
                    .replace(/\s+/g, " ")
                    .slice(0, 80) ||
                  element.tagName,
                width: Math.round(rect.width * 10) / 10,
                height: Math.round(rect.height * 10) / 10,
              };
            })
            .filter(({ width, height }) => width < 24 || height < 24);

          const main = document.querySelector<HTMLElement>("main#main-content");
          let mainHorizontallyScrollable = false;
          if (main) {
            const previousScrollLeft = main.scrollLeft;
            main.scrollLeft = 10_000;
            mainHorizontallyScrollable = main.scrollLeft > 1;
            main.scrollLeft = previousScrollLeft;
          }
          const overflowing = Array.from(
            routeRoot?.querySelectorAll<HTMLElement>("*") ?? [],
          )
            .filter(
              (element) =>
                element.scrollWidth - element.clientWidth > 1 &&
                element.clientWidth > 0,
            )
            .slice(0, 12)
            .map((element) => ({
              tag: element.tagName,
              className: element.className,
              clientWidth: element.clientWidth,
              scrollWidth: element.scrollWidth,
            }));
          return {
            mainCount: document.querySelectorAll("main").length,
            h1Count: routeRoot?.querySelectorAll("h1").length ?? 0,
            documentOverflow:
              document.documentElement.scrollWidth - window.innerWidth,
            mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
            mainHorizontallyScrollable,
            overflowing,
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

        console.log(
          `CORE_AUDIT ${viewport.label} ${route.path} ${JSON.stringify({
            layout,
            consoleErrors,
            pageErrors,
            blocking: blocking.map(({ id, impact, nodes }) => ({
              id,
              impact,
              targets: nodes.map((node) => node.target),
            })),
          })}`,
        );

        expect
          .soft(layout.mainCount, `${route.path} should have one main`)
          .toBe(1);
        expect.soft(layout.h1Count, `${route.path} should have one h1`).toBe(1);
        expect
          .soft(layout.documentOverflow, `${route.path} document overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(layout.mainOverflow, `${route.path} main overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(
            layout.mainHorizontallyScrollable,
            `${route.path} shell main must not become a horizontal scroller`,
          )
          .toBe(false);
        expect.soft(consoleErrors, `${route.path} console errors`).toEqual([]);
        expect.soft(pageErrors, `${route.path} page errors`).toEqual([]);
        expect.soft(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
        if (viewport.width <= 375) {
          expect
            .soft(layout.undersized, `${route.path} undersized touch targets`)
            .toEqual([]);
        }
      }
    });
  }

  test("320px: filters, dialogs, menus, and mobile actions stay operable", async ({
    page,
  }) => {
    test.skip(
      !test.info().project.name.includes("mobile"),
      "This compact-layout interaction journey belongs to the mobile project.",
    );
    test.slow();
    await page.setViewportSize({ width: 320, height: 800 });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const url = new URL(response.url());
      failedResponses.push(`${response.status()} ${url.pathname}${url.search}`);
    });

    await page.goto("/app");
    await waitForRoute(page, /welcome|good |dashboard/i);
    await waitForRouteData(page, "/app");
    await page.getByRole("button", { name: "Customize" }).click();
    const customizePanel = page
      .getByText("Show, hide, and reorder the cards on your home dashboard.")
      .locator("..");
    const widgetCheckbox = customizePanel.getByRole("checkbox").first();
    const originalChecked = await widgetCheckbox.isChecked();
    await widgetCheckbox.focus();
    await page.keyboard.press("Space");
    expect(await widgetCheckbox.isChecked()).toBe(!originalChecked);
    await customizePanel.getByRole("button", { name: "Cancel" }).click();
    await expect(customizePanel).toBeHidden();

    await page.goto("/app/campaigns");
    await waitForRoute(page, "Campaigns");
    await waitForRouteData(page, "/app/campaigns");
    await page.getByRole("button", { name: "New campaign" }).click();
    await expectDialogQuality(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await expect(
      page.getByText("Name is required.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Subject is required.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#campaign-name")).toBeFocused();
    await page.keyboard.press("Escape");

    const campaignSearch = page.getByRole("textbox", {
      name: "Search campaigns",
    });
    await campaignSearch.fill("no-such-campaign-99p9");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText(/No campaigns match/)).toBeVisible();
    await campaignSearch
      .locator("..")
      .getByRole("button", { name: "Clear search" })
      .click();
    const campaignRow = page
      .locator('[data-testid="campaign-row"][data-status="draft"]')
      .first();
    await expect(campaignRow).toBeVisible();

    await campaignRow.focus();
    await page.keyboard.press("Enter");
    await expect(campaignRow).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Schedule send" }),
    ).toBeVisible();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Send campaign" }),
    ).toBeVisible();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");

    await page.goto("/app/subscribers");
    await waitForRoute(page, "Subscribers");
    await waitForRouteData(page, "/app/subscribers");
    const advancedSegmentationCard = page
      .getByText("Advanced segmentation", { exact: true })
      .locator("..");
    const dimensionBadge = advancedSegmentationCard
      .locator('[tabindex="0"]')
      .first();
    await dimensionBadge.scrollIntoViewIfNeeded();
    await dimensionBadge.focus();
    const dimensionTooltip = page.getByRole("tooltip");
    await expect(dimensionTooltip).toBeVisible();
    const tooltipBounds = await dimensionTooltip.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const main = document.querySelector<HTMLElement>("main#main-content");
      return {
        left: rect.left,
        right: rect.right,
        viewportWidth: window.innerWidth,
        mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      };
    });
    expect(tooltipBounds.left).toBeGreaterThanOrEqual(0);
    expect(tooltipBounds.right).toBeLessThanOrEqual(
      tooltipBounds.viewportWidth,
    );
    expect(tooltipBounds.mainOverflow).toBeLessThanOrEqual(1);
    await page.keyboard.press("Escape");
    const subscriberCard = page.getByTestId("subscriber-row").first();
    await expect(
      subscriberCard.getByRole("button", { name: "Archive" }),
    ).toBeVisible();
    const subscriberCheckbox = subscriberCard.getByRole("checkbox");
    await subscriberCheckbox.check();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    await page.getByRole("button", { name: "New subscriber" }).click();
    await expectDialogQuality(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Save" })
      .click();
    await expect(
      page.getByText("Email is required.", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#sub-email")).toBeFocused();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Paste emails" }).click();
    await expectDialogQuality(page);
    await expect(
      page.getByRole("dialog").getByRole("button", { name: "Add emails" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");

    const subscriberSearch = page.getByRole("textbox", {
      name: "Search subscribers",
    });
    await subscriberSearch.fill("no-such-subscriber-99p9@example.invalid");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByText("No subscribers match your search.").first(),
    ).toBeVisible();
    await subscriberSearch
      .locator("..")
      .getByRole("button", { name: "Clear search" })
      .click();
    await expect(page.getByTestId("subscriber-row").first()).toBeVisible();

    await page.goto("/app/templates");
    await waitForRoute(page, "Newsletter templates");
    await waitForRouteData(page, "/app/templates");
    // The default Inspiration view lists the built-in starters from the real
    // catalogue (this query is not mocked). It once asked for kind=reference,
    // which no migrated database has, and showed an empty library (TMPL-A).
    const firstDesign = page.getByRole("article").first();
    await expect(firstDesign).toBeVisible();
    await expect(
      firstDesign.getByRole("button", { name: "Use", exact: true }),
    ).toBeVisible();
    const inspirationTab = page.getByRole("tab", { name: /Inspiration/ });
    await inspirationTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: /My templates/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(
      /\/app\/templates\?view=mine&goal=all&source=mine$/,
    );
    await expect(
      page.getByText("Finding designs…", { exact: true }),
    ).toHaveCount(0);
    await inspirationTab.click();
    await expect(page).toHaveURL(/\/app\/templates$/);
    await expect(
      page.getByText("Finding designs…", { exact: true }),
    ).toHaveCount(0);

    const templateSearch = page.getByRole("textbox", {
      name: "Search designs",
    });
    await templateSearch.fill("no-such-template-99p9");
    await expect(page).toHaveURL(/\/app\/templates\?q=no-such-template-99p9$/);
    await expect(
      page.getByText("No designs match these filters"),
    ).toBeVisible();
    await templateSearch
      .locator("..")
      .getByRole("button", { name: "Clear search" })
      .click();
    await page
      .getByRole("button", { name: "Generate with AI" })
      .first()
      .click();
    await expectDialogQuality(page);
    await expect(page.locator("#template-generation-brief")).toBeFocused();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Generate design" })
      .click();
    await expect(
      page.getByText(
        "Describe the newsletter, audience, sections, and main CTA.",
      ),
    ).toBeVisible();
    await expect(page.locator("#template-generation-brief")).toBeFocused();
    await page.keyboard.press("Escape");

    await page.goto("/app/forms");
    await waitForRoute(page, "Forms");
    const mobileForms = page.getByRole("list", { name: "Forms" });
    await expect(mobileForms).toBeVisible();
    await expect(
      page.locator('[role="region"][aria-label="Forms table"]'),
    ).toBeHidden();
    const actionTrigger = mobileForms
      .getByRole("button", { name: /Actions for/ })
      .first();
    await actionTrigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Edit" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem").nth(1)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(actionTrigger).toBeFocused();

    const formCheckbox = mobileForms.getByRole("checkbox").first();
    await formCheckbox.check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Delete 1 form?" }),
    ).toBeVisible();
    await expectDialogQuality(page);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel" })
      .click();
    await page.getByRole("button", { name: "Clear", exact: true }).click();

    const formSearch = page.getByRole("textbox", { name: "Search forms" });
    await formSearch.fill("no-such-form-99p9");
    await formSearch.press("Enter");
    await expect(page.getByText("No forms match your filters.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(mobileForms.getByRole("listitem").first()).toBeVisible();
    const providerDetails = page.locator("details").filter({
      hasText: "Multi-channel & provider setup",
    });
    await providerDetails.locator("summary").click();
    await expect(providerDetails).toHaveAttribute("open", "");

    console.log(
      `CORE_INTERACTION_HTTP ${JSON.stringify([...new Set(failedResponses)])}`,
    );
    const javascriptConsoleErrors = consoleErrors.filter(
      (message) => !message.startsWith("Failed to load resource:"),
    );
    expect.soft(pageErrors, "interactive route page errors").toEqual([]);
    expect
      .soft(
        javascriptConsoleErrors,
        "interactive route JavaScript console errors",
      )
      .toEqual([]);
  });
});
