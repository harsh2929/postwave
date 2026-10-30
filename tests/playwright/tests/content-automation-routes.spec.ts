import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const STATIC_ROUTES = [
  "/app/flows",
  "/app/sequences",
  "/app/sequences/new",
  "/app/sequences/voice-profile",
  "/app/sequence-templates",
  "/app/sequence-templates/new",
  "/app/landing-pages",
  "/app/onsite-growth",
  "/app/social-capture",
  "/app/assets",
  "/app/content-library",
  "/app/content-quality",
  "/app/ai-assist",
  "/app/ai-quality",
  "/app/voice-labels",
  "/app/translations",
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

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

async function waitForRoute(page: Page): Promise<void> {
  await expect(page.locator("main#main-content")).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.locator('#main-content [data-slot="page-transition"] h1'),
  ).toHaveCount(1, { timeout: 90_000 });
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

async function gotoRoute(page: Page, route: string): Promise<void> {
  await page.goto(route, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await waitForRoute(page);
  const routeRoot = page.locator('#main-content [data-slot="page-transition"]');
  // App Router can paint server HTML before React has attached handlers. Wait
  // for the client PageTransition boundary itself to hydrate before exercising
  // controls; otherwise a fast dev-server run can click inert markup.
  await expect
    .poll(
      () =>
        routeRoot.evaluate((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactFiber$")),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(routeRoot.locator('[class*="animate-pw-shimmer"]')).toHaveCount(
    0,
    { timeout: 60_000 },
  );
  await expect(routeRoot.locator('[aria-busy="true"]')).toHaveCount(0, {
    timeout: 60_000,
  });
}

async function requestFixture(
  page: Page,
  request: () => Promise<APIResponse>,
): Promise<APIResponse> {
  let lastResponse: APIResponse | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastResponse = await request();
    if (lastResponse.ok()) return lastResponse;
    await page.waitForTimeout(250 * (attempt + 1));
  }
  throw new Error(
    `Fixture request failed with ${lastResponse?.status() ?? "no response"}: ${
      lastResponse ? await lastResponse.text() : ""
    }`,
  );
}

async function ensureDynamicFixtures(page: Page): Promise<{
  flowId: string;
  landingPageId: string;
}> {
  const flowListResponse = await requestFixture(page, () =>
    page.request.get("/api/v1/flow-builder/flows?limit=1", {
      timeout: 60_000,
    }),
  );
  const flowList = (await flowListResponse.json()) as {
    items?: Array<{ id: string }>;
  };
  let flowId = flowList.items?.[0]?.id;
  if (!flowId) {
    const createFlowResponse = await requestFixture(page, () =>
      page.request.post("/api/v1/flow-builder/flows", {
        timeout: 60_000,
        data: {
          name: "Automation quality audit",
          status: "draft",
          entry_id: "audit_email",
          triggers: [{ type: "list_joined" }],
          nodes: [{ id: "audit_email", type: "send_email" }],
          edges: [],
        },
      }),
    );
    flowId = ((await createFlowResponse.json()) as { id: string }).id;
  }

  const landingListResponse = await requestFixture(page, () =>
    page.request.get("/api/v1/landing-pages", { timeout: 60_000 }),
  );
  const landingPages = (await landingListResponse.json()) as Array<{
    id: string;
  }>;
  let landingPageId = landingPages[0]?.id;
  if (!landingPageId) {
    const createLandingResponse = await requestFixture(page, () =>
      page.request.post("/api/v1/landing-pages", {
        timeout: 60_000,
        data: {
          name: "Content quality audit",
          slug: "content-quality-audit",
          template: "signup",
          blocks: [],
          seo: {},
          tracking: {},
        },
      }),
    );
    landingPageId = ((await createLandingResponse.json()) as { id: string }).id;
  }

  return { flowId, landingPageId };
}

async function auditRoute(page: Page) {
  const layout = await page.evaluate(() => {
    const routeRoot = document.querySelector<HTMLElement>(
      '#main-content [data-slot="page-transition"]',
    );
    const main = document.querySelector<HTMLElement>("main#main-content");
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const undersized = Array.from(
      routeRoot?.querySelectorAll<HTMLElement>(
        'button, a[href], summary, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]',
      ) ?? [],
    )
      .filter((element) => visible(element) && !element.matches(":disabled"))
      .map((element) => {
        const hitTarget =
          element instanceof HTMLInputElement
            ? (element.closest<HTMLElement>("label") ?? element)
            : element;
        const rect = hitTarget.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ||
            element.getAttribute("title") ||
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ||
            element.tagName,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        };
      })
      .filter(({ width, height }) => width < 24 || height < 24);

    let mainHorizontallyScrollable = false;
    if (main) {
      const before = main.scrollLeft;
      main.scrollLeft = 10_000;
      mainHorizontallyScrollable = main.scrollLeft > 1;
      main.scrollLeft = before;
    }

    const viewportOverflow = Array.from(
      routeRoot?.querySelectorAll<HTMLElement>("*") ?? [],
    )
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (!(rect.left < -1 || rect.right > window.innerWidth + 1)) {
          return false;
        }
        let parent = element.parentElement;
        while (parent && parent !== routeRoot) {
          const overflowX = getComputedStyle(parent).overflowX;
          if (["auto", "scroll", "hidden", "clip"].includes(overflowX)) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .slice(0, 12)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          label:
            element.getAttribute("aria-label") ||
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });

    return {
      heading: routeRoot?.querySelector("h1")?.textContent?.trim(),
      mainCount: document.querySelectorAll("main").length,
      h1Count: routeRoot?.querySelectorAll("h1").length ?? 0,
      documentOverflow:
        document.documentElement.scrollWidth - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      mainHorizontallyScrollable,
      viewportOverflow,
      undersized,
    };
  });

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );

  return {
    layout,
    blocking: blocking.map(({ id, impact, nodes }) => ({
      id,
      impact,
      targets: nodes.map((node) => node.target),
    })),
  };
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

test.describe("content and automation route quality", () => {
  test.beforeEach(async ({ page }) => {
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
    test(`${viewport.label}: static routes remain contained and accessible`, async ({
      page,
    }) => {
      const expectsMobileProject = viewport.label !== "desktop";
      test.skip(
        (test.info().project.name === "chromium-mobile") !==
          expectsMobileProject,
        "Desktop runs in Desktop Chrome; narrow/touch matrices run in mobile Chromium.",
      );
      test.slow();
      test.setTimeout(420_000);
      await page.setViewportSize(viewport);

      for (const route of STATIC_ROUTES) {
        const consoleErrors: string[] = [];
        const pageErrors: string[] = [];
        const onConsole = (message: { type(): string; text(): string }) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        };
        const onPageError = (error: Error) => pageErrors.push(error.message);
        page.on("console", onConsole);
        page.on("pageerror", onPageError);

        await page.goto(route, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await waitForRoute(page);
        const result = await auditRoute(page);

        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        const javascriptConsoleErrors = consoleErrors.filter(
          (message) => !message.includes("Failed to load resource"),
        );

        console.log(
          `CONTENT_AUTOMATION_AUDIT ${viewport.label} ${route} ${JSON.stringify(
            {
              ...result,
              consoleErrors,
              pageErrors,
            },
          )}`,
        );

        expect.soft(result.layout.mainCount, `${route}: one main`).toBe(1);
        expect.soft(result.layout.h1Count, `${route}: one h1`).toBe(1);
        expect
          .soft(result.layout.documentOverflow, `${route}: document overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(result.layout.mainOverflow, `${route}: main overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(
            result.layout.mainHorizontallyScrollable,
            `${route}: shell main horizontal scrolling`,
          )
          .toBe(false);
        expect
          .soft(result.layout.viewportOverflow, `${route}: viewport overflow`)
          .toEqual([]);
        expect
          .soft(result.layout.undersized, `${route}: effective touch targets`)
          .toEqual([]);
        expect.soft(result.blocking, `${route}: axe`).toEqual([]);
        expect
          .soft(javascriptConsoleErrors, `${route}: console errors`)
          .toEqual([]);
        expect.soft(pageErrors, `${route}: page errors`).toEqual([]);
      }
    });
  }

  test("320px: tabs, menus, dialogs, filters, and recovery states are operable", async ({
    page,
  }) => {
    test.skip(
      test.info().project.name !== "chromium-mobile",
      "The interaction matrix exercises the narrow touch context.",
    );
    test.slow();
    test.setTimeout(420_000);
    await page.setViewportSize({ width: 320, height: 800 });
    const { flowId, landingPageId } = await ensureDynamicFixtures(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await gotoRoute(page, "/app/flows");
    // The heading is server-rendered before the client query tree hydrates in
    // development. Waiting for the seeded card makes this a real interaction
    // check instead of racing an inert pre-hydration trigger.
    await expect(
      page.locator(`a[href="/app/flows/${flowId}"]`).first(),
    ).toBeVisible({ timeout: 60_000 });
    const newFlowTrigger = page
      .locator('button[aria-haspopup="dialog"]')
      .filter({ hasText: "New flow" })
      .first();
    await newFlowTrigger.focus();
    await newFlowTrigger.press("Enter");
    await expect(newFlowTrigger).toHaveAttribute("aria-expanded", "true");
    await expectDialogQuality(page);
    const flowDialog = page.getByRole("dialog");
    await flowDialog.getByRole("button", { name: "Welcome series" }).click();
    await expect(
      flowDialog.getByRole("button", { name: "Welcome series" }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(newFlowTrigger).toBeFocused();

    await gotoRoute(page, `/app/flows/${flowId}`);
    await page.getByRole("button", { name: "More" }).click();
    const journeyTrigger = page.getByRole("button", {
      name: "Preview journey",
    });
    await expect(journeyTrigger).toBeVisible();
    await journeyTrigger.click();
    await expectDialogQuality(page);
    await expect(page.getByRole("dialog")).toContainText("Email message");
    await page.keyboard.press("Escape");
    await expect(journeyTrigger).toBeFocused();
    await page.getByRole("button", { name: "Versions" }).click();
    await expect(
      page.getByText("Version history", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close version history" }).click();
    await page.getByRole("button", { name: "Runs" }).click();
    await expect(
      page.getByText("Run inspector", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Runs" }).click();

    await gotoRoute(page, "/app/sequences");
    const sequenceCheckbox = page
      .getByRole("checkbox", { name: /^Select (?!all)/ })
      .first();
    await sequenceCheckbox.check();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    const sequenceMenuTrigger = page
      .getByRole("button", { name: "Open actions menu" })
      .first();
    await sequenceMenuTrigger.click();
    await expect(
      page.getByRole("menu", { name: "Sequence actions" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sequenceMenuTrigger).toBeFocused();

    await gotoRoute(page, "/app/sequence-templates");
    const templateSearch = page.getByRole("textbox", {
      name: "Search sequence templates",
    });
    await templateSearch.fill("no-template-has-this-name");
    await expect(
      page.getByText("No sequence templates match your filters."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    const favorites = page.getByRole("button", { name: "Favorites" });
    await favorites.click();
    await expect(favorites).toHaveAttribute("aria-pressed", "true");
    await favorites.click();

    await gotoRoute(page, "/app/sequences/new");
    await page.getByTestId("palette-step-email").click();
    const stepEditor = page.getByTestId("step-editor");
    await expect(stepEditor).toBeVisible();
    await expect(stepEditor.getByLabel("Subject")).toBeVisible();
    await stepEditor.getByRole("button", { name: "Remove" }).click();
    await expect(
      page.getByText("Build your sequence", { exact: true }),
    ).toBeVisible();

    await gotoRoute(page, "/app/sequences/new/welcome-warm");
    await page.getByRole("button", { name: /Continue/ }).click();
    const audience = page.getByLabel("Audience");
    await expect(audience).toBeFocused();
    await audience.fill("Independent software teams");
    await page.getByLabel("Promise").fill("A useful onboarding sequence");
    await page.getByRole("button", { name: /Continue/ }).click();
    await expect(
      page.getByText("Style controls", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Continue/ }).click();
    await expect(
      page.getByText("Voice profile", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByText("Style controls", { exact: true }),
    ).toBeVisible();

    await gotoRoute(page, "/app/sequences/seq-welcome-sample");
    const abTrigger = page.getByRole("button", {
      name: "Preview A/B variants",
    });
    await abTrigger.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(abTrigger).toBeFocused();
    const sendTest = page.getByRole("button", { name: "Send test email" });
    await sendTest.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    for (const tabName of [
      "Blocks mode (MJML drag and drop)",
      "Cross-client preview",
      "Writer mode (Markdown)",
    ]) {
      const tab = page.getByRole("tab", { name: tabName });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }

    await gotoRoute(page, "/app/landing-pages");
    await page.getByRole("button", { name: "New page" }).click();
    await page.getByLabel("Name", { exact: true }).fill("   ");
    await page.getByLabel("Slug").fill("   ");
    await page.getByRole("button", { name: "Create page" }).click();
    await expect(page.getByText("Enter a name for this page.")).toBeVisible();
    await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
    await page
      .getByRole("button", { name: "Cancel", exact: true })
      .last()
      .click();

    await gotoRoute(page, `/app/landing-pages/${landingPageId}`);
    for (const tabName of [
      "SEO",
      "Settings",
      "Preview",
      "A/B variants",
      "History",
      "Content",
    ]) {
      const tab = page.getByRole("tab", { name: tabName });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      const mainScrollable = await page
        .locator("main#main-content")
        .evaluate((main) => {
          const before = main.scrollLeft;
          main.scrollLeft = 10_000;
          const scrolled = main.scrollLeft > 1;
          main.scrollLeft = before;
          return scrolled;
        });
      expect.soft(mainScrollable, `${tabName} tab overflow`).toBe(false);
    }
    const archive = page.getByRole("button", { name: "Archive" });
    await archive.click();
    await expectDialogQuality(page);
    await page.getByRole("button", { name: "Cancel" }).click();

    await gotoRoute(page, "/app/sequences/voice-profile");
    const addSource = page
      .getByRole("button", { name: "Add source", exact: true })
      .first();
    await addSource.click();
    await expectDialogQuality(page);
    const newsletter = page.getByRole("radio", { name: "Newsletter archive" });
    await newsletter.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("radio", { name: "Twitter / X" }),
    ).toBeChecked();
    await page.getByRole("radio", { name: "Paste-in" }).click();
    await page
      .getByLabel("Paste your writing")
      .fill("A representative writing sample.");
    await expect(
      page.getByRole("button", { name: "Add source", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");

    await gotoRoute(page, "/app/ai-assist");
    const brief = page.getByLabel("What is the email about?");
    await brief.fill("");
    await expect(
      page.getByRole("button", { name: "Draft a broadcast" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Anomaly brief" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Anomaly brief" }).click();
    await expect(
      page.getByRole("button", { name: "Anomaly brief" }),
    ).toBeEnabled({
      timeout: 30_000,
    });
    await expect(
      page.locator('[aria-labelledby="ai-log"] li').first(),
    ).toBeVisible();

    await gotoRoute(page, "/app/translations");
    await page.getByRole("button", { name: "Preview in French" }).click();
    await expect(
      page.getByRole("button", { name: "Preview in French" }),
    ).toBeEnabled({
      timeout: 30_000,
    });
    await expect(
      page
        .locator('[aria-label="Translation preview"], [role="status"]')
        .last(),
    ).toBeVisible();

    await gotoRoute(page, "/app/voice-labels");
    const coverage = page.getByRole("button", { name: "Coverage" });
    await coverage.click();
    await expect(coverage).toHaveAttribute("aria-expanded", "true");
    const humorFilter = page.getByRole("button", { name: "humor" });
    await humorFilter.click();
    await expect(humorFilter).toHaveAttribute("aria-pressed", "true");
    await page
      .getByLabel("Sample text")
      .fill("A concise, representative sample.");
    await expect(
      page.getByRole("button", { name: "Save label" }),
    ).toBeEnabled();

    expect(pageErrors).toEqual([]);
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: dynamic editors and detail routes remain contained and accessible`, async ({
      page,
    }) => {
      const expectsMobileProject = viewport.label !== "desktop";
      test.skip(
        (test.info().project.name === "chromium-mobile") !==
          expectsMobileProject,
        "Desktop runs in Desktop Chrome; narrow/touch matrices run in mobile Chromium.",
      );
      test.slow();
      test.setTimeout(420_000);
      await page.setViewportSize(viewport);
      const { flowId, landingPageId } = await ensureDynamicFixtures(page);
      const routes = [
        `/app/flows/${flowId}`,
        "/app/sequences/seq-welcome-sample",
        "/app/sequence-templates/welcome-warm",
        "/app/sequence-templates/new?from=welcome-warm",
        "/app/sequences/new/welcome-warm",
        `/app/landing-pages/${landingPageId}`,
        `/app/landing-pages/${landingPageId}/submissions`,
      ];

      for (const route of routes) {
        const pageErrors: string[] = [];
        const onPageError = (error: Error) => pageErrors.push(error.message);
        page.on("pageerror", onPageError);
        await page.goto(route, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        });
        await waitForRoute(page);
        const result = await auditRoute(page);
        page.off("pageerror", onPageError);

        console.log(
          `CONTENT_AUTOMATION_DYNAMIC ${viewport.label} ${route} ${JSON.stringify(
            {
              ...result,
              pageErrors,
            },
          )}`,
        );

        expect.soft(result.layout.mainCount, `${route}: one main`).toBe(1);
        expect.soft(result.layout.h1Count, `${route}: one h1`).toBe(1);
        expect
          .soft(result.layout.documentOverflow, `${route}: document overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(result.layout.mainOverflow, `${route}: main overflow`)
          .toBeLessThanOrEqual(1);
        expect
          .soft(
            result.layout.mainHorizontallyScrollable,
            `${route}: shell main horizontal scrolling`,
          )
          .toBe(false);
        expect
          .soft(result.layout.viewportOverflow, `${route}: viewport overflow`)
          .toEqual([]);
        expect
          .soft(result.layout.undersized, `${route}: effective touch targets`)
          .toEqual([]);
        expect.soft(result.blocking, `${route}: axe`).toEqual([]);
        expect.soft(pageErrors, `${route}: page errors`).toEqual([]);
      }
    });
  }
});
