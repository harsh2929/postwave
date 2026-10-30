import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Locator, Page, Route, TestInfo } from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const PRODUCT_EVENTS_FIXED_NOW = new Date("2026-07-24T12:00:00.000Z");

type ProductEventsState =
  | "populated"
  | "true-empty"
  | "scoped-empty"
  | "range-empty";

type UserRole = "admin" | "viewer";
type Theme = "dark" | "light";

export interface ProductEventsEvidenceOptions {
  catalogSize?: number;
  role?: UserRole;
  state?: ProductEventsState;
  theme?: Theme;
}

export interface ProductEventsEvidenceControl {
  eventQueries: string[];
  statsQueries: string[];
  catalogQueries: string[];
  unexpectedTrackRequests: string[];
}

interface OpenProductEventsOptions extends ProductEventsEvidenceOptions {
  bootApp: (page: Page) => Promise<void>;
  page: Page;
  setTheme: (page: Page, theme: Theme) => Promise<void>;
}

const RECENT_EVENTS = [
  {
    id: "evt-checkout-001",
    tenantId: "test-tenant",
    subscriberId: "sub-ada",
    subscriber_email: "ada@example.invalid",
    eventName: "checkout.completed",
    properties: {
      amount_cents: 12_900,
      currency: "USD",
      order_id: "order_visual_42",
    },
    occurredAt: "2026-07-24T11:42:00.000Z",
    receivedAt: "2026-07-24T11:42:01.000Z",
  },
  {
    id: "evt-renewal-002",
    tenantId: "test-tenant",
    subscriberId: "sub-grace",
    subscriber_email: "grace@example.invalid",
    eventName: "subscription.renewed",
    properties: {
      plan: "growth",
      billing_cycle: "annual",
    },
    occurredAt: "2026-07-24T10:10:00.000Z",
    receivedAt: "2026-07-24T10:10:01.000Z",
  },
  {
    id: "evt-feature-003",
    tenantId: "test-tenant",
    subscriberId: "sub-ada",
    subscriber_email: "ada@example.invalid",
    eventName: "feature.activated",
    properties: {
      feature: "journey_branching",
      source: "workspace",
    },
    occurredAt: "2026-07-23T16:20:00.000Z",
    receivedAt: "2026-07-23T16:20:01.000Z",
  },
] as const;

const OLD_EVENTS = [
  {
    id: "evt-archive-001",
    tenantId: "test-tenant",
    subscriberId: "sub-archive",
    subscriber_email: "archive@example.invalid",
    eventName: "account.archived",
    properties: { reason: "workspace_closed" },
    occurredAt: "2026-05-25T09:00:00.000Z",
    receivedAt: "2026-05-25T09:00:01.000Z",
  },
] as const;

const RECENT_CONVERSIONS = [
  {
    id: 42,
    tenant_id: "test-tenant",
    subscriber_email: "ada@example.invalid",
    event_name: "checkout.completed",
    amount_cents: 12_900,
    currency: "USD",
    campaign_id: "cmp-summer-visual",
    properties: { order_id: "order_visual_42", plan: "growth" },
    occurred_at: "2026-07-24T11:42:00.000Z",
  },
  {
    id: 41,
    tenant_id: "test-tenant",
    subscriber_email: "grace@example.invalid",
    event_name: "subscription.renewed",
    amount_cents: 24_000,
    currency: "USD",
    properties: { billing_cycle: "annual" },
    occurred_at: "2026-07-24T10:10:00.000Z",
  },
] as const;

const TRACKING_KEYS = [
  {
    id: "key-visual-primary",
    tenant_id: "test-tenant",
    label: "Production storefront",
    prefix: "pwtrk_live_7YQ2",
    created_at: "2026-07-20T08:00:00.000Z",
  },
] as const;

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function dailyBuckets(
  days: number,
  total: number,
): Array<{ date: string; count: number }> {
  const safeDays = Math.max(1, Math.min(365, Math.floor(days)));
  return Array.from({ length: safeDays }, (_, index) => {
    const date = new Date(PRODUCT_EVENTS_FIXED_NOW);
    date.setUTCDate(date.getUTCDate() - (safeDays - index - 1));
    date.setUTCHours(0, 0, 0, 0);
    const base = total === 0 ? 0 : (index * 7 + 3) % 11;
    return {
      date: date.toISOString().slice(0, 10),
      count:
        index === safeDays - 1 && total > 0 ? Math.max(1, total - base) : base,
    };
  });
}

function catalogRows(size: number): Array<{
  eventName: string;
  count: number;
  uniqueSubscribers: number;
  firstSeen: string;
  lastSeen: string;
  daily: Array<{ date: string; count: number }>;
}> {
  const boundedSize = Math.max(0, Math.min(200, Math.floor(size)));
  return Array.from({ length: boundedSize }, (_, index) => {
    const eventName =
      index === 0
        ? "checkout.completed"
        : index === 1
          ? "subscription.renewed"
          : index === 2
            ? "feature.activated"
            : `catalog_event_${String(index + 1).padStart(3, "0")}`;
    const count = Math.max(1, 684 - index * 3);
    return {
      eventName,
      count,
      uniqueSubscribers: Math.max(1, 241 - index),
      firstSeen: "2026-07-18T08:00:00.000Z",
      lastSeen: "2026-07-24T11:42:00.000Z",
      daily: dailyBuckets(7, count),
    };
  });
}

async function installRoleOverride(page: Page, role: UserRole): Promise<void> {
  if (role === "admin") return;
  await page.route("**/api/v1/auth/me", (route) =>
    json(route, {
      user_id: "product-events-viewer",
      tenant_id: "test-tenant",
      email: "viewer@product-events.example.invalid",
      role,
      effective_role: role,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Moosewave",
      workspace_slug: "test-tenant",
    }),
  );
}

