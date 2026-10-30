import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const HERO_TITLE = "See how a gift moved from intention to access.";
export const FIXED_TIME = "2026-07-27T12:00:00.000Z";
export const PAGE_SIZE = 18;

const STATUS_CYCLE = [
  "pending",
  "paid",
  "redeemed",
  "canceled",
  "expired",
  "refunded",
] as const;

export interface GiftWireRecord {
  id: string;
  label: string;
  plan_label: string;
  duration_months: number;
  status: string;
  created_at: string;
  redeemed_at: string | null;
  expires_at: string | null;
  canceled_at: string | null;
  message_recorded: boolean;
  provider_invoice_linked: boolean;
  gifter_member_linked: boolean;
  recipient_member_linked: boolean;
  [key: string]: unknown;
}

export function giftRecord(index: number): GiftWireRecord {
  const prefix = (0x8c1a0000 + index).toString(16).padStart(8, "0");
  const id = `${prefix}-1111-4111-8111-${index.toString(16).padStart(12, "0")}`;
  const status = STATUS_CYCLE[(index - 1) % STATUS_CYCLE.length]!;
  const createdAt = new Date(
    Date.parse(FIXED_TIME) - index * 86_400_000,
  ).toISOString();
  const terminalAt = new Date(
    Date.parse(createdAt) + 3 * 86_400_000,
  ).toISOString();
  return {
    id,
    label: `Gift record ${prefix.toUpperCase()}`,
    plan_label: ["Essentials", "Pro", "Studio"][(index - 1) % 3]!,
    duration_months: [1, 3, 6, 12][(index - 1) % 4]!,
    status,
    created_at: createdAt,
    redeemed_at: status === "redeemed" ? terminalAt : null,
    expires_at: status === "expired" ? terminalAt : null,
    canceled_at: status === "canceled" ? terminalAt : null,
    message_recorded: index % 2 === 0,
    provider_invoice_linked: index % 3 !== 0,
    gifter_member_linked: index % 4 === 0,
    recipient_member_linked: status === "redeemed",
  };
}

export const ALL_RECORDS = Array.from({ length: 30 }, (_, index) =>
  giftRecord(index + 1),
);
export const PRIMARY_RECORD = ALL_RECORDS[0]!;
export const PRIMARY_LABEL = PRIMARY_RECORD.label;
export const PRIMARY_ID = PRIMARY_RECORD.id;
export const SECOND_PAGE_RECORD = ALL_RECORDS[18]!;

export const SAFE_STATS = {
  total: 30,
  pending: 5,
  paid: 5,
  granted: 5,
  canceled: 5,
  expired: 5,
  refunded: 5,
  conversionRate: 0.25,
  generated_at: FIXED_TIME,
} as const;

export const EMPTY_STATS = {
  total: 0,
  pending: 0,
  paid: 0,
  granted: 0,
  canceled: 0,
  expired: 0,
  refunded: 0,
  conversionRate: 0,
  generated_at: FIXED_TIME,
} as const;

export const SERVICE_FAILURE = {
  status: 503,
  body: {
    error: {
      code: "gift_history_temporarily_unavailable",
      message: "The sanitized gift archive is temporarily unavailable.",
    },
  },
} as const;

export interface PlannedResponse {
  status: number;
  body: unknown;
}

export interface RequestEvidence {
  method: string;
  pathname: string;
  search: string;
  body: string | null;
}

export interface GiftHarnessOptions {
  list?: readonly PlannedResponse[];
  stats?: readonly PlannedResponse[];
  detail?: readonly PlannedResponse[];
  holdInitialList?: boolean;
  holdInitialStats?: boolean;
}

export interface GiftHarness {
  requests: RequestEvidence[];
  listCalls: number;
  statsCalls: number;
  detailCalls: number;
  releaseInitialList: () => void;
  releaseInitialStats: () => void;
}

export type Theme = "dark" | "light";
export type BootApp = (page: Page) => Promise<void>;
export type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

function createGate(open: boolean): Gate {
  let release = (): void => undefined;
  const promise = open
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        release = resolve;
      });
  return { promise, release };
}

