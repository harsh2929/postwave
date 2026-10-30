import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const HERO_TITLE =
  "Read the commercial record without inventing checkout truth.";
const SUMMER_ID = "d11ce001-1111-4111-8111-111111111111";
const FOUNDERS_ID = "b0b0f002-2222-4222-8222-222222222222";
const LEGACY_ID = "cafe0003-3333-4333-8333-333333333333";
const REVIEW_ID = "dead0004-4444-4444-8444-444444444444";
const archiveLabel = (id: string): string =>
  `Discount record ${id.slice(0, 8).toUpperCase()}`;
const SUMMER_LABEL = archiveLabel(SUMMER_ID);
const FOUNDERS_LABEL = archiveLabel(FOUNDERS_ID);
const LEGACY_LABEL = archiveLabel(LEGACY_ID);
const REVIEW_LABEL = archiveLabel(REVIEW_ID);

const POPULATED_ITEMS = [
  {
    id: SUMMER_ID,
    label: SUMMER_LABEL,
    percent_off: 20,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: 100,
    times_redeemed: 7,
    expires_at: "2030-08-31T23:59:59.000Z",
    applies_to: "recurring",
    created_at: "2026-07-24T09:30:00.000Z",
  },
  {
    id: FOUNDERS_ID,
    label: FOUNDERS_LABEL,
    percent_off: null,
    amount_off_cents: 2_500,
    currency: "USD",
    max_redemptions: 40,
    times_redeemed: 40,
    expires_at: "2030-12-31T23:59:59.000Z",
    applies_to: "both",
    created_at: "2026-07-20T12:00:00.000Z",
  },
  {
    id: LEGACY_ID,
    label: LEGACY_LABEL,
    percent_off: 15,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: null,
    times_redeemed: 22,
    expires_at: "2025-12-31T23:59:59.000Z",
    applies_to: "first_payment",
    created_at: "2026-07-12T08:00:00.000Z",
  },
  {
    id: REVIEW_ID,
    label: REVIEW_LABEL,
    percent_off: null,
    amount_off_cents: null,
    currency: "USD",
    max_redemptions: 10,
    times_redeemed: 0,
    expires_at: null,
    applies_to: "unsupported_scope",
    created_at: "2026-07-08T08:00:00.000Z",
  },
] as const;

// The recent-event fixture intentionally contains no redemption code,
// subscriber id, email address, tenant id, or provider identifier.
const SANITIZED_RECENT_EVENTS = [
  {
    redeemed_at: "2026-07-25T10:15:00.000Z",
    subscriber_linked: true,
  },
  {
    redeemed_at: "2026-07-23T14:45:00.000Z",
    subscriber_linked: false,
  },
] as const;

type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface PlannedResponse {
  status: number;
  body: unknown;
}

interface RequestEvidence {
  method: string;
  pathname: string;
  search: string;
  body: string | null;
}

interface DiscountHarness {
  requests: RequestEvidence[];
  listCalls: number;
  eventCalls: number;
}

interface HarnessOptions {
  list?: readonly PlannedResponse[];
  events?: readonly PlannedResponse[];
}