export async function installProductEventsEvidenceApi(
  page: Page,
  {
    catalogSize = 3,
    role = "admin",
    state = "populated",
  }: ProductEventsEvidenceOptions = {},
): Promise<ProductEventsEvidenceControl> {
  await installRoleOverride(page, role);
  const control: ProductEventsEvidenceControl = {
    eventQueries: [],
    statsQueries: [],
    catalogQueries: [],
    unexpectedTrackRequests: [],
  };
  const catalog = catalogRows(state === "true-empty" ? 0 : catalogSize);

  await page.route("**/api/v1/track**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (request.method() === "GET" && pathname === "/api/v1/track/events") {
      control.eventQueries.push(url.search);
      const eventName = url.searchParams.get("event_name");
      const subscriberId = url.searchParams.get("subscriber_id");
      const baseRows =
        state === "true-empty"
          ? []
          : state === "range-empty"
            ? [...OLD_EVENTS]
            : [...RECENT_EVENTS];
      const rows =
        state === "scoped-empty" && eventName
          ? []
          : baseRows.filter(
              (event) =>
                (!eventName || event.eventName === eventName) &&
                (!subscriberId || event.subscriberId === subscriberId),
            );
      await json(route, { items: rows });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/v1/track/catalog") {
      control.catalogQueries.push(url.search);
      const days = Number(url.searchParams.get("days") ?? "7");
      await json(route, {
        items: catalog,
        totalDistinctEventNames: catalog.length,
        periodDays: days,
        dailySeriesPeriodDays: 7,
        eventBoundsScope: "period",
        timeZone: "UTC",
        asOf: PRODUCT_EVENTS_FIXED_NOW.toISOString(),
      });
      return;
    }
    if (request.method() === "GET" && pathname === "/api/v1/track/stats") {
      control.statsQueries.push(url.search);
      const days = Number(url.searchParams.get("days") ?? "7");
      const eventName = url.searchParams.get("event_name");
      const scopedEmpty = state === "scoped-empty" && Boolean(eventName);
      const empty = state === "true-empty" || scopedEmpty;
      const totalEvents = empty
        ? 0
        : eventName
          ? RECENT_EVENTS.filter((event) => event.eventName === eventName)
              .length
          : 1_284;
      await json(route, {
        periodDays: days,
        totalEvents,
        uniqueSubscribers: empty ? 0 : eventName ? 1 : 642,
        uniqueEventNames: empty ? 0 : eventName ? 1 : catalog.length,
        daily: dailyBuckets(days, totalEvents),
        asOf: PRODUCT_EVENTS_FIXED_NOW.toISOString(),
        timeZone: "UTC",
      });
      return;
    }
    if (request.method() === "POST" && pathname === "/api/v1/track") {
      await json(route, { id: "evt-composer-evidence" }, 202);
      return;
    }
    control.unexpectedTrackRequests.push(`${request.method()} ${url.href}`);
    await json(
      route,
      {
        error: {
          code: "unexpected_product_events_evidence_request",
          message: "The deterministic Product Events fixture has no handler.",
        },
      },
      500,
    );
  });

  await page.route("**/api/v1/conversions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "GET" &&
      url.pathname === "/api/v1/conversions/keys"
    ) {
      await json(route, TRACKING_KEYS);
      return;
    }
    if (request.method() === "GET" && url.pathname === "/api/v1/conversions") {
      await json(
        route,
        url.searchParams.has("before") ? [] : RECENT_CONVERSIONS,
      );
      return;
    }
    await route.fallback();
  });

  return control;
}

export async function openProductEvents({
  bootApp,
  page,
  setTheme,
  theme = "dark",
  ...fixtureOptions
}: OpenProductEventsOptions): Promise<ProductEventsEvidenceControl> {
  await page.clock.install({ time: PRODUCT_EVENTS_FIXED_NOW });
  await setTheme(page, theme);
  await bootApp(page);
  const control = await installProductEventsEvidenceApi(page, fixtureOptions);
  await page.goto("/app/track");
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByRole("heading", { name: "Product events", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Signal overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Activity stream", exact: true }),
  ).toBeVisible();
  return control;
}

export async function settleProductEvents(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export async function expectNoProductEventsPageOverflow(
  page: Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const descendants = content
      ? Array.from(content.querySelectorAll<HTMLElement>("*"))
          .filter((element) => {
            const style = getComputedStyle(element);
            if (style.position === "fixed") return false;
            const excess = element.scrollWidth - element.clientWidth;
            return (
              excess > 2 &&
              style.overflowX !== "auto" &&
              style.overflowX !== "scroll"
            );
          })
          .slice(0, 8)
          .map((element) => {
            const className =
              typeof element.className === "string" ? element.className : "";
            return `${element.tagName.toLowerCase()}.${className.replaceAll(" ", ".")}: ${element.scrollWidth}-${element.clientWidth}`;
          })
      : [];
    return {
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      descendants,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(
    overflow.content,
    `Non-scrolling Product Events overflow: ${overflow.descendants.join("; ")}`,
  ).toBeLessThanOrEqual(1);
}

export async function expectHorizontallyContained(
  locator: Locator,
  page: Page,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

export async function expectViewportContained(
  locator: Locator,
  page: Page,
): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

export async function seriousProductEventsAxeViolations(
  page: Page,
  { forcedColors = false }: { forcedColors?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ forcedColors }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              root: Document,
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
      const result = await axe.run(document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
        ...(forcedColors
          ? { rules: { "color-contrast": { enabled: false } } }
          : {}),
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        )
        .map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failure: node.failureSummary,
          })),
        }));
    },
    { forcedColors },
  );
}

export async function saveProductEventsEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: false,
  });
}