function responseFor(
  plan: readonly PlannedResponse[],
  callIndex: number,
): PlannedResponse {
  return plan[Math.min(callIndex, plan.length - 1)]!;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function normalizedStatus(record: GiftWireRecord): string {
  return record.status === "canceled" ? "cancelled" : record.status;
}

function defaultListResponse(url: URL): PlannedResponse {
  const limit = Number.parseInt(
    url.searchParams.get("limit") ?? String(PAGE_SIZE),
    10,
  );
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const query = (url.searchParams.get("q") ?? "")
    .toLowerCase()
    .replaceAll("-", "");
  const filter = url.searchParams.get("filter") ?? "all";
  const sort = url.searchParams.get("sort") ?? "newest";
  let records = ALL_RECORDS.filter((record) => {
    const state = normalizedStatus(record);
    if (
      query &&
      !record.id.toLowerCase().replaceAll("-", "").startsWith(query)
    ) {
      return false;
    }
    if (filter === "all") return true;
    if (filter === "open") return state === "pending" || state === "paid";
    if (filter === "closed") {
      return ["redeemed", "cancelled", "expired", "refunded"].includes(state);
    }
    return state === filter;
  });
  records = [...records].sort((left, right) => {
    if (sort === "oldest") {
      return Date.parse(left.created_at) - Date.parse(right.created_at);
    }
    if (sort === "duration") {
      return (
        right.duration_months - left.duration_months ||
        Date.parse(right.created_at) - Date.parse(left.created_at)
      );
    }
    if (sort === "status") {
      return (
        normalizedStatus(left).localeCompare(normalizedStatus(right)) ||
        Date.parse(right.created_at) - Date.parse(left.created_at)
      );
    }
    return Date.parse(right.created_at) - Date.parse(left.created_at);
  });
  return {
    status: 200,
    body: {
      items: records.slice(offset, offset + limit),
      total: records.length,
      limit,
      offset,
      snapshot_at: FIXED_TIME,
    },
  };
}

function isGiftAdjacent(pathname: string): boolean {
  return /(?:gift|attribution|redeem|checkout|stripe|provider)/iu.test(
    pathname,
  );
}

function validDetailPath(pathname: string): boolean {
  return /^\/api\/v1\/gift-subscriptions\/[0-9a-f-]{36}$/iu.test(pathname);
}

export async function installGiftHarness(
  page: Page,
  options: GiftHarnessOptions = {},
): Promise<GiftHarness> {
  const listGate = createGate(!options.holdInitialList);
  const statsGate = createGate(!options.holdInitialStats);
  const harness: GiftHarness = {
    requests: [],
    listCalls: 0,
    statsCalls: 0,
    detailCalls: 0,
    releaseInitialList: listGate.release,
    releaseInitialStats: statsGate.release,
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/dashboard/layout" &&
      request.method() === "GET"
    ) {
      // The shell resolves this unrelated preference before Gift history is
      // selected. A complete order keeps a harness-only Dashboard fallback
      // toast from contaminating route evidence.
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
        updatedAt: FIXED_TIME,
      });
      return;
    }
    if (!isGiftAdjacent(url.pathname)) {
      await route.fallback();
      return;
    }

    harness.requests.push({
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
      body: request.postData(),
    });

    if (
      url.pathname === "/api/v1/gift-subscriptions" &&
      request.method() === "GET"
    ) {
      const callIndex = harness.listCalls;
      harness.listCalls += 1;
      if (callIndex === 0) await listGate.promise;
      const planned = options.list?.length
        ? responseFor(options.list, callIndex)
        : defaultListResponse(url);
      await json(route, planned.body, planned.status);
      return;
    }

    if (
      url.pathname === "/api/v1/gift-subscriptions/stats" &&
      request.method() === "GET"
    ) {
      const callIndex = harness.statsCalls;
      harness.statsCalls += 1;
      if (callIndex === 0) await statsGate.promise;
      const planned = options.stats?.length
        ? responseFor(options.stats, callIndex)
        : { status: 200, body: SAFE_STATS };
      await json(route, planned.body, planned.status);
      return;
    }

    if (validDetailPath(url.pathname) && request.method() === "GET") {
      const callIndex = harness.detailCalls;
      harness.detailCalls += 1;
      const recordID = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const fallbackRecord =
        ALL_RECORDS.find((record) => record.id === recordID) ?? PRIMARY_RECORD;
      const planned = options.detail?.length
        ? responseFor(options.detail, callIndex)
        : { status: 200, body: fallbackRecord };
      await json(route, planned.body, planned.status);
      return;
    }

    await json(
      route,
      {
        error: {
          code: "gift_history_test_contract_violation",
          message:
            "The qualification harness permits only the three sanitized gift-history reads.",
        },
      },
      405,
    );
  });

  return harness;
}