const OK_LIST: PlannedResponse = {
  status: 200,
  body: { items: POPULATED_ITEMS },
};
const OK_EVENTS: PlannedResponse = {
  status: 200,
  body: { items: SANITIZED_RECENT_EVENTS },
};
const ARCHIVE_FAILURE: PlannedResponse = {
  status: 503,
  body: {
    error: {
      code: "archive_temporarily_unavailable",
      message: "The archive service is temporarily unavailable.",
    },
  },
};
const EVENT_FAILURE: PlannedResponse = {
  status: 503,
  body: {
    error: {
      code: "recent_events_temporarily_unavailable",
      message: "The recent-event service is temporarily unavailable.",
    },
  },
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function responseFor(
  plan: readonly PlannedResponse[],
  callIndex: number,
): PlannedResponse {
  return plan[Math.min(callIndex, plan.length - 1)]!;
}

async function installDiscountHarness(
  page: Page,
  options: HarnessOptions = {},
): Promise<DiscountHarness> {
  const listPlan = options.list?.length ? options.list : [OK_LIST];
  const eventPlan = options.events?.length ? options.events : [OK_EVENTS];
  const harness: DiscountHarness = {
    requests: [],
    listCalls: 0,
    eventCalls: 0,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/dashboard/layout" &&
      request.method() === "GET"
    ) {
      // The shell resolves this unrelated preference before Discounts is
      // selected. A complete valid order prevents a harness-only fallback
      // toast from contaminating visual evidence.
      await json(route, {
        userId: "visual-user",
        tenantId: "test-tenant",
        order: [
          "subs",
          "opens",
          "clicks",
          "bounces",
          "forecast",
          "anomalies",
          "goals",
          "benchmarks",
          "engagement",
          "parity",
          "inbox-health",
          "clv",
        ],
        updatedAt: "2026-07-27T12:00:00.000Z",
      });
      return;
    }
    const isDiscountSurface =
      url.pathname.startsWith("/api/v1/discounts") ||
      url.pathname.startsWith("/api/v1/coupon-pools");

    if (isDiscountSurface) {
      harness.requests.push({
        method: request.method(),
        pathname: url.pathname,
        search: url.search,
        body: request.postData(),
      });
    }

    if (url.pathname === "/api/v1/discounts") {
      const callIndex = harness.listCalls;
      harness.listCalls += 1;
      if (request.method() !== "GET") {
        await json(
          route,
          {
            error: {
              code: "test_contract_violation",
              message: "The qualification harness permits archive reads only.",
            },
          },
          405,
        );
        return;
      }
      const planned = responseFor(listPlan, callIndex);
      await json(route, planned.body, planned.status);
      return;
    }

    if (/^\/api\/v1\/discounts\/[^/]+\/redemptions$/u.test(url.pathname)) {
      const callIndex = harness.eventCalls;
      harness.eventCalls += 1;
      if (request.method() !== "GET") {
        await json(
          route,
          {
            error: {
              code: "test_contract_violation",
              message: "The qualification harness permits archive reads only.",
            },
          },
          405,
        );
        return;
      }
      const planned = responseFor(eventPlan, callIndex);
      await json(route, planned.body, planned.status);
      return;
    }

    if (url.pathname.startsWith("/api/v1/discounts")) {
      await json(
        route,
        {
          error: {
            code: "test_contract_violation",
            message:
              "This Discounts endpoint is outside the read-only contract.",
          },
        },
        405,
      );
      return;
    }

    await route.fallback();
  });

  return harness;
}

async function openDiscountHistory(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: HarnessOptions & {
    theme?: Theme;
    width?: number;
    height?: number;
  } = {},
): Promise<DiscountHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date("2026-07-27T12:00:00.000Z"));
  await bootApp(page);
  const harness = await installDiscountHarness(page, options);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="discounts"]');
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: HERO_TITLE, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".dhs-page")).toBeVisible();
  return harness;
}

function observeRenderer(
  page: Page,
  allowedHttpStatuses: readonly number[] = [],
): { expectClean: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  return {
    expectClean: () => {
      const unexpected = consoleErrors.filter(
        (message) =>
          !allowedHttpStatuses.some((status) =>
            message.includes(`status of ${status}`),
          ),
      );
      expect(unexpected).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ disableColorContrast }) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Element,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
            },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const root = document.querySelector(".dhs-page");
    if (!root) throw new Error("Discount history root was not rendered.");
    const result = await axe.run(root, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      )
      .map((violation) => ({
        id: violation.id,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  }, options);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".dhs-page");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      route: route ? route.scrollWidth - route.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
}

async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main");
    const content = document.querySelector<HTMLElement>(".content");
    if (main) main.scrollTop = 0;
    if (content) content.scrollTop = 0;
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}

