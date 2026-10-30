// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/commerce — the Recovery & alerts tab (commerce-19/20/21/22/23/24) and
// the Lifecycle tab (commerce-25/26). Every assertion is on the CONSEQUENCE of
// a verb: the request's method + path + query + body, the rendered result, the
// confirm's copy, or the server's sentence rendered verbatim. `@/lib/api` is
// mocked at the transport so the literal "/api/v1/…" paths are what is
// asserted, not a friendlier wrapper.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { COMMERCE_ADMIN_ONLY_MESSAGE } from "@/lib/commerce-authority";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  replace: vi.fn(),
  search: { current: "" },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: mocks.replace,
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/commerce",
  useSearchParams: () => new URLSearchParams(mocks.search.current),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});

vi.mock("sonner", () => ({ toast: mocks.toast }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------- fixtures: the shapes the Go handlers answer with ---------- */

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "qa@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
};
const VIEWER = {
  ...OWNER,
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

const SHOP = "brand.myshopify.com";
const STAMP = "2026-08-01T00:00:00Z";

const INTEGRATIONS_PATH = "/api/v1/commerce/integrations";
const STORE = `${INTEGRATIONS_PATH}/int_1`;
const OTHER_STORE = `${INTEGRATIONS_PATH}/int_2`;
const CART_LINKS_PATH = `${STORE}/cart-recovery-links`;
const OTHER_CART_LINKS_PATH = `${OTHER_STORE}/cart-recovery-links`;
const BACK_IN_STOCK_PATH = `${STORE}/back-in-stock-subscriptions`;
const WATCHERS_PATH = `${STORE}/price-drop-watchers`;
const BACK_IN_STOCK_CREATE_PATH = `${STORE}/products/prod_1/back-in-stock-subscriptions`;
const WATCHER_CREATE_PATH = `${STORE}/products/prod_1/price-drop-watchers`;
const REPORT_PATH = `${STORE}/lifecycle/report`;
const EVALUATE_PATH = `${STORE}/lifecycle/evaluate`;

const INTEGRATIONS = [
  {
    id: "int_1",
    provider: "shopify",
    shop_domain: SHOP,
    status: "connected",
    scopes: [],
    settings: {},
    created_at: STAMP,
    updated_at: STAMP,
  },
  {
    id: "int_2",
    provider: "woocommerce",
    shop_domain: "shop.example",
    status: "connected",
    scopes: [],
    settings: {},
    created_at: STAMP,
    updated_at: STAMP,
  },
];

/** The recovery URL carries the resume token in its path AND query — neither
 *  may reach the table. */
const RECOVERY_URL = "https://brand.myshopify.com/cart/c/abc123?key=s3cr3t";

const CART_LINK_ACTIVE = {
  id: "crl_1",
  integration_id: "int_1",
  source_cart_id: "cart_9",
  customer_email: "jane@example.com",
  recovery_url: RECOVERY_URL,
  status: "active",
  expires_at: "2026-09-10T00:00:00Z",
  metadata: {},
  created_at: STAMP,
  updated_at: STAMP,
};
const CART_LINK_CONVERTED = {
  ...CART_LINK_ACTIVE,
  id: "crl_2",
  source_cart_id: "cart_10",
  customer_email: "sam@example.com",
  status: "converted",
};
const CART_LINK_PAGE_2 = {
  ...CART_LINK_ACTIVE,
  id: "crl_3",
  source_cart_id: "cart_11",
  customer_email: "kim@example.com",
};

const SUBSCRIPTION = {
  id: "bis_1",
  integration_id: "int_1",
  product_id: "prod_1",
  variant_id: "var_1",
  subscriber_id: "sub_7",
  subscriber_email: "jane@example.com",
  status: "waiting",
  requested_at: "2026-08-20T00:00:00Z",
  eligible_at: null,
  notified_at: null,
  expires_at: null,
  metadata: {},
  created_at: STAMP,
  updated_at: STAMP,
};

const WATCHER = {
  id: "pdw_1",
  integration_id: "int_1",
  product_id: "prod_1",
  variant_id: "var_1",
  subscriber_id: "sub_7",
  subscriber_email: "sam@example.com",
  original_price_cents: 4900,
  target_price_cents: 3900,
  min_drop_percent: null,
  currency: "USD",
  status: "watching",
  watched_at: "2026-08-21T00:00:00Z",
  eligible_at: null,
  notified_at: null,
  expires_at: null,
  metadata: {},
  created_at: STAMP,
  updated_at: STAMP,
};

const REPORT = {
  integration_id: "int_1",
  generated_at: "2026-09-04T09:30:00Z",
  cart_recovery: { total: 12, by_status: { active: 9, converted: 3 } },
  back_in_stock: { total: 5, by_status: { waiting: 4, notified: 1 } },
  price_drop: { total: 2, by_status: { watching: 2 } },
  events_last_30_days: { order_created: 31, back_in_stock_eligible: 4 },
  eligible_last_30_days: 7,
  notified_pending: 3,
};

const ACKNOWLEDGEMENT = {
  back_in_stock_eligible: 4,
  price_drop_eligible: 2,
  evaluated_at: "2026-09-05T10:00:00Z",
};

type Answer = () => Promise<unknown>;
/** Per-path answers that replace the default stub — GET and POST are kept
 *  apart because several routes are both (…/cart-recovery-links). */
const overrides = new Map<string, Answer>();
const postOverrides = new Map<string, Answer>();

function stubTransport(): void {
  mocks.apiGet.mockImplementation(
    (path: string, opts?: { query?: Record<string, unknown> }) => {
      const override = overrides.get(path);
      if (override) return override();
      const status = opts?.query?.status;
      const cursor = opts?.query?.cursor;
      switch (path) {
        case INTEGRATIONS_PATH:
          return Promise.resolve(INTEGRATIONS);
        case CART_LINKS_PATH:
          if (status === "converted") {
            return Promise.resolve({ items: [CART_LINK_CONVERTED] });
          }
          if (cursor === "crl_2") {
            return Promise.resolve({ items: [CART_LINK_PAGE_2] });
          }
          return Promise.resolve({
            items: [CART_LINK_ACTIVE, CART_LINK_CONVERTED],
            next_cursor: "crl_2",
          });
        case OTHER_CART_LINKS_PATH:
          return Promise.resolve({ items: [] });
        case BACK_IN_STOCK_PATH:
          if (status === "eligible") return Promise.resolve({ items: [] });
          return Promise.resolve({ items: [SUBSCRIPTION] });
        case WATCHERS_PATH:
          return Promise.resolve({ items: [WATCHER] });
        case REPORT_PATH:
          return Promise.resolve(REPORT);
        default:
          return Promise.reject(new Error(`Unexpected GET ${path}`));
      }
    },
  );
  mocks.apiPost.mockImplementation((path: string, body?: unknown) => {
    const override = postOverrides.get(path);
    if (override) return override();
    switch (path) {
      case CART_LINKS_PATH:
        return Promise.resolve({
          ...CART_LINK_ACTIVE,
          ...(body as Record<string, unknown>),
        });
      case BACK_IN_STOCK_CREATE_PATH:
        return Promise.resolve({
          ...SUBSCRIPTION,
          ...(body as Record<string, unknown>),
        });
      case WATCHER_CREATE_PATH:
        return Promise.resolve({
          ...WATCHER,
          ...(body as Record<string, unknown>),
        });
      case EVALUATE_PATH:
        return Promise.resolve(ACKNOWLEDGEMENT);
      default:
        return Promise.reject(new Error(`Unexpected POST ${path}`));
    }
  });
}

/* ---------- harness ---------- */

async function render(ui: ReactNode): Promise<Root> {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  // Deadline-based: the recovery/lifecycle tabs are next/dynamic chunks, and
  // 60 zero-delay turns is a few milliseconds of wall time under load.
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await act(async () => flush());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function q<T extends Element>(
  selector: string,
  scope: ParentNode = document,
): T {
  const el = scope.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

function dialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
}

function dialogContaining(needle: string): HTMLElement {
  const el = dialogs().find((d) => d.textContent?.includes(needle));
  if (!el) throw new Error(`No open dialog containing "${needle}"`);
  return el;
}

function buttonByText(
  label: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const el = [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!el) throw new Error(`Missing button "${label}"`);
  return el;
}

function maybeButtonByText(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
}

function buttonByLabel(label: string): HTMLButtonElement {
  return q<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

/** The lifecycle report's own tiles. Null whenever no trustworthy report is
 *  rendered — the tab's standing guidance mentions the same words, so this is
 *  the only honest "no totals are on screen" assertion. */
function reportSummary(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'dl[aria-label="Lifecycle report summary"]',
  );
}

/** A status chip inside one record kind's filter group. */
function statusChip(legend: string, label: string): HTMLButtonElement {
  const group = q<HTMLElement>(`[role="group"][aria-label="${legend}"]`);
  const chip = [...group.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!chip) throw new Error(`Missing "${label}" chip in "${legend}"`);
  return chip;
}

/** The Recovery tab's record-type switcher. */
function recoveryTab(label: string): HTMLElement {
  const list = q<HTMLElement>(
    '[role="tablist"][aria-label="Recovery record type"]',
  );
  const tab = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (t) => t.textContent?.trim() === label,
  );
  if (!tab) throw new Error(`Missing recovery record tab "${label}"`);
  return tab;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

/** Radix activates a tab on left mousedown (or on focus); a bare click() is
 *  neither, so press it the way a pointer does. */
async function pressTab(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    (el as HTMLElement).click();
    await flush();
  });
}

async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function getCalls(
  path: string,
): Array<{ query?: Record<string, unknown> } | undefined> {
  return mocks.apiGet.mock.calls
    .filter(([p]) => p === path)
    .map(([, opts]) => opts as { query?: Record<string, unknown> } | undefined);
}

function postCalls(path: string): Array<[string, unknown, unknown]> {
  return mocks.apiPost.mock.calls.filter(([p]) => p === path) as Array<
    [string, unknown, unknown]
  >;
}

function expectLiveAdminOptions(
  value: unknown,
  extra: Record<string, unknown> = {},
): void {
  expect(value).toEqual(
    expect.objectContaining({
      cache: "no-store",
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: expect.any(String),
      signal: expect.any(AbortSignal),
      ...extra,
    }),
  );
}

async function mountPage(search: string): Promise<Root> {
  mocks.search.current = search;
  const Page = (await import("@/app/(dashboard)/app/commerce/page")).default;
  const root = await render(createElement(Page));
  await waitFor(() => {
    expect(document.querySelector("h1")?.textContent).toBe(
      "Commerce workspace",
    );
  });
  return root;
}

async function mountRecovery(): Promise<Root> {
  const root = await mountPage("tab=recovery");
  await waitFor(() => expect(text()).toContain("j•••@example.com"));
  return root;
}

async function mountLifecycle(): Promise<Root> {
  const root = await mountPage("tab=lifecycle");
  await waitFor(() => expect(getCalls(REPORT_PATH).length).toBeGreaterThan(0));
  return root;
}

function unmount(root: Root): void {
  act(() => root.unmount());
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  overrides.clear();
  postOverrides.clear();
  stubTransport();
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/* ---------- commerce-19: list cart-recovery links ---------- */

describe("/app/commerce — cart-recovery links (commerce-19)", () => {
  it("?tab=recovery lists the first store's links through the cursor contract, masks the customer and hides the resume token, and pages Next/Previous", async () => {
    const root = await mountRecovery();
    try {
      expect(getCalls(CART_LINKS_PATH)[0]).toEqual({
        query: { status: undefined, limit: 25, cursor: undefined },
      });
      expect(text()).toContain("Link crl_1 · Cart cart_9");
      // The origin only: the path segment and query both carry the token.
      expect(text()).toContain("https://brand.myshopify.com");
      expect(text()).not.toContain("s3cr3t");
      expect(text()).not.toContain("abc123");
      expect(text()).not.toContain("jane@example.com");
      expect(text()).toContain(
        "Page 1 · 2 items on this page; more are available.",
      );
      expect(
        buttonByLabel("Previous page of cart-recovery links").disabled,
      ).toBe(true);

      await click(buttonByLabel("Next page of cart-recovery links"));
      await waitFor(() =>
        expect(text()).toContain("Link crl_3 · Cart cart_11"),
      );
      expect(getCalls(CART_LINKS_PATH).at(-1)).toEqual({
        query: { status: undefined, limit: 25, cursor: "crl_2" },
      });
      expect(text()).toContain("Page 2 · 1 item on this page.");

      await click(buttonByLabel("Previous page of cart-recovery links"));
      await waitFor(() => expect(text()).toContain("Link crl_1 · Cart cart_9"));
      expect(text()).toContain("Page 1 · 2 items on this page");
    } finally {
      unmount(root);
    }
  });

  it("a status chip sends ?status= and resets the cursor; the store select re-scopes the list to the chosen store", async () => {
    const root = await mountRecovery();
    try {
      await click(buttonByLabel("Next page of cart-recovery links"));
      await waitFor(() =>
        expect(text()).toContain("Link crl_3 · Cart cart_11"),
      );

      await click(
        statusChip("Filter cart-recovery links by status", "Converted"),
      );
      await waitFor(() =>
        expect(getCalls(CART_LINKS_PATH).at(-1)).toEqual({
          query: { status: "converted", limit: 25, cursor: undefined },
        }),
      );
      await waitFor(() =>
        expect(text()).toContain("Link crl_2 · Cart cart_10"),
      );
      expect(text()).toContain("Page 1 · 1 item on this page.");
      expect(text()).not.toContain("Link crl_1 · Cart cart_9");

      await choose(q<HTMLSelectElement>('select[id$="-store"]'), "int_2");
      await waitFor(() =>
        expect(getCalls(OTHER_CART_LINKS_PATH)).toHaveLength(1),
      );
      expect(getCalls(OTHER_CART_LINKS_PATH)[0]).toEqual({
        query: { status: "converted", limit: 25, cursor: undefined },
      });
      await waitFor(() =>
        expect(text()).toContain(
          "No cart-recovery links with status “Converted”",
        ),
      );
    } finally {
      unmount(root);
    }
  });

  it("a refusal on the list renders the server's sentence, and a viewer is not offered the admin create", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    overrides.set(CART_LINKS_PATH, () =>
      Promise.reject(
        new ApiError("integration not found", 404, undefined, {
          code: "not_found",
        }),
      ),
    );
    const root = await mountPage("tab=recovery");
    try {
      await waitFor(() => expect(text()).toContain("integration not found"));
      expect(text()).toContain(COMMERCE_ADMIN_ONLY_MESSAGE);
      expect(maybeButtonByText("New link")).toBeUndefined();
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-20: create (upsert) a cart-recovery link ---------- */

describe("/app/commerce — new cart-recovery link (commerce-20)", () => {
  it("posts source_cart_id, the normalized HTTPS recovery URL and the lower-cased customer email to the store's route, then re-reads the list", async () => {
    const root = await mountRecovery();
    try {
      const before = getCalls(CART_LINKS_PATH).length;
      await click(buttonByText("New link"));
      const dialog = dialogContaining("New cart-recovery link");

      await type(
        q<HTMLInputElement>('input[id$="-cart"]', dialog),
        " cart_42 ",
      );
      await type(
        q<HTMLInputElement>('input[id$="-url"]', dialog),
        "https://brand.myshopify.com/cart/c/zz?key=t0ken",
      );
      await type(
        q<HTMLInputElement>('input[id$="-email"]', dialog),
        " Jane@Example.com ",
      );
      await click(buttonByText("Save link", dialog));

      await waitFor(() => expect(postCalls(CART_LINKS_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(CART_LINKS_PATH)[0]!;
      expect(body).toEqual({
        source_cart_id: "cart_42",
        recovery_url: "https://brand.myshopify.com/cart/c/zz?key=t0ken",
        customer_email: "jane@example.com",
      });
      expectLiveAdminOptions(opts);
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Cart-recovery link saved",
        ),
      );
      await waitFor(() => expect(dialogs()).toHaveLength(0));
      await waitFor(() =>
        expect(getCalls(CART_LINKS_PATH).length).toBeGreaterThan(before),
      );
    } finally {
      unmount(root);
    }
  });

  it("refuses a plaintext recovery URL in the field and sends nothing", async () => {
    const root = await mountRecovery();
    try {
      await click(buttonByText("New link"));
      const dialog = dialogContaining("New cart-recovery link");
      await type(q<HTMLInputElement>('input[id$="-cart"]', dialog), "cart_42");
      await type(
        q<HTMLInputElement>('input[id$="-url"]', dialog),
        "http://brand.myshopify.com/cart/c/zz",
      );
      await click(buttonByText("Save link", dialog));

      await waitFor(() =>
        expect(dialog.textContent).toContain(
          "Enter a valid HTTPS recovery URL without embedded username or password credentials.",
        ),
      );
      expect(postCalls(CART_LINKS_PATH)).toHaveLength(0);
      expect(dialogs().length).toBeGreaterThan(0);
    } finally {
      unmount(root);
    }
  });

  it("a refusal from the upsert route is rendered in the server's words and the draft stays open", async () => {
    // Only the POST is refused; the GET on the same path keeps working.
    postOverrides.set(CART_LINKS_PATH, () =>
      Promise.reject(
        new ApiError("recovery_url must be https", 400, undefined, {
          code: "invalid_request",
        }),
      ),
    );
    const root = await mountRecovery();
    try {
      await click(buttonByText("New link"));
      const dialog = dialogContaining("New cart-recovery link");
      await type(q<HTMLInputElement>('input[id$="-cart"]', dialog), "cart_42");
      await type(
        q<HTMLInputElement>('input[id$="-url"]', dialog),
        "https://brand.myshopify.com/cart/c/zz",
      );
      await click(buttonByText("Save link", dialog));

      await waitFor(() =>
        expect(dialog.textContent).toContain("recovery_url must be https"),
      );
      expect(mocks.toast.success).not.toHaveBeenCalled();
      expect(dialogs().length).toBeGreaterThan(0);
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-21 / 22: back-in-stock subscriptions ---------- */

describe("/app/commerce — back-in-stock subscriptions (commerce-21, commerce-22)", () => {
  it("lists the store's subscriptions with a status filter", async () => {
    const root = await mountRecovery();
    try {
      await pressTab(recoveryTab("Back in stock"));
      await waitFor(() => expect(getCalls(BACK_IN_STOCK_PATH)).toHaveLength(1));
      expect(getCalls(BACK_IN_STOCK_PATH)[0]).toEqual({
        query: { status: undefined, limit: 25, cursor: undefined },
      });
      await waitFor(() =>
        expect(text()).toContain("Subscription bis_1 · Subscriber sub_7"),
      );
      expect(text()).toContain("Product prod_1");
      expect(text()).toContain("Variant var_1");
      expect(text()).toContain("Waiting");
      expect(text()).not.toContain("jane@example.com");

      await click(
        statusChip("Filter back-in-stock subscriptions by status", "Eligible"),
      );
      await waitFor(() =>
        expect(getCalls(BACK_IN_STOCK_PATH).at(-1)).toEqual({
          query: { status: "eligible", limit: 25, cursor: undefined },
        }),
      );
      await waitFor(() =>
        expect(text()).toContain(
          "No back-in-stock subscriptions with status “Eligible”",
        ),
      );
    } finally {
      unmount(root);
    }
  });

  it("creates one against the PRODUCT-nested route with the subscriber email and optional variant", async () => {
    const root = await mountRecovery();
    try {
      await pressTab(recoveryTab("Back in stock"));
      await waitFor(() => expect(getCalls(BACK_IN_STOCK_PATH)).toHaveLength(1));
      const before = getCalls(BACK_IN_STOCK_PATH).length;

      await click(buttonByText("New subscription"));
      const dialog = dialogContaining("New back-in-stock subscription");
      await type(
        q<HTMLInputElement>('input[id$="-product"]', dialog),
        "prod_1",
      );
      await type(
        q<HTMLInputElement>('input[id$="-email"]', dialog),
        "Jane@Example.com",
      );
      await type(
        q<HTMLInputElement>('input[id$="-variant"]', dialog),
        " var_1 ",
      );
      await click(buttonByText("Create subscription", dialog));

      await waitFor(() =>
        expect(postCalls(BACK_IN_STOCK_CREATE_PATH)).toHaveLength(1),
      );
      const [, body] = postCalls(BACK_IN_STOCK_CREATE_PATH)[0]!;
      expect(body).toEqual({
        subscriber_email: "jane@example.com",
        variant_id: "var_1",
      });
      // The product id is in the PATH, never in the body.
      expect(body).not.toHaveProperty("product_id");
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Back-in-stock subscription created",
        ),
      );
      await waitFor(() =>
        expect(getCalls(BACK_IN_STOCK_PATH).length).toBeGreaterThan(before),
      );
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-23 / 24: price-drop watchers ---------- */

describe("/app/commerce — price-drop watchers (commerce-23, commerce-24)", () => {
  it("lists the store's watchers with their stored price rule", async () => {
    const root = await mountRecovery();
    try {
      await pressTab(recoveryTab("Price drops"));
      await waitFor(() => expect(getCalls(WATCHERS_PATH)).toHaveLength(1));
      expect(getCalls(WATCHERS_PATH)[0]).toEqual({
        query: { status: undefined, limit: 25, cursor: undefined },
      });
      await waitFor(() =>
        expect(text()).toContain("Watcher pdw_1 · Subscriber sub_7"),
      );
      expect(text()).toMatch(/Original \D*49[.,]00/u);
      expect(text()).toMatch(/Target \D*39[.,]00/u);
      expect(text()).toContain("Watching");

      await click(
        statusChip("Filter price-drop watchers by status", "Notified"),
      );
      await waitFor(() =>
        expect(getCalls(WATCHERS_PATH).at(-1)).toEqual({
          query: { status: "notified", limit: 25, cursor: undefined },
        }),
      );
    } finally {
      unmount(root);
    }
  });

  it("creates one with the target amount converted to integer cents and the currency upper-cased", async () => {
    const root = await mountRecovery();
    try {
      await pressTab(recoveryTab("Price drops"));
      await waitFor(() => expect(getCalls(WATCHERS_PATH)).toHaveLength(1));

      await click(buttonByText("New watcher"));
      const dialog = dialogContaining("New price-drop watcher");
      await type(
        q<HTMLInputElement>('input[id$="-product"]', dialog),
        "prod_1",
      );
      await type(
        q<HTMLInputElement>('input[id$="-email"]', dialog),
        "sam@example.com",
      );
      await type(q<HTMLInputElement>('input[id$="-target"]', dialog), "39.00");
      await type(q<HTMLInputElement>('input[id$="-currency"]', dialog), "eur");
      await click(buttonByText("Create watcher", dialog));

      await waitFor(() =>
        expect(postCalls(WATCHER_CREATE_PATH)).toHaveLength(1),
      );
      const [, body] = postCalls(WATCHER_CREATE_PATH)[0]!;
      expect(body).toEqual({
        subscriber_email: "sam@example.com",
        target_price_cents: 3900,
        currency: "EUR",
      });
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Price-drop watcher created",
        ),
      );
    } finally {
      unmount(root);
    }
  });

  it("refuses a sub-cent target price in the field and sends nothing", async () => {
    const root = await mountRecovery();
    try {
      await pressTab(recoveryTab("Price drops"));
      await waitFor(() => expect(getCalls(WATCHERS_PATH)).toHaveLength(1));

      await click(buttonByText("New watcher"));
      const dialog = dialogContaining("New price-drop watcher");
      await type(
        q<HTMLInputElement>('input[id$="-product"]', dialog),
        "prod_1",
      );
      await type(
        q<HTMLInputElement>('input[id$="-email"]', dialog),
        "sam@example.com",
      );
      await type(q<HTMLInputElement>('input[id$="-target"]', dialog), "39.999");
      await click(buttonByText("Create watcher", dialog));

      await waitFor(() =>
        expect(dialog.textContent).toContain(
          "Enter a positive target price with no more than two decimal places.",
        ),
      );
      expect(postCalls(WATCHER_CREATE_PATH)).toHaveLength(0);
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-25: the lifecycle report ---------- */

describe("/app/commerce — lifecycle report (commerce-25)", () => {
  it("reads the selected store's report and renders totals, the notify backlog and the 30-day event counts; Refresh report re-reads it", async () => {
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      expect(getCalls(REPORT_PATH)).toHaveLength(1);
      expect(getCalls(REPORT_PATH)[0]).toBeUndefined();

      const table = q<HTMLElement>(
        `[role="region"][aria-label="Lifecycle subscription status for ${SHOP}"]`,
      );
      expect(table.textContent).toContain("active 9 · converted 3");
      expect(table.textContent).toContain("notified 1 · waiting 4");
      expect(table.textContent).toContain("watching 2");

      const summary = q<HTMLElement>(
        'dl[aria-label="Lifecycle report summary"]',
      );
      expect(summary.textContent).toContain("Eligible in last 30 days");
      expect(summary.textContent).toContain("7");
      expect(summary.textContent).toContain("Awaiting notification");
      expect(summary.textContent).toContain("3");

      const events = q<HTMLElement>(
        'ul[aria-label="Commerce event counts in the last 30 days"]',
      );
      // Sorted by count, descending — the busiest event reads first.
      expect(events.textContent).toContain("Order Created 31");
      expect(events.textContent).toContain("Back In Stock Eligible 4");

      await click(buttonByText("Refresh report"));
      await waitFor(() => expect(getCalls(REPORT_PATH)).toHaveLength(2));
    } finally {
      unmount(root);
    }
  });

  it("a report whose shape the handler does not document is refused instead of rendered as totals", async () => {
    overrides.set(REPORT_PATH, () =>
      Promise.resolve({ ...REPORT, notified_pending: "three" }),
    );
    const root = await mountLifecycle();
    try {
      await waitFor(() =>
        expect(text()).toContain(
          "The service returned an invalid lifecycle report. Retry before acting on these totals.",
        ),
      );
      expect(reportSummary()).toBeNull();
      expect(text()).not.toContain("active 9 · converted 3");
    } finally {
      unmount(root);
    }
  });

  it("a report belonging to another store is refused, so no store's totals are shown under the wrong name", async () => {
    overrides.set(REPORT_PATH, () =>
      Promise.resolve({ ...REPORT, integration_id: "int_2" }),
    );
    const root = await mountLifecycle();
    try {
      await waitFor(() =>
        expect(text()).toContain(
          "The service returned a report for another store. No totals are shown; retry to restore verified store context.",
        ),
      );
      expect(reportSummary()).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("a refusal on the report renders the server's sentence with a retry", async () => {
    overrides.set(REPORT_PATH, () =>
      Promise.reject(
        new ApiError("integration not found", 404, undefined, {
          code: "not_found",
        }),
      ),
    );
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("integration not found"));
      // The catalogs reading of a 404 would blame the whole feature; this is a
      // per-store route, so the server's own sentence stands.
      expect(text()).not.toContain(
        "Commerce catalogs are not enabled on this Moosewave server.",
      );
      expect(reportSummary()).toBeNull();
      expect(buttonByText("Retry lifecycle report")).toBeTruthy();
    } finally {
      unmount(root);
    }
  });

  it("a failed REFRESH keeps the last report on screen and says the totals are the last successfully loaded ones", async () => {
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      overrides.set(REPORT_PATH, () =>
        Promise.reject(
          new ApiError("lifecycle report temporarily unavailable", 503),
        ),
      );
      await click(buttonByText("Refresh report"));

      await waitFor(() =>
        expect(text()).toContain("lifecycle report temporarily unavailable"),
      );
      expect(text()).toContain(
        "Showing the last successfully loaded lifecycle report.",
      );
      // The stale totals are still there — labelled, not silently current.
      expect(reportSummary()).not.toBeNull();
    } finally {
      unmount(root);
    }
  });
});

/* ---------- commerce-26: evaluate eligibility ---------- */

describe("/app/commerce — evaluate eligibility (commerce-26)", () => {
  it("confirms with the store's name and what changes, posts the evaluate route once, summarizes the acknowledgement counters and re-reads the report", async () => {
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      await click(buttonByText("Evaluate eligibility"));

      const dialog = dialogContaining("Evaluate eligibility for");
      expect(dialog.textContent).toContain(`Evaluate eligibility for ${SHOP}?`);
      expect(dialog.textContent).toContain(
        "Pending back-in-stock and price-drop subscriptions for this store are checked against current inventory and price history; qualifying records may become eligible to notify.",
      );
      expect(dialog.textContent).toContain(
        "a completed evaluation does not prove any notification was queued, sent, or delivered",
      );

      await click(buttonByText("Run evaluation", dialog));

      await waitFor(() => expect(postCalls(EVALUATE_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(EVALUATE_PATH)[0]!;
      expect(body).toEqual({});
      // One attempt: a transport retry could run the evaluation twice.
      expectLiveAdminOptions(opts, { timeoutMs: 30_000 });
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          "Evaluation finished: 4 back-in-stock and 2 price-drop subscriptions are now eligible to notify.",
          expect.objectContaining({
            description: expect.stringContaining(
              "not notification or delivery evidence",
            ) as unknown as string,
          }),
        ),
      );
      await waitFor(() => expect(getCalls(REPORT_PATH)).toHaveLength(2));
      await waitFor(() => expect(dialogs()).toHaveLength(0));
    } finally {
      unmount(root);
    }
  });

  it("a 200 without the acknowledgement counters is reported as ambiguous, not as a success, and the report is re-read anyway", async () => {
    postOverrides.set(EVALUATE_PATH, () => Promise.resolve({ ok: true }));
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      await click(buttonByText("Evaluate eligibility"));
      await click(
        buttonByText(
          "Run evaluation",
          dialogContaining("Evaluate eligibility for"),
        ),
      );

      await waitFor(() =>
        expect(mocks.toast.error).toHaveBeenCalledWith(
          "Evaluation acknowledgement incomplete",
          expect.objectContaining({
            description: expect.stringContaining(
              "counters could not be verified",
            ) as unknown as string,
          }),
        ),
      );
      expect(mocks.toast.success).not.toHaveBeenCalled();
      await waitFor(() => expect(getCalls(REPORT_PATH)).toHaveLength(2));
    } finally {
      unmount(root);
    }
  });

  it("a denial renders the server's sentence inside the confirm and the dialog stays open", async () => {
    postOverrides.set(EVALUATE_PATH, () =>
      Promise.reject(
        new ApiError("admin scope required", 403, undefined, {
          code: "forbidden",
        }),
      ),
    );
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      await click(buttonByText("Evaluate eligibility"));
      const dialog = dialogContaining("Evaluate eligibility for");
      await click(buttonByText("Run evaluation", dialog));

      await waitFor(() =>
        expect(q<HTMLElement>('[role="alert"]', dialog).textContent).toContain(
          "admin scope required",
        ),
      );
      expect(dialogs().length).toBeGreaterThan(0);
      expect(mocks.toast.success).not.toHaveBeenCalled();
      // A failed evaluation changed nothing, so the report is not re-read.
      expect(getCalls(REPORT_PATH)).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("a viewer is not offered the evaluate verb and is told who can run it", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const root = await mountLifecycle();
    try {
      await waitFor(() => expect(text()).toContain("Cart recovery"));
      expect(maybeButtonByText("Evaluate eligibility")).toBeUndefined();
      expect(text()).toContain(
        "an owner or admin outside viewer mode runs eligibility evaluation",
      );
      // The read verb stays available to a viewer.
      expect(buttonByText("Refresh report")).toBeTruthy();
    } finally {
      unmount(root);
    }
  });
});
