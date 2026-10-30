import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Page, Route, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_DIR = fileURLToPath(
  new URL("../../../../.audit-screenshots/reviews-evidence", import.meta.url),
);

export const REVIEWS_FIXED_TIME = "2026-07-29T09:30:00.000Z";
export const ACTIVE_WIDGET_NAME = "Homepage customer proof";
export const ACTIVE_WIDGET_URL =
  "https://reviews.example.test/api/public/reviews/widgets/home-customer-proof";
export const INACTIVE_URL_CANARY =
  "https://draft-hidden.example.invalid/widgets/checkout-proof";
export const PENDING_REVIEW_TITLE = "Quietly excellent travel companion";
export const PRIVATE_CONTACT_CANARY =
  "private-reviewer@reviews.example.invalid";
export const PRIVATE_PAYLOAD_CANARY = "private-import-payload-canary";

type Theme = "system" | "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (page: Page, theme: Theme) => Promise<void>;

export interface ReviewsRequestEvidence {
  body: string | null;
  method: string;
  pathname: string;
  search: string;
}

export interface ReviewsHarness {
  requests: ReviewsRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
}

const PENDING_REVIEW = {
  id: "review-pending-001",
  tenant_id: "reviews-evidence-tenant",
  product_id: "product-orbit-bag",
  variant_id: "midnight",
  request_id: "request-evidence-001",
  order_id: "order-evidence-001",
  customer_id: "customer-evidence-001",
  source_platform: "shopify",
  source_ref: "source-evidence-001",
  review_type: "product",
  reviewer_name: "Avery Stone",
  reviewer_email: PRIVATE_CONTACT_CANARY,
  rating: 5,
  title: PENDING_REVIEW_TITLE,
  body: "The compartments stay organized, the fabric still looks new, and the shoulder strap remained comfortable through a full week of travel.",
  status: "pending",
  verified_buyer: true,
  incentivized: false,
  featured: false,
  submitted_at: "2026-07-22T08:15:00.000Z",
  published_at: null,
  moderated_at: null,
  metadata: { fixture: "reviews-maturity" },
  raw_payload: { private_canary: PRIVATE_PAYLOAD_CANARY },
  created_at: "2026-07-22T08:15:00.000Z",
  updated_at: "2026-07-22T08:15:00.000Z",
  public_replies: [],
} as const;

const SECOND_PENDING_REVIEW = {
  id: "review-pending-002",
  product_id: "product-ridge-bottle",
  source_platform: "postwave",
  review_type: "product",
  reviewer_name: "Morgan Lee",
  rating: 3,
  title: "Useful, with one detail to inspect",
  body: "The bottle keeps water cold, but the lid needs a closer evidence review before this is published.",
  status: "pending",
  verified_buyer: false,
  incentivized: true,
  featured: false,
  submitted_at: "2026-07-24T11:45:00.000Z",
  published_at: null,
  moderated_at: null,
  created_at: "2026-07-24T11:45:00.000Z",
  updated_at: "2026-07-24T11:45:00.000Z",
  public_replies: [],
} as const;

const REVIEW_WIDGETS = [
  {
    id: "widget-active-001",
    tenant_id: "reviews-evidence-tenant",
    slug: "home-customer-proof",
    name: ACTIVE_WIDGET_NAME,
    status: "active",
    widget_type: "product_reviews",
    language: "en",
    public_url: ACTIVE_WIDGET_URL,
    created_at: "2026-07-10T10:00:00.000Z",
    updated_at: "2026-07-28T14:00:00.000Z",
  },
  {
    id: "widget-draft-001",
    tenant_id: "reviews-evidence-tenant",
    slug: "checkout-proof",
    name: "Checkout proof draft",
    status: "draft",
    widget_type: "featured_carousel",
    language: "en",
    public_url: INACTIVE_URL_CANARY,
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-27T14:00:00.000Z",
  },
  {
    id: "widget-paused-001",
    tenant_id: "reviews-evidence-tenant",
    slug: "collection-summary",
    name: "Collection summary paused",
    status: "paused",
    widget_type: "summary",
    language: "fr",
    public_url:
      "https://paused-hidden.example.invalid/widgets/collection-summary",
    created_at: "2026-06-18T10:00:00.000Z",
    updated_at: "2026-07-26T14:00:00.000Z",
  },
] as const;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function reviewRowsFor(status: string | null): unknown[] {
  const rows = [PENDING_REVIEW, SECOND_PENDING_REVIEW];
  return status ? rows.filter((review) => review.status === status) : rows;
}

export function requestCount(
  harness: ReviewsHarness,
  pathname: string | RegExp,
  method = "GET",
): number {
  return harness.requests.filter((request) => {
    const pathMatches =
      typeof pathname === "string"
        ? request.pathname === pathname
        : pathname.test(request.pathname);
    return pathMatches && request.method === method;
  }).length;
}