function expectReadOnlyContract(harness: DiscountHarness): void {
  expect(harness.listCalls).toBeGreaterThanOrEqual(1);
  expect(harness.requests.length).toBeGreaterThanOrEqual(1);
  expect(
    harness.requests.filter(
      ({ pathname }) =>
        pathname.includes("/check") ||
        pathname.endsWith(".csv") ||
        pathname.startsWith("/api/v1/coupon-pools"),
    ),
  ).toEqual([]);
  expect(harness.requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(harness.requests.filter(({ body }) => body !== null)).toEqual([]);

  for (const request of harness.requests) {
    if (request.pathname === "/api/v1/discounts") {
      expect(request.search).toBe("");
      continue;
    }
    expect(request.pathname).toMatch(
      /^\/api\/v1\/discounts\/[0-9a-f-]+\/redemptions$/u,
    );
    const params = new URLSearchParams(request.search);
    expect(params.get("limit")).toBe("12");
    expect(params.has("offset")).toBe(false);
    expect([...params.keys()]).toEqual(["limit"]);
  }
}

async function expectNoUnsupportedActions(page: Page): Promise<void> {
  const route = page.locator(".dhs-page");
  await expect(
    route.getByRole("button", {
      name: /^(?:Create|Edit|Redeem|Disable|Delete|Validate|Check|Export|Download)\b/iu,
    }),
  ).toHaveCount(0);
  await expect(
    route.getByRole("link", {
      name: /^(?:Create|Edit|Redeem|Disable|Delete|Validate|Check|Export|Download)\b/iu,
    }),
  ).toHaveCount(0);
  await expect(route.locator('a[href*=".csv"], a[download]')).toHaveCount(0);
  await expect(
    route.locator(
      'textarea, input[type="file"], input:not([type="search"]):not([type="hidden"])',
    ),
  ).toHaveCount(0);
}

async function inspectOrder(page: Page): Promise<string[]> {
  return page
    .getByRole("button", { name: /^Inspect /u })
    .evaluateAll((buttons) =>
      buttons.map((button) =>
        (button.getAttribute("aria-label") ?? "").replace(/^Inspect /u, ""),
      ),
    );
}

for (const theme of ["dark", "light"] as const) {
  test(`populated archive is truthful, contained, and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    const harness = await openDiscountHistory(page, bootApp, setTheme, {
      theme,
    });

    await expect(
      page.getByRole("list", { name: "Discount history records" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Inspect ${SUMMER_LABEL}` }),
    ).toBeVisible();
    await expect(
      page.locator('[aria-label="Current historical snapshot"]'),
    ).toContainText("4");
    await expect(
      page.getByText("Historical inspection is the complete route boundary.", {
        exact: true,
      }),
    ).toBeVisible();

    await expectNoUnsupportedActions(page);
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expectReadOnlyContract(harness);
    renderer.expectClean();
    await saveEvidence(page, testInfo, `discount-history-populated-${theme}`);
    await attachJson(testInfo, `discount-history-requests-${theme}`, {
      requests: harness.requests,
    });
  });
}

test("search, filters, sorts, private detail, backdrop, Escape, and focus restoration work without contract expansion", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openDiscountHistory(page, bootApp, setTheme);
  const search = page.getByRole("searchbox", {
    name: "Search discount records",
  });
  const sort = page.getByRole("combobox", { name: "Sort" });

  await expect(
    page.getByRole("list", { name: "Discount history records" }),
  ).toBeVisible();
  expect((await inspectOrder(page))[0]).toBe(SUMMER_LABEL);

  await sort.selectOption("label");
  await expect
    .poll(async () => (await inspectOrder(page))[0])
    .toBe(FOUNDERS_LABEL);
  await sort.selectOption("redemptions");
  await expect
    .poll(async () => (await inspectOrder(page))[0])
    .toBe(FOUNDERS_LABEL);

  await search.fill(FOUNDERS_LABEL.slice(-8));
  await expect(
    page.getByText("1 matching record", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Inspect ${FOUNDERS_LABEL}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Inspect ${SUMMER_LABEL}` }),
  ).toHaveCount(0);

  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("button", { name: `Inspect ${SUMMER_LABEL}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: /^Expired\b/u }).click();
  await expect(
    page.getByRole("button", { name: `Inspect ${LEGACY_LABEL}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Inspect ${FOUNDERS_LABEL}` }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^All records\b/u }).click();
  await sort.selectOption("newest");

  const opener = page.getByRole("button", {
    name: `Open details for ${SUMMER_LABEL}`,
  });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("dialog", { name: SUMMER_LABEL });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Subscriber-linked event")).toBeVisible();
  await expect(dialog.getByText("Unattributed event")).toBeVisible();
  await expect(
    dialog.getByText("Provider state", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Checkout result", { exact: true }),
  ).toBeVisible();
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);

  const detailText = await dialog.innerText();
  expect(detailText).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
  expect(detailText).not.toContain(SUMMER_ID);
  expect(detailText).not.toContain("subscriber_id");
  expect(detailText).not.toContain("subscriber_email");
  const routeText = await page.locator(".dhs-page").innerText();
  for (const id of [SUMMER_ID, FOUNDERS_ID, LEGACY_ID, REVIEW_ID]) {
    expect(routeText).not.toContain(id);
  }
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "discount-history-private-detail");

  await page.locator(".slideover-overlay").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Subscriber-linked event")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  expect(harness.listCalls).toBe(1);
  expect(harness.eventCalls).toBe(2);
  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-interactions");
  await attachJson(testInfo, "discount-history-interaction-requests", {
    requests: harness.requests,
  });
});