export async function openGiftHistory(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: GiftHarnessOptions & {
    theme?: Theme;
    width?: number;
    height?: number;
  } = {},
): Promise<GiftHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await bootApp(page);
  const harness = await installGiftHarness(page, options);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="gifts"]');
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: HERO_TITLE, exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ghs-page")).toBeVisible();
  return harness;
}

export function observeRenderer(
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

export async function seriousAxeViolations(
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
    const root = document.querySelector(".ghs-page");
    if (!root) throw new Error("Gift history root was not rendered.");
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

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".ghs-page");
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

export async function saveEvidence(
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

export async function attachJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}

export function expectReadOnlyGiftContract(harness: GiftHarness): void {
  expect(harness.listCalls).toBeGreaterThanOrEqual(1);
  expect(harness.statsCalls).toBeGreaterThanOrEqual(1);
  expect(harness.requests.length).toBeGreaterThanOrEqual(2);
  expect(harness.requests.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(harness.requests.filter(({ body }) => body !== null)).toEqual([]);
  expect(
    harness.requests.filter(({ pathname }) =>
      /(?:attribution|redeem|checkout|stripe|provider|public|create|cancel|edit|export)/iu.test(
        pathname,
      ),
    ),
  ).toEqual([]);

  for (const request of harness.requests) {
    if (request.pathname === "/api/v1/gift-subscriptions") {
      const params = new URLSearchParams(request.search);
      expect(params.get("limit")).toBe(String(PAGE_SIZE));
      expect(params.get("offset")).toMatch(/^\d+$/u);
      expect(
        [...params.keys()].filter(
          (key) => !["limit", "offset", "q", "filter", "sort"].includes(key),
        ),
      ).toEqual([]);
      continue;
    }
    if (request.pathname === "/api/v1/gift-subscriptions/stats") {
      expect(request.search).toBe("");
      continue;
    }
    expect(request.pathname).toMatch(
      /^\/api\/v1\/gift-subscriptions\/[0-9a-f-]{36}$/iu,
    );
    expect(request.search).toBe("");
  }
}

export async function expectNoUnsupportedActions(page: Page): Promise<void> {
  const route = page.locator(".ghs-page");
  await expect(
    route.getByRole("button", {
      name: /^(?:Create|Issue|Edit|Redeem|Cancel|Delete|Refund|Export|Download|Copy|Open checkout)\b/iu,
    }),
  ).toHaveCount(0);
  await expect(
    route.getByRole("link", {
      name: /^(?:Create|Issue|Edit|Redeem|Cancel|Delete|Refund|Export|Download|Copy|Open checkout)\b/iu,
    }),
  ).toHaveCount(0);
  await expect(route.locator("a[href], a[download]")).toHaveCount(0);
  await expect(
    route.locator(
      'textarea, input[type="file"], input:not([type="search"]):not([type="hidden"])',
    ),
  ).toHaveCount(0);
}

export async function expectNoSensitiveDom(
  page: Page,
  options: { forbiddenValues?: readonly string[] } = {},
): Promise<void> {
  const text = await page.locator(".ghs-page").innerText();
  expect(text).not.toMatch(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u);
  for (const record of ALL_RECORDS) {
    expect(text).not.toContain(record.id);
  }
  for (const forbidden of options.forbiddenValues ?? []) {
    expect(text).not.toContain(forbidden);
  }
}
