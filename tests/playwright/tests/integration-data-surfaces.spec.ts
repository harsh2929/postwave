import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const INBOUND_ID = "audit-endpoint";
const INBOUND_ENDPOINT = {
  id: INBOUND_ID,
  tenantId: "demo",
  slug: "quality-audit",
  name: "Quality audit endpoint",
  enabled: true,
  transform_jq: "",
  createdAt: "2026-08-25T12:00:00Z",
};

const ROUTES = [
  { path: "/app/integration-catalogue", heading: "Integration catalogue" },
  { path: "/app/integrations", heading: "Integrations" },
  { path: "/app/integrations/catalog", heading: "Integration catalog" },
  {
    path: "/app/integrations/catalog/salesforce",
    heading: "Salesforce",
  },
  { path: "/app/developer-reference", heading: "Developer reference" },
  { path: "/app/api-usage", heading: "API usage" },
  { path: "/app/inbound-webhooks", heading: "Inbound webhooks" },
  {
    path: `/app/inbound-webhooks/${INBOUND_ID}`,
    heading: /^Triggers(?: · .+)?$/u,
    redirectedTo: `/app/inbound-webhooks/${INBOUND_ID}/triggers`,
  },
  {
    path: `/app/inbound-webhooks/${INBOUND_ID}/triggers`,
    heading: /^Triggers(?: · .+)?$/u,
  },
  { path: "/app/audience-destinations", heading: "Audience destinations" },
  { path: "/app/audience-syncs", heading: "Audience syncs" },
  { path: "/app/omnichannel", heading: "Omnichannel" },
  { path: "/app/warehouse", heading: "Data warehouse" },
] as const;

const BLOCKING_IMACTS = new Set(["critical", "serious"]);

async function fulfillJson(
  route: Route,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installInboundFixture(
  page: Page,
): Promise<{ createCalls: number }> {
  const state = { createCalls: 0 };
  await page.route("**/api/v1/inbound-webhooks**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/v1/inbound-webhooks") {
      await fulfillJson(route, { items: [INBOUND_ENDPOINT] });
      return;
    }
    if (request.method() === "POST" && path === "/api/v1/inbound-webhooks") {
      state.createCalls += 1;
      await fulfillJson(route, {
        endpoint: {
          ...INBOUND_ENDPOINT,
          id: "created-audit-endpoint",
          slug: "created-quality-audit",
          name: "Created quality endpoint",
        },
        secret: "pwsec_quality_audit_full_secret_value_123456789",
      });
      return;
    }
    if (
      request.method() === "GET" &&
      path === `/api/v1/inbound-webhooks/${INBOUND_ID}`
    ) {
      await fulfillJson(route, INBOUND_ENDPOINT);
      return;
    }
    if (
      request.method() === "GET" &&
      path === `/api/v1/inbound-webhooks/${INBOUND_ID}/triggers`
    ) {
      await fulfillJson(route, { items: [] });
      return;
    }
    await route.fallback();
  });
  return state;
}

async function installAudienceFixture(page: Page): Promise<{
  runs: number;
  receipts: number;
}> {
  const calls = { runs: 0, receipts: 0 };
  await page.route("**/api/v1/audience-syncs**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/audience-syncs") {
      await fulfillJson(route, {
        items: [
          {
            id: "sync-audit",
            name: "Quality audience",
            destination: "Meta Ads",
            status: "active",
            last_run_at: "2026-08-25T12:00:00Z",
          },
        ],
      });
      return;
    }
    if (path === "/api/v1/audience-syncs/sync-audit/runs") {
      calls.runs += 1;
      await fulfillJson(route, {
        items: [
          {
            id: "run-audit",
            status: "success",
            started_at: "2026-08-25T12:00:00Z",
            matched: 142,
            excluded: 7,
          },
        ],
      });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/audience-sync-runs/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/run-audit/exclusion-receipt")) {
      calls.receipts += 1;
      await fulfillJson(route, {
        run_id: "run-audit",
        excluded: [{ member_id: "member-audit", reason: "suppressed" }],
      });
      return;
    }
    await route.fallback();
  });
  return calls;
}

