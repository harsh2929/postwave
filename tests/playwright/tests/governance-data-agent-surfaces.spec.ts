import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const ROUTES = [
  ["/app/compliance", "Compliance programmes"],
  ["/app/compliance-requests", "Requests and reports"],
  ["/app/consent-evidence", "Consent evidence"],
  ["/app/consent-ledger", "Consent ledger"],
  ["/app/data-controls", "Data controls"],
  ["/app/privacy-portal", "Privacy portal"],
  ["/app/encryption-keys", "Encryption keys"],
  ["/app/key-hygiene", "Credential hygiene"],
  ["/app/data-hygiene", "Data hygiene"],
  ["/app/data-operations", "Data operations"],
  ["/app/source-quality", "Source quality"],
  ["/app/custom-objects", "Custom objects"],
  ["/app/agent-routines", "Agent routines"],
  ["/app/agent-tools", "Agent tools"],
  ["/app/track", "Product events"],
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function gotoRoute(page: Page, path: string, heading: string) {
  let responseStatus = 0;
  let navigationError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      responseStatus = response?.status() ?? 0;
      navigationError = undefined;
      if (responseStatus > 0 && responseStatus < 400) break;
    } catch (error) {
      navigationError = error;
    }
    if (attempt < 2) await page.waitForTimeout(300 * (attempt + 1));
  }
  expect(navigationError, `${path}: document navigation`).toBeUndefined();
  expect(responseStatus, `${path}: document response`).toBeLessThan(400);

  const root = page.locator('#main-content [data-slot="page-transition"]');
  await expect(page.locator("main#main-content")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    root.getByRole("heading", { level: 1, name: heading, exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveTitle(
    new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
  // The dashboard shell exposes its hydration contract explicitly. Do not
  // couple browser coverage to React's private property names.
  await expect(page.locator('[data-dashboard-hydrated="true"]')).toHaveCount(
    1,
    { timeout: 60_000 },
  );
  await expect(root.locator('[class*="animate-pw-shimmer"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(root.locator('[aria-busy="true"]')).toHaveCount(0, {
    timeout: 60_000,
  });
  await root.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function auditRoute(page: Page, path: string, mobile: boolean) {
  const root = page.locator('#main-content [data-slot="page-transition"]');
  const layout = await root.evaluate((routeRoot, requireTouchTargets) => {
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
    const ids = Array.from(routeRoot.querySelectorAll<HTMLElement>("[id]")).map(
      (element) => element.id,
    );
    const undersized = requireTouchTargets
      ? Array.from(
          routeRoot.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [role="button"]:not([aria-disabled="true"]), [role="tab"]:not([aria-disabled="true"])',
          ),
        )
          .filter(visible)
          .map((element) => {
            const hitTarget =
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type)
                ? (element.closest<HTMLElement>("label") ?? element)
                : element;
            const rect = hitTarget.getBoundingClientRect();
            return {
              label:
                element.getAttribute("aria-label") ??
                element.textContent
                  ?.trim()
                  .replace(/\s+/gu, " ")
                  .slice(0, 70) ??
                element.tagName,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          })
          .filter(({ width, height }) => width < 43.5 || height < 43.5)
      : [];
    const main = document.querySelector<HTMLElement>("main#main-content");
    let mainScrollsHorizontally = false;
    if (main) {
      const previous = main.scrollLeft;
      main.scrollLeft = 10_000;
      mainScrollsHorizontally = main.scrollLeft > 1;
      main.scrollLeft = previous;
    }
    const clipped = Array.from(routeRoot.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.left >= -1 && rect.right <= window.innerWidth + 1)
          return false;
        let parent = element.parentElement;
        while (parent && parent !== routeRoot) {
          if (
            ["auto", "scroll", "hidden", "clip"].includes(
              getComputedStyle(parent).overflowX,
            )
          ) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .slice(0, 10)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 60),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: routeRoot.querySelectorAll("h1").length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      documentOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      mainScrollsHorizontally,
      clipped,
      undersized,
    };
  }, mobile);

  const axe = await new AxeBuilder({ page })
    .include('#main-content [data-slot="page-transition"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );

  expect.soft(layout.mainCount, `${path}: one main`).toBe(1);
  expect.soft(layout.h1Count, `${path}: one h1`).toBe(1);
  expect.soft(layout.duplicateIds, `${path}: duplicate ids`).toEqual([]);
  expect
    .soft(layout.documentOverflow, `${path}: document overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(layout.mainOverflow, `${path}: main overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(layout.mainScrollsHorizontally, `${path}: main horizontal scrolling`)
    .toBe(false);
  expect.soft(layout.clipped, `${path}: clipped viewport content`).toEqual([]);
  expect.soft(layout.undersized, `${path}: mobile touch targets`).toEqual([]);
  expect
    .soft(blocking, `${path}: ${JSON.stringify(blocking, null, 2)}`)
    .toEqual([]);
}

async function expectDialogQuality(page: Page) {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate(async (element) => {
    const finiteAnimations = element
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const iterations = animation.effect?.getTiming().iterations;
        return typeof iterations === "number" && Number.isFinite(iterations);
      });
    await Promise.all(
      finiteAnimations.map((animation) =>
        animation.finished.catch(() => undefined),
      ),
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
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  const axe = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    axe.violations.filter(
      (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
    ),
  ).toEqual([]);
}

test.describe("governance, data, and agent surface quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
  });

  // The Playwright projects already represent desktop and exact 320px. Keep a
  // single test so each route matrix runs once per intended project, not a 2×2
  // project/viewport cross-product.
  test("all 15 routes are responsive and accessible at the project viewport", async ({
    page,
  }, testInfo) => {
    test.slow();
    test.setTimeout(480_000);
    const mobile = testInfo.project.name.includes("mobile");
    await page.setViewportSize(
      mobile ? { width: 320, height: 800 } : { width: 1280, height: 900 },
    );

    for (const [path, heading] of ROUTES) {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const onConsole = (message: { type(): string; text(): string }) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      };
      const onPageError = (error: Error) => pageErrors.push(error.message);
      page.on("console", onConsole);
      page.on("pageerror", onPageError);

      await gotoRoute(page, path, heading);
      await auditRoute(page, path, mobile);

      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      const javascriptErrors = consoleErrors.filter(
        (message) => !message.includes("Failed to load resource"),
      );
      expect.soft(pageErrors, `${path}: uncaught page errors`).toEqual([]);
      expect.soft(javascriptErrors, `${path}: app console errors`).toEqual([]);
    }
  });

  test("data operations validates, deduplicates, confirms, and logs outcomes", async ({
    page,
  }) => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    await page.route(
      "**/api/v1/{utm-templates,inbound-routes}/preview",
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = (route.request().postDataJSON() ?? {}) as Record<
          string,
          unknown
        >;
        calls.push({ path, body });
        if (path === "/api/v1/utm-templates/preview") {
          const original = String(body.url ?? "");
          await fulfillJson(route, {
            original,
            rewritten: `${original}?utm_source=postwave`,
            template: { enabled: true, created_at: "2026-08-01T00:00:00Z" },
          });
          return;
        }
        await fulfillJson(route, {
          matches: [],
          evaluated: 0,
          no_matches: true,
        });
      },
    );
    for (const path of [
      "/api/v1/verification/verify-batch",
      "/api/v1/tag-taxonomy/merge",
      "/api/v1/audit-sinks/test",
    ]) {
      await page.route(`**${path}`, async (route) => {
        calls.push({
          path,
          body: (route.request().postDataJSON() ?? {}) as Record<
            string,
            unknown
          >,
        });
        await fulfillJson(route, {});
      });
    }

    await gotoRoute(page, "/app/data-operations", "Data operations");
    const url = page.getByLabel("URL", { exact: true });
    await url.fill("ftp://example.test/file");
    await page.getByRole("button", { name: "Preview rewrite" }).click();
    await expect(
      page.getByText(/complete http:\/\/ or https:\/\/ URL/u),
    ).toBeVisible();
    expect(calls).toHaveLength(0);

    await url.fill("https://example.test/pricing");
    await page.getByRole("button", { name: "Preview rewrite" }).click();
    await expect(page.getByText(/utm_source=postwave/u)).toBeVisible();

    await page
      .getByLabel("Email addresses")
      .fill("Alex@example.com, alex@example.com\nsam@example.com");
    await page.getByRole("button", { name: "Verify batch" }).click();
    await expect(page.getByText(/1 duplicate was removed/u)).toBeVisible();
    expect(
      calls.find((call) => call.path.endsWith("verify-batch"))?.body,
    ).toEqual({ emails: ["Alex@example.com", "sam@example.com"] });

    await page.getByLabel("Existing tag").fill("legacy");
    await page.getByLabel("New tag / merge destination").fill("legacy");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(page.getByText(/must be different/u)).toBeVisible();
    await page.getByLabel("New tag / merge destination").fill("current");
    const merge = page.getByRole("button", { name: "Merge", exact: true });
    await merge.click();
    await expectDialogQuality(page);
    await page.keyboard.press("Escape");
    await expect(merge).toBeFocused();
    await merge.click();
    await page.getByRole("button", { name: "Confirm merge" }).click();
    await expect(
      page.getByText("Merged “legacy” into “current”."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Clear results" }).click();
    await expect(
      page.getByText("Nothing run yet in this session."),
    ).toBeVisible();
  });

  test("agent-tool and event searches recover from no-match states", async ({
    page,
  }) => {
    await page.route("**/api/v1/mcp/catalog", (route) =>
      fulfillJson(route, [
        {
          name: "segments.create_from_rules",
          category: "audience-management",
          description: "Create a segment from subscriber rules.",
        },
        {
          name: "campaigns.preview",
          category: "campaign-delivery",
          description: "Preview a campaign without sending.",
        },
      ]),
    );
    await gotoRoute(page, "/app/agent-tools", "Agent tools");
    const toolSearch = page.getByLabel("Search agent tools");
    await toolSearch.fill("not-a-real-capability");
    await expect(page.getByText(/No tools match/u)).toBeVisible();
    await toolSearch.fill("subscriber rules");
    await expect(page.getByText("segments.create_from_rules")).toBeVisible();
    await expect(page.getByText("campaigns.preview")).toHaveCount(0);

    await page.route("**/api/v1/track/catalog", (route) =>
      fulfillJson(route, {
        items: [
          { name: "pricing_page_viewed", count: 7 },
          { name: "checkout_started", count: 3 },
        ],
        totalDistinctEventNames: 2,
        periodDays: 30,
        timeZone: "UTC",
      }),
    );
    await gotoRoute(page, "/app/track", "Product events");
    const eventSearch = page.getByLabel("Search event names");
    await eventSearch.fill("not-a-real-event");
    await expect(page.getByText(/No event names match/u)).toBeVisible();
    await eventSearch.fill("checkout");
    await expect(page.getByText("checkout_started")).toBeVisible();
    await expect(page.getByText("pricing_page_viewed")).toHaveCount(0);
  });

  test("privacy failure is not a clean claim and retry recovers", async ({
    page,
  }) => {
    let calls = 0;
    let shouldFail = true;
    await page.route("**/api/v1/privacy/portal", async (route) => {
      if (
        new URL(route.request().url()).pathname !== "/api/v1/privacy/portal"
      ) {
        await route.fallback();
        return;
      }
      calls += 1;
      if (shouldFail) {
        await fulfillJson(
          route,
          { error: { code: "bad_request", message: "Unavailable" } },
          400,
        );
        return;
      }
      await fulfillJson(route, {
        regions: [],
        dsar_requests: [],
        suppression_breakdown: [],
        consent_proof_summary: [],
        gpc_signaled_count: 0,
        do_not_sell_count: 0,
        double_optin_pending: 0,
        generated_at: "2026-08-26T10:00:00Z",
      });
    });
    await gotoRoute(page, "/app/privacy-portal", "Privacy portal");
    await expect(
      page.getByText(/Could not load the privacy portal/u),
    ).toBeVisible();
    await expect(page.getByText("No outstanding requests.")).toHaveCount(0);
    shouldFail = false;
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .first()
      .click();
    await expect(page.getByText("No outstanding requests.")).toBeVisible();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