test("refresh failure retains the last readable snapshot", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    list: [OK_LIST, ARCHIVE_FAILURE],
  });

  await expect(
    page.getByRole("button", { name: `Inspect ${SUMMER_LABEL}` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh snapshot" }).click();
  const retained = page.locator('.dhs-retained-error[role="alert"]');
  await expect(retained).toContainText(
    "Refresh failed; the last readable snapshot remains.",
  );
  await expect(
    page.getByRole("button", { name: `Inspect ${SUMMER_LABEL}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Discount history records" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh snapshot" }),
  ).not.toHaveAttribute("aria-disabled");

  // The shared read transport retries a retryable 503 up to three wire
  // attempts. The retained snapshot must survive the whole retry budget.
  expect(harness.listCalls).toBe(4);
  await expectNoUnsupportedActions(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-retained-refresh-error");
});

test("a true empty archive is distinct from failure and offers no authoring action", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    theme: "light",
    list: [{ status: 200, body: { items: [] } }],
  });

  await expect(
    page.getByRole("heading", {
      name: "There are no discount records on file.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "The archive could not be read." }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Discount history records" }),
  ).toHaveCount(0);
  await expect(page.locator(".dhs-summary")).toHaveCount(0);
  await expect(
    page.getByRole("searchbox", { name: "Search discount records" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh snapshot" }),
  ).toBeVisible();

  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-true-empty");
});

test("an initial list failure renders a terminal retry state, never a false empty state", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    list: [ARCHIVE_FAILURE],
  });

  await expect(
    page.getByRole("heading", {
      name: "The archive could not be read.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry snapshot" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "There are no discount records on file.",
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Discount records" }),
  ).toHaveCount(0);
  expect(harness.listCalls).toBe(3);

  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-terminal-list-error");
});

test("detail failure is partial, keeps stored evidence visible, and recovers with the same sanitized GET", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    // Exhaust the transport's three wire attempts so the drawer exposes its
    // partial-error state. The user-owned Retry then receives the success.
    events: [EVENT_FAILURE, EVENT_FAILURE, EVENT_FAILURE, OK_EVENTS],
  });
  const opener = page.getByRole("button", {
    name: `Open details for ${SUMMER_LABEL}`,
  });

  await opener.click();
  const dialog = page.getByRole("dialog", { name: SUMMER_LABEL });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("alert").getByText("Recent events unavailable."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "What this row says" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Counter position" }),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "discount-history-partial-detail-error");

  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("Subscriber-linked event")).toBeVisible();
  await expect(dialog.getByText("Unattributed event")).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(harness.eventCalls).toBe(4);

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("1440, 1024, 700, and 400 pixel layouts reflow without root or route overflow", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    theme: "light",
    width: 1_440,
    height: 900,
  });
  await expect(
    page.getByRole("list", { name: "Discount history records" }),
  ).toBeVisible();

  const evidence: Array<Record<string, unknown>> = [];
  for (const size of [
    { width: 1_440, height: 900 },
    { width: 1_024, height: 900 },
    { width: 700, height: 900 },
    { width: 400, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator(".dhs-page")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const layout = await page.evaluate(() => {
      const listHead = document.querySelector<HTMLElement>(".dhs-list-head");
      const records = Array.from(
        document.querySelectorAll<HTMLElement>(".dhs-record"),
      );
      const recordGrid = document.querySelector<HTMLElement>(".dhs-records");
      const summary = document.querySelector<HTMLElement>(".dhs-summary");
      const filters = document.querySelector<HTMLElement>(".dhs-filter-group");
      const first = records[0]?.getBoundingClientRect();
      const second = records[1]?.getBoundingClientRect();
      const columnCount = (node: HTMLElement | null): number => {
        if (!node) return 0;
        const columns = getComputedStyle(node).gridTemplateColumns;
        return columns === "none" ? 0 : columns.trim().split(/\s+/u).length;
      };
      return {
        viewport: window.innerWidth,
        listHeadVisible: Boolean(
          listHead && getComputedStyle(listHead).display !== "none",
        ),
        recordsDisplay: recordGrid
          ? getComputedStyle(recordGrid).display
          : "missing",
        recordsShareRow: Boolean(
          first && second && Math.abs(first.top - second.top) <= 2,
        ),
        summaryColumns: columnCount(summary),
        filterColumns: columnCount(filters),
      };
    });
    evidence.push(layout);

    if (size.width === 1_440) {
      expect(layout.listHeadVisible).toBe(true);
      expect(layout.recordsShareRow).toBe(false);
    } else if (size.width === 1_024) {
      expect(layout.listHeadVisible).toBe(false);
      expect(layout.recordsDisplay).toBe("grid");
      expect(layout.recordsShareRow).toBe(true);
    } else {
      expect(layout.listHeadVisible).toBe(false);
      expect(layout.recordsShareRow).toBe(false);
    }
    if (size.width === 400) {
      expect(layout.summaryColumns).toBe(1);
      expect(layout.filterColumns).toBe(2);
    }

    await saveEvidence(
      page,
      testInfo,
      `discount-history-responsive-${size.width}`,
    );
  }

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await attachJson(
    testInfo,
    "discount-history-responsive-measurements",
    evidence,
  );
});

test("reduced motion removes the archive signal and interactive transitions", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const renderer = observeRenderer(page);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    width: 700,
    height: 900,
  });
  await expect(
    page.getByRole("list", { name: "Discount history records" }),
  ).toBeVisible();

  const motion = await page.evaluate(() => {
    const signal = document.querySelector<HTMLElement>(
      ".dhs-flow-connector.is-recorded > span",
    );
    const record = document.querySelector<HTMLElement>(".dhs-record");
    const search = document.querySelector<HTMLElement>(".dhs-search");
    const maxDurationMs = (value: string): number =>
      Math.max(
        ...value.split(",").map((duration) => {
          const normalized = duration.trim();
          return normalized.endsWith("ms")
            ? Number.parseFloat(normalized)
            : Number.parseFloat(normalized) * 1_000;
        }),
      );
    return {
      mediaMatches: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      signalAnimation: signal ? getComputedStyle(signal).animationName : null,
      recordTransitionMs: record
        ? maxDurationMs(getComputedStyle(record).transitionDuration)
        : null,
      searchTransitionMs: search
        ? maxDurationMs(getComputedStyle(search).transitionDuration)
        : null,
    };
  });
  expect(motion.mediaMatches).toBe(true);
  expect(motion.signalAnimation).toBe("none");
  // The shared shell preserves at most 10ms so transition-end listeners can
  // settle; this is below a perceptible frame and is the app-wide contract.
  expect(motion.recordTransitionMs).not.toBeNull();
  expect(motion.recordTransitionMs!).toBeLessThanOrEqual(10);
  expect(motion.searchTransitionMs).not.toBeNull();
  expect(motion.searchTransitionMs!).toBeLessThanOrEqual(10);

  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-reduced-motion");
  await attachJson(
    testInfo,
    "discount-history-reduced-motion-measurements",
    motion,
  );
});

test("forced colors preserve selected and keyboard-focus evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  const renderer = observeRenderer(page);
  const harness = await openDiscountHistory(page, bootApp, setTheme, {
    theme: "dark",
    width: 700,
    height: 900,
  });
  const selected = page
    .locator('.dhs-filter-group button[aria-pressed="true"]')
    .first();
  // Enter through a real keyboard Tab from the preceding sort control.
  // Programmatic focus alone intentionally does not establish :focus-visible
  // after the pointer-driven navigation used to open this destination.
  await page.getByRole("combobox", { name: "Sort" }).focus();
  await page.keyboard.press("Tab");
  await expect(selected).toBeFocused();

  const contrastEvidence = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      mediaMatches: window.matchMedia("(forced-colors: active)").matches,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      borderStyle: style.borderStyle,
      borderWidth: Number.parseFloat(style.borderWidth),
    };
  });
  expect(contrastEvidence.mediaMatches).toBe(true);
  expect(contrastEvidence.focusVisible).toBe(true);
  expect(contrastEvidence.outlineStyle).toBe("solid");
  expect(contrastEvidence.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(contrastEvidence.borderStyle).not.toBe("none");
  expect(contrastEvidence.borderWidth).toBeGreaterThanOrEqual(1);

  await expectNoHorizontalOverflow(page);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  expectReadOnlyContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "discount-history-forced-colors");
  await attachJson(
    testInfo,
    "discount-history-forced-colors-measurements",
    contrastEvidence,
  );
});