export async function installReviewsHarness(
  page: Page,
): Promise<ReviewsHarness> {
  const harness: ReviewsHarness = {
    requests: [],
    runtimeErrors: [],
    unexpectedRequests: [],
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") {
      harness.runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    harness.runtimeErrors.push(`pageerror: ${error.message}`);
  });

  // Keep the shell's unrelated saved-layout read valid so Reviews evidence is
  // never obscured by a harness-only Dashboard fallback toast.
  await page.route("**/api/v1/dashboard/layout", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await json(route, {
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
    });
  });

  // The shared visual fixture targets optimized bundles and owns a broad
  // `**/api/**` fallback. In explicit source-mode qualification, Vite module
  // URLs under `/src/lib/api/` must bypass that JSON fallback.
  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });

  await page.route("**/api/v1/reviews**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const evidence: ReviewsRequestEvidence = {
      body: request.postData(),
      method: request.method(),
      pathname: url.pathname,
      search: url.search,
    };
    harness.requests.push(evidence);

    if (
      evidence.method === "GET" &&
      evidence.pathname === "/api/v1/reviews/catalog"
    ) {
      await json(route, {
        statuses: ["pending", "approved", "rejected", "spam", "archived"],
        widget_types: ["product_reviews", "featured_carousel", "summary"],
        review_types: ["product", "store"],
        schema_version: "reviews-e2e-v1",
        public_contract:
          "Only explicitly active widgets expose deployment material.",
      });
      return;
    }

    if (evidence.method === "GET" && evidence.pathname === "/api/v1/reviews") {
      await json(route, {
        items: reviewRowsFor(url.searchParams.get("status")),
      });
      return;
    }

    if (
      evidence.method === "GET" &&
      evidence.pathname === "/api/v1/reviews/widgets"
    ) {
      await json(route, { items: REVIEW_WIDGETS });
      return;
    }

    const embed = evidence.pathname.match(
      /^\/api\/v1\/reviews\/widgets\/([^/]+)\/embed\/(iframe|script)$/u,
    );
    if (evidence.method === "GET" && embed) {
      const flavor = embed[2];
      await json(route, {
        flavor,
        snippet:
          flavor === "iframe"
            ? `<iframe src="${ACTIVE_WIDGET_URL}/embed"></iframe>`
            : '<script async src="https://reviews.example.test/embed.js" data-widget="widget-active-001"></script>',
      });
      return;
    }

    const detail = evidence.pathname.match(/^\/api\/v1\/reviews\/([^/]+)$/u);
    if (evidence.method === "GET" && detail) {
      const id = decodeURIComponent(detail[1]);
      const row =
        [PENDING_REVIEW, SECOND_PENDING_REVIEW].find(
          (review) => review.id === id,
        ) ?? null;
      await json(
        route,
        row ?? { error: { code: "review_fixture_not_found" } },
        row ? 200 : 404,
      );
      return;
    }

    const contractViolation = `${evidence.method} ${evidence.pathname}${evidence.search}`;
    harness.unexpectedRequests.push(contractViolation);
    await json(
      route,
      {
        error: {
          code: "reviews_e2e_contract_violation",
          message: `No Reviews maturity fixture permits ${contractViolation}.`,
        },
      },
      405,
    );
  });

  return harness;
}

export async function openReviews(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    height?: number;
    theme?: Theme;
    width?: number;
  } = {},
): Promise<ReviewsHarness> {
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date(REVIEWS_FIXED_TIME));
  await bootApp(page);
  const harness = await installReviewsHarness(page);

  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="reviews"]');
  await destination.click();

  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Turn customer proof into trustworthy storefront confidence.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".reviews-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Moderation inbox", exact: true }),
  ).toBeVisible();
  return harness;
}

export async function expectNoReviewsHorizontalOverflow(
  page: Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".reviews-page");
    const modal = document.querySelector<HTMLElement>(".modal-card");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      modal: modal ? modal.scrollWidth - modal.clientWidth : 0,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      windowScroll: window.scrollX,
    };
  });

  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.modal).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function seriousReviewsAxeViolations(
  page: Page,
  rootSelector = ".reviews-page",
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ rootSelector: selector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
              options: unknown,
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
      const result = await axe.run(selector, {
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
      });
      return result.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      );
    },
    { rootSelector },
  );
}

export async function saveReviewsEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { resetScroll?: boolean } = {},
): Promise<void> {
  await expect(
    page.getByText("Couldn't load your saved Dashboard layout.", {
      exact: false,
    }),
  ).toHaveCount(0);
  if (options.resetScroll !== false) {
    await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".main");
      const content = document.querySelector<HTMLElement>(".content");
      if (main) main.scrollTop = 0;
      if (content) content.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });
  await testInfo.attach(name, {
    path,
    contentType: "image/png",
  });
}

export async function attachReviewsEvidence(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const path = join(EVIDENCE_DIR, `${name}.json`);
  await writeFile(path, body, "utf8");
  await testInfo.attach(name, {
    path,
    contentType: "application/json",
  });
}