async function installCatalogueFixture(page: Page): Promise<void> {
  const paths = new Set([
    "/api/v1/lead-integrations/providers",
    "/api/v1/support-integrations/providers",
    "/api/v1/subscription-integrations/providers",
    "/api/v1/loyalty-integrations/providers",
    "/api/v1/review-integrations/providers",
  ]);
  await page.route("**/api/v1/*-integrations/providers", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!paths.has(path)) {
      await route.fallback();
      return;
    }
    await fulfillJson(route, {
      items: [
        {
          provider: `qa-${path.split("/")[3]}`,
          name: "Acme QA Provider",
          category: "quality_assurance",
          runtime_status: "partial",
          auth_mode: "api_key_ref",
        },
      ],
    });
  });
}

async function waitForRoute(
  page: Page,
  heading: string | RegExp,
  path: string,
): Promise<void> {
  const routeRoot = page.locator('#main-content [data-slot="page-transition"]');
  await expect(page.locator("main#main-content")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(
    routeRoot.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        routeRoot.evaluate((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactFiber$")),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);

  // The kitchen-sink integrations route defers lower panels until they approach
  // the viewport. Scroll through them so the route certification covers those
  // panels, not only their placeholders.
  if (path === "/app/integrations") {
    for (const selector of [
      "#crm",
      "#two-way-sync",
      "#conversion-keys",
      "#multi-channel",
      "#platform-ops",
    ]) {
      const section = page.locator(selector);
      await section.scrollIntoViewIfNeeded();
      // Give this panel's IntersectionObserver a frame before moving to the
      // next distant anchor; jumping through every section in one task can
      // leave all but the final observer without an intersection callback.
      await expect(section.locator('[aria-busy="true"]')).toHaveCount(0, {
        timeout: 60_000,
      });
    }
    await page.locator("h1").scrollIntoViewIfNeeded();
  }

  await expect(
    routeRoot.locator('[role="status"][aria-label^="Loading"]'),
  ).toHaveCount(0, { timeout: 60_000 });
  await routeRoot.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function auditRoute(page: Page, path: string, mobile: boolean) {
  const routeRoot = page.locator('#main-content [data-slot="page-transition"]');
  const layout = await routeRoot.evaluate((root, requireTouchTargets) => {
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
    const ids = Array.from(root.querySelectorAll<HTMLElement>("[id]")).map(
      (element) => element.id,
    );
    const undersized = requireTouchTargets
      ? Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="tab"]:not([aria-disabled="true"])',
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
    const overflowing = Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter(visible)
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < -1 ||
          rect.right > window.innerWidth + 1 ||
          element.scrollWidth - element.clientWidth > 1
        );
      })
      .slice(0, 16)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          label:
            element.getAttribute("aria-label") ??
            element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 80),
          className: element.className,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: getComputedStyle(element).overflowX,
        };
      });
    let mainScrollsHorizontally = false;
    if (main) {
      const previous = main.scrollLeft;
      main.scrollLeft = 10_000;
      mainScrollsHorizontally = main.scrollLeft > 1;
      main.scrollLeft = previous;
    }
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: root.querySelectorAll("h1").length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      documentOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      mainScrollsHorizontally,
      overflowing,
      undersized,
    };
  }, mobile);

  const axe = await new AxeBuilder({ page })
    .include('#main-content [data-slot="page-transition"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMACTS.has(violation.impact),
  );

  expect.soft(layout.mainCount, `${path}: one main`).toBe(1);
  expect.soft(layout.h1Count, `${path}: one h1`).toBe(1);
  expect.soft(layout.duplicateIds, `${path}: duplicate IDs`).toEqual([]);
  expect
    .soft(layout.documentOverflow, `${path}: document overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(
      layout.mainOverflow,
      `${path}: main overflow ${JSON.stringify(layout.overflowing)}`,
    )
    .toBeLessThanOrEqual(1);
  expect
    .soft(layout.mainScrollsHorizontally, `${path}: horizontal main scroller`)
    .toBe(false);
  expect.soft(layout.undersized, `${path}: mobile touch targets`).toEqual([]);
  expect
    .soft(blocking, `${path}: ${JSON.stringify(blocking, null, 2)}`)
    .toEqual([]);
}

async function goto(
  page: Page,
  path: string,
  heading: string | RegExp,
): Promise<void> {
  let status = 0;
  let navigationError: unknown;
  // The shared Next dev server can briefly dispose/recompile an entry while a
  // different workspace file changes. Retry the document itself, but keep the
  // final status assertion so a persistent missing route still fails loudly.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      status = response?.status() ?? 0;
      navigationError = undefined;
      if (status > 0 && status < 400) break;
    } catch (error) {
      navigationError = error;
    }
    if (attempt < 2) await page.waitForTimeout(300 * (attempt + 1));
  }
  expect(navigationError, `${path}: document navigation`).toBeUndefined();
  expect(status, `${path}: document response`).toBeLessThan(400);
  await waitForRoute(page, heading, path);
}

test.describe("integration and data surface quality", () => {
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

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: all 13 route patterns are responsive and accessible`, async ({
      page,
    }) => {
      test.slow();
      await page.setViewportSize(viewport);
      await installInboundFixture(page);

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedResponses: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          const source = message.location().url;
          consoleErrors.push(
            source ? `${message.text()} (${source})` : message.text(),
          );
        }
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400) {
          failedResponses.push(`${response.status()} ${response.url()}`);
        }
      });

      const routeFilter = process.env.POSTWAVE_E2E_ROUTE_FILTER;
      const routes = routeFilter
        ? ROUTES.filter((route) => route.path === routeFilter)
        : ROUTES;
      for (const route of routes) {
        consoleErrors.length = 0;
        pageErrors.length = 0;
        failedResponses.length = 0;
        await goto(page, route.path, route.heading);
        if ("redirectedTo" in route) {
          await expect(page).toHaveURL(
            new RegExp(`${route.redirectedTo}$`, "u"),
          );
        }
        await auditRoute(page, route.path, viewport.width === 320);
        expect.soft(pageErrors, `${route.path}: uncaught errors`).toEqual([]);
        expect
          .soft(
            consoleErrors,
            `${route.path}: console errors; failed responses: ${failedResponses.join(", ") || "none"}`,
          )
          .toEqual([]);
      }
    });
  }

  test("catalogue search shows no-match truth and recovers", async ({
    page,
  }) => {
    await installCatalogueFixture(page);
    await goto(page, "/app/integration-catalogue", "Integration catalogue");
    const search = page.getByLabel("Search provider catalogue");
    await search.fill("provider-that-does-not-exist");
    await expect(page.getByText(/providers match/u)).toHaveCount(5);
    await search.fill("Acme QA Provider");
    await expect(page.getByText(/providers match/u)).toHaveCount(0);
    await expect(page.getByText("Acme QA Provider")).toHaveCount(5);
  });

  test("messaging provider tabs support arrows and reset provider-local forms", async ({
    page,
  }) => {
    for (const provider of ["slack", "discord", "teams"]) {
      await page.route(`**/api/v1/integrations/${provider}`, async (route) => {
        if (route.request().method() === "GET") {
          await fulfillJson(route, []);
          return;
        }
        await route.fallback();
      });
    }
    await goto(page, "/app/integrations", "Integrations");
    const slack = page.getByRole("tab", { name: "Slack", exact: true });
    const discord = page.getByRole("tab", { name: "Discord", exact: true });
    await page.getByRole("button", { name: "New Slack integration" }).click();
    await page.getByLabel("Channel hint (optional)").fill("#quality");
    await slack.focus();
    await page.keyboard.press("ArrowRight");
    await expect(discord).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("button", { name: "New Discord integration" }),
    ).toBeVisible();
    await slack.click();
    await expect(page.getByLabel("Channel hint (optional)")).toHaveCount(0);
  });

  test("inbound endpoint creation exposes native required-field feedback", async ({
    page,
  }) => {
    const fixture = await installInboundFixture(page);
    await goto(page, "/app/inbound-webhooks", "Inbound webhooks");
    await page.getByRole("button", { name: "Create endpoint" }).click();
    const name = page.getByLabel("Name", { exact: true });
    expect(
      await name.evaluate(
        (element: HTMLInputElement) => element.validity.valueMissing,
      ),
    ).toBe(true);
    expect(fixture.createCalls).toBe(0);
  });

  test("new inbound secrets stay complete and disclose signing guidance", async ({
    page,
  }) => {
    await installInboundFixture(page);
    await goto(page, "/app/inbound-webhooks", "Inbound webhooks");
    await page
      .getByLabel("Name", { exact: true })
      .fill("Created quality endpoint");
    await page.getByRole("button", { name: "Create endpoint" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Signing secret for “Created quality endpoint”",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("pwsec_quality_audit_full_secret_value_123456789"),
    ).toBeVisible();
    const help = page.getByRole("button", { name: "How to sign requests" });
    await help.click();
    await expect(help).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByText("X-Postwave-Timestamp", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(
      page.getByText("pwsec_quality_audit_full_secret_value_123456789"),
    ).toHaveCount(0);
  });

  test("trigger tester reports matches, resolved email, and invalid JSON", async ({
    page,
  }) => {
    await installInboundFixture(page);
    await goto(
      page,
      `/app/inbound-webhooks/${INBOUND_ID}/triggers`,
      /^Triggers(?: · .+)?$/u,
    );
    await page.getByLabel("Match value").fill("user.created");
    await page
      .getByRole("button", { name: "Test against a sample payload" })
      .click();
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByText("✓ Rule matches")).toBeVisible();
    await expect(
      page.getByText(/Resolved email: person@example.com/u),
    ).toBeVisible();
    await page.getByLabel("Sample payload (JSON)").fill("{");
    await page.getByRole("button", { name: "Run test" }).click();
    await expect(page.getByText(/Invalid JSON:/u)).toBeVisible();
  });

  test("audience run history and receipt load only after click disclosure", async ({
    page,
  }) => {
    const calls = await installAudienceFixture(page);
    await goto(page, "/app/audience-syncs", "Audience syncs");
    expect(calls.runs).toBe(0);
    expect(calls.receipts).toBe(0);
    await page.getByRole("button", { name: /Quality audience/u }).click();
    await expect(page.getByText("142 matched", { exact: false })).toBeVisible();
    expect(calls.runs).toBe(1);
    expect(calls.receipts).toBe(0);
    await page.getByRole("button", { name: "View receipt" }).click();
    await expect(page.getByText(/"reason": "suppressed"/u)).toBeVisible();
    expect(calls.receipts).toBe(1);
  });

  test("audience disclosure is keyboard operable and reports expanded state", async ({
    page,
  }) => {
    await installAudienceFixture(page);
    await goto(page, "/app/audience-syncs", "Audience syncs");
    const disclosure = page.getByRole("button", { name: /Quality audience/u });
    await disclosure.focus();
    await page.keyboard.press("Space");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("heading", { name: "Recent runs" }),
    ).toBeVisible();
    await page.keyboard.press("Space");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });

  test("warehouse failure remains distinct from empty and retry restores data", async ({
    page,
  }) => {
    test.slow();
    let failing = true;
    await page.route("**/api/v1/warehouse/connections", async (route) => {
      if (failing) {
        await fulfillJson(route, { error: "quality outage" }, 503);
        return;
      }
      await fulfillJson(route, {
        items: [
          {
            id: "warehouse-audit",
            provider: "snowflake",
            name: "QA Snowflake",
            status: "connected",
            direction: "outbound",
            cadence: "hourly",
          },
        ],
      });
    });
    await goto(page, "/app/warehouse", "Data warehouse");
    const connections = page.getByRole("region", { name: "Connections" });
    await expect(
      connections.getByText("Warehouse connections could not be loaded"),
    ).toBeVisible({ timeout: 30_000 });
    await expect(connections.getByText("No warehouse connected")).toHaveCount(
      0,
    );
    failing = false;
    await connections.getByRole("button", { name: "Try again" }).click();
    await expect(connections.getByText("QA Snowflake")).toBeVisible();
    await expect(connections.getByText("1 connected")).toBeVisible();
  });
});
