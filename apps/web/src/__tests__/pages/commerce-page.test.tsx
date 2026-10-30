// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/commerce — the Commerce workspace (commerce-13/14/15/16/17/18 and
// commerce-3). Every assertion is on the CONSEQUENCE of a verb: the request's
// method + path + body (+ transport options where the contract depends on
// them), the rendered result, or the confirm's copy. `@/lib/api` is mocked at
// the transport so the literal "/api/v1/…" paths the page sends are what is
// asserted, not a friendlier wrapper.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { COMMERCE_ADMIN_ONLY_MESSAGE } from "@/lib/commerce-authority";

import { importBeforeTests, waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  replace: vi.fn(),
  search: { current: "" },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  windowOpen: vi.fn(),
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

const CATALOGS_PATH = "/api/v1/commerce/catalogs";
const INTEGRATIONS_PATH = "/api/v1/commerce/integrations";
const FEEDS_PATH = "/api/v1/commerce/catalogs/cat_1/feeds";
const IMPORT_PATH = "/api/v1/commerce/catalogs/cat_1/import";
const RESOLVE_PATH = "/api/v1/commerce/catalogs/cat_1/feeds/feed_1/resolve";
const OAUTH_START_PATH = "/api/v1/commerce/shopify/oauth/start";
const SHOP = "brand.myshopify.com";

const CAT_1 = {
  id: "cat_1",
  integration_id: "int_1",
  name: "Spring collection",
  source_type: "integration",
  status: "active",
  default_currency: "USD",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
};
const CAT_2 = {
  ...CAT_1,
  id: "cat_2",
  name: "Winter warmers",
  status: "paused",
};
const CAT_3 = { ...CAT_1, id: "cat_3", name: "Archive 2025" };

const CATALOG_PAGE_1 = { items: [CAT_1, CAT_2], next_cursor: "cur_2" };
const CATALOG_PAGE_2 = { items: [CAT_3] };

const INTEGRATIONS = [
  {
    id: "int_1",
    provider: "shopify",
    shop_domain: SHOP,
    status: "connected",
    scopes: [],
    settings: {},
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
  },
];

const FEED_1 = {
  id: "feed_1",
  catalog_id: "cat_1",
  name: "Best sellers",
  feed_type: "recent",
  status: "draft",
  criteria: {},
  fallback: {},
  max_items: 6,
  exclude_out_of_stock: true,
  created_at: "2026-08-02T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
};

const IMPORT_SUMMARY = {
  catalog_id: "cat_1",
  integration_id: "int_1",
  products_seen: 2,
  products_upserted: 2,
  catalog_items_upserted: 2,
  products_skipped: 0,
  imported_at: "2026-09-01T10:00:00Z",
};

const RESOLVED = {
  feed_id: "feed_1",
  catalog_id: "cat_1",
  feed_type: "recent",
  exclude_out_of_stock: true,
  total: 1,
  page: 1,
  per_page: 6,
  items: [
    {
      product_id: "prod_1",
      source_id: "src_1",
      title: "Enamel mug",
      price_cents: 1900,
      currency: "USD",
      available: true,
      reason: "recently added",
      rank: 1,
    },
  ],
};

// What buildShopifyAuthorizeURL mints when credentials are configured.
const OAUTH_OK = {
  provider: "shopify",
  shop_domain: SHOP,
  authorize_url: `https://${SHOP}/admin/oauth/authorize?client_id=abc&scope=read_products&state=s1`,
  state: "s1",
  scopes: ["read_products"],
  local: false,
};
const oauthResponse: { current: typeof OAUTH_OK } = { current: OAUTH_OK };

function stubTransport(): void {
  mocks.apiGet.mockImplementation(
    (path: string, opts?: { query?: Record<string, unknown> }) => {
      if (path === CATALOGS_PATH) {
        const cursor = opts?.query?.cursor;
        if (cursor === undefined) return Promise.resolve(CATALOG_PAGE_1);
        if (cursor === "cur_2") return Promise.resolve(CATALOG_PAGE_2);
        return Promise.reject(new Error(`Unexpected cursor ${String(cursor)}`));
      }
      if (path === INTEGRATIONS_PATH) return Promise.resolve(INTEGRATIONS);
      if (path === FEEDS_PATH) return Promise.resolve({ items: [FEED_1] });
      if (path === OAUTH_START_PATH)
        return Promise.resolve(oauthResponse.current);
      return Promise.reject(new Error(`Unexpected GET ${path}`));
    },
  );
  mocks.apiPost.mockImplementation((path: string, body?: unknown) => {
    if (path === CATALOGS_PATH) {
      return Promise.resolve({
        ...CAT_1,
        id: "cat_new",
        ...(body as Record<string, unknown>),
      });
    }
    if (path === IMPORT_PATH) return Promise.resolve(IMPORT_SUMMARY);
    if (path === FEEDS_PATH) {
      return Promise.resolve({
        ...FEED_1,
        id: "feed_new",
        ...(body as Record<string, unknown>),
      });
    }
    if (path === RESOLVE_PATH) {
      const email = (body as { subscriber_email?: string } | undefined)
        ?.subscriber_email;
      return Promise.resolve(
        email ? { ...RESOLVED, subscriber_email: email } : RESOLVED,
      );
    }
    return Promise.reject(new Error(`Unexpected POST ${path}`));
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

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await flush();
  });
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
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

function unmount(root: Root): void {
  act(() => root.unmount());
}

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/commerce/page"),
);

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  oauthResponse.current = OAUTH_OK;
  stubTransport();
  Object.defineProperty(window, "open", {
    value: mocks.windowOpen,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/* ---------- Catalogs ---------- */

describe("/app/commerce — Catalogs tab", () => {
  it("commerce-13: lists catalogs through the cursor contract and pages Next/Previous", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      expect(getCalls(CATALOGS_PATH)[0]).toEqual({
        query: { limit: 25, cursor: undefined },
      });
      expect(text()).toContain("Winter warmers");
      expect(text()).toContain(
        "Page 1 · 2 items on this page; more are available.",
      );
      expect(buttonByLabel("Previous page of catalogs").disabled).toBe(true);

      await click(buttonByLabel("Next page of catalogs"));
      await waitFor(() => expect(text()).toContain("Archive 2025"));
      expect(getCalls(CATALOGS_PATH).at(-1)).toEqual({
        query: { limit: 25, cursor: "cur_2" },
      });
      expect(text()).toContain("Page 2 · 1 item on this page.");
      expect(text()).not.toContain("Spring collection");
      expect(buttonByLabel("Next page of catalogs").disabled).toBe(true);

      await click(buttonByLabel("Previous page of catalogs"));
      await waitFor(() => expect(text()).toContain("Spring collection"));
      expect(text()).toContain("Page 1 · 2 items on this page");
      expect(text()).not.toContain("Archive 2025");
    } finally {
      unmount(root);
    }
  });

  it("commerce-14: New catalog posts name, connected store and normalized currency, then refreshes the list", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      const listCallsBefore = getCalls(CATALOGS_PATH).length;

      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await waitFor(() => expect(getCalls(INTEGRATIONS_PATH)).toHaveLength(1));
      await waitFor(() =>
        expect(
          q<HTMLSelectElement>('select[id$="-integration"]', dialog).value,
        ).toBe("int_1"),
      );
      expect(dialog.textContent).toContain(`${SHOP} · shopify`);

      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "  Autumn drop ",
      );
      await type(q<HTMLInputElement>('input[id$="-currency"]', dialog), "eur");
      await click(buttonByText("Create catalog", dialog));

      await waitFor(() => expect(postCalls(CATALOGS_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(CATALOGS_PATH)[0]!;
      expect(body).toEqual({
        name: "Autumn drop",
        source_type: "integration",
        integration_id: "int_1",
        default_currency: "EUR",
      });
      expectLiveAdminOptions(opts);
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          'Catalog "Autumn drop" created',
        ),
      );
      await waitFor(() => expect(dialogs()).toHaveLength(0));
      await waitFor(() =>
        expect(getCalls(CATALOGS_PATH).length).toBeGreaterThan(listCallsBefore),
      );
    } finally {
      unmount(root);
    }
  });

  it("commerce-14: closing a dirty catalog draft asks first, names what is lost, and posts nothing", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "Half-typed",
      );
      await click(buttonByText("Cancel", dialog));

      const confirm = dialogContaining("Discard product catalog draft?");
      expect(confirm.textContent).toContain(
        "The catalog name, connected store, and currency will be cleared. Nothing has been created.",
      );
      await click(buttonByText("Discard draft", confirm));
      await waitFor(() => expect(dialogs()).toHaveLength(0));
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("commerce-14: a server refusal is rendered in the server's words and the draft stays open", async () => {
    mocks.apiPost.mockImplementationOnce(() =>
      Promise.reject(
        new ApiError(
          "Only an owner or admin can create catalogs.",
          403,
          undefined,
          {
            code: "forbidden",
          },
        ),
      ),
    );
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await waitFor(() =>
        expect(
          q<HTMLSelectElement>('select[id$="-integration"]', dialog).value,
        ).toBe("int_1"),
      );
      await type(q<HTMLInputElement>('input[id$="-name"]', dialog), "Refused");
      await click(buttonByText("Create catalog", dialog));
      await waitFor(() =>
        expect(dialogContaining("New catalog").textContent).toContain(
          "Only an owner or admin can create catalogs.",
        ),
      );
      expect(mocks.toast.success).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("re-checks exact admin authority beside the catalog write and blocks a fresh downgrade", async () => {
    mocks.whoamiFresh.mockResolvedValue(VIEWER);
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await waitFor(() =>
        expect(
          q<HTMLSelectElement>('select[id$="-integration"]', dialog).value,
        ).toBe("int_1"),
      );
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "Fresh refusal",
      );
      await click(buttonByText("Create catalog", dialog));

      await waitFor(() =>
        expect(dialogContaining("New catalog").textContent).toContain(
          "commerce administration authority changed",
        ),
      );
      expect(postCalls(CATALOGS_PATH)).toHaveLength(0);
      expect(mocks.toast.success).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("locks the catalog action synchronously so two same-tick submissions share one write", async () => {
    let resolveFresh!: (identity: typeof OWNER) => void;
    mocks.whoamiFresh.mockImplementation(
      () =>
        new Promise<typeof OWNER>((resolve) => {
          resolveFresh = resolve;
        }),
    );
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await waitFor(() =>
        expect(
          q<HTMLSelectElement>('select[id$="-integration"]', dialog).value,
        ).toBe("int_1"),
      );
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "One write",
      );
      const submit = buttonByText("Create catalog", dialog);
      act(() => {
        submit.click();
        submit.click();
      });

      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(postCalls(CATALOGS_PATH)).toHaveLength(0);
      await act(async () => {
        resolveFresh(OWNER);
        await flush();
      });
      await waitFor(() => expect(postCalls(CATALOGS_PATH)).toHaveLength(1));
      await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledTimes(1));
    } finally {
      unmount(root);
    }
  });

  it("does not report success when a catalog receipt describes another result", async () => {
    mocks.apiPost.mockResolvedValueOnce({
      ...CAT_1,
      id: "cat_other",
      name: "Another catalog",
    });
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("New catalog"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("New catalog"));
      const dialog = dialogContaining("New catalog");
      await waitFor(() =>
        expect(
          q<HTMLSelectElement>('select[id$="-integration"]', dialog).value,
        ).toBe("int_1"),
      );
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "Requested catalog",
      );
      await click(buttonByText("Create catalog", dialog));

      await waitFor(() =>
        expect(dialogContaining("New catalog").textContent).toContain(
          "returned record did not match the submitted catalog",
        ),
      );
      expect(mocks.toast.success).not.toHaveBeenCalled();
      expect(dialogs()).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });

  it("commerce-15: Import products posts the pasted batch once with a long timeout and renders the 202 summary verbatim", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      const listCallsBefore = getCalls(CATALOGS_PATH).length;
      await click(buttonByLabel("Import products into Spring collection"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() =>
        dialogContaining("Import products — Spring collection"),
      );
      const dialog = dialogContaining("Import products — Spring collection");
      expect(dialog.textContent).toContain("up to 1,000 product objects");

      const products = [
        { source_id: "p1", title: "Mug", price_cents: 1900, currency: "USD" },
        { source_id: "p2", title: "Tote", price_cents: 2400, currency: "USD" },
      ];
      await type(
        q<HTMLTextAreaElement>('textarea[id$="-json"]', dialog),
        JSON.stringify(products),
      );
      await click(q<HTMLButtonElement>('button[type="submit"]', dialog));

      await waitFor(() => expect(postCalls(IMPORT_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(IMPORT_PATH)[0]!;
      expect(body).toEqual({ products });
      expectLiveAdminOptions(opts, { timeoutMs: 60_000 });

      const summary =
        "Import completed: 2 seen, 2 products upserted, 2 catalog items, 0 skipped.";
      await waitFor(() =>
        expect(
          dialogContaining("Import products — Spring collection").textContent,
        ).toContain(summary),
      );
      expect(mocks.toast.success).toHaveBeenCalledWith(summary);
      await waitFor(() =>
        expect(getCalls(CATALOGS_PATH).length).toBeGreaterThan(listCallsBefore),
      );
      // Import is done: the dialog now offers only "Done", no re-submit.
      const done = dialogContaining("Import products — Spring collection");
      expect(done.querySelector('button[type="submit"]')).toBeNull();
      await click(buttonByText("Done", done));
      await waitFor(() => expect(dialogs()).toHaveLength(0));
    } finally {
      unmount(root);
    }
  });

  it("commerce-15: a batch over the client bound is refused with the sentence, before any request", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByLabel("Import products into Spring collection"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() =>
        dialogContaining("Import products — Spring collection"),
      );
      const dialog = dialogContaining("Import products — Spring collection");
      const many = Array.from({ length: 1001 }, (_, i) => ({
        source_id: `p${i}`,
      }));
      await type(
        q<HTMLTextAreaElement>('textarea[id$="-json"]', dialog),
        JSON.stringify(many),
      );
      await click(q<HTMLButtonElement>('button[type="submit"]', dialog));
      await waitFor(() =>
        expect(q<HTMLElement>('[role="alert"]', dialog).textContent).toMatch(
          /^This batch contains 1[,.  ]?001 products\. Split it into batches of 1[,.  ]?000 or fewer\.$/u,
        ),
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("commerce-15: replacement mode requires a second confirmation that names the consequence, then posts replace: true", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByLabel("Import products into Spring collection"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() =>
        dialogContaining("Import products — Spring collection"),
      );
      const dialog = dialogContaining("Import products — Spring collection");
      const products = [
        { source_id: "p1", title: "Mug", price_cents: 1900, currency: "USD" },
      ];
      await type(
        q<HTMLTextAreaElement>('textarea[id$="-json"]', dialog),
        JSON.stringify(products),
      );
      await click(q<HTMLInputElement>('input[type="checkbox"]', dialog));
      expect(
        q<HTMLButtonElement>(
          'button[type="submit"]',
          dialog,
        ).textContent?.trim(),
      ).toBe("Review replacement import");
      await click(q<HTMLButtonElement>('button[type="submit"]', dialog));
      expect(mocks.apiPost).not.toHaveBeenCalled();

      const confirm = dialogContaining(
        "Replace products in Spring collection?",
      );
      expect(confirm.textContent).toContain(
        "may remove existing catalog membership that is absent from the pasted payload",
      );
      await click(buttonByText("Import and replace", confirm));
      await waitFor(() => expect(postCalls(IMPORT_PATH)).toHaveLength(1));
      expect(postCalls(IMPORT_PATH)[0]![1]).toEqual({
        products,
        replace: true,
      });
    } finally {
      unmount(root);
    }
  });
});

/* ---------- Feeds ---------- */

describe("/app/commerce — Feeds tab", () => {
  it("commerce-16: Feeds on a catalog row switches tab, mirrors the URL, and lists that catalog's feeds", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByLabel("Show product feeds for Spring collection"));
      expect(mocks.replace).toHaveBeenCalledWith(
        "/app/commerce?tab=feeds&catalog=cat_1",
        {
          scroll: false,
        },
      );
      await waitFor(() => expect(text()).toContain("Best sellers"));
      expect(getCalls(FEEDS_PATH)[0]).toEqual({
        query: { limit: 25, cursor: undefined },
      });
      expect(q<HTMLSelectElement>('select[id$="-catalog"]').value).toBe(
        "cat_1",
      );
      expect(text()).toContain("Maximum 6 items");
      expect(text()).toContain("Out-of-stock products excluded");
      expect(text()).toContain("Draft");
    } finally {
      unmount(root);
    }
  });

  it("commerce-16: a shared ?tab=feeds&catalog= URL opens straight onto that catalog's feeds", async () => {
    const root = await mountPage("tab=feeds&catalog=cat_1");
    try {
      await waitFor(() => expect(text()).toContain("Best sellers"));
      expect(getCalls(FEEDS_PATH)).toHaveLength(1);
      expect(q<HTMLSelectElement>('select[id$="-catalog"]').value).toBe(
        "cat_1",
      );
      expect(
        [...document.querySelectorAll('[role="tab"]')].find(
          (t) => t.getAttribute("aria-selected") === "true",
        )?.textContent,
      ).toBe("Feeds");
    } finally {
      unmount(root);
    }
  });

  it("commerce-17: New feed posts name, type, bounded max_items and the stock policy to the catalog's feeds", async () => {
    const root = await mountPage("tab=feeds&catalog=cat_1");
    try {
      await waitFor(() => expect(text()).toContain("Best sellers"));
      const feedCallsBefore = getCalls(FEEDS_PATH).length;
      await click(buttonByText("New feed"));
      const dialog = dialogContaining("New product feed");
      await type(
        q<HTMLInputElement>('input[id$="-name"]', dialog),
        "Sale picks",
      );
      await choose(
        q<HTMLSelectElement>('select[id$="-type"]', dialog),
        "dynamic",
      );
      await type(q<HTMLInputElement>('input[id$="-max"]', dialog), "12");
      await click(q<HTMLInputElement>('input[type="checkbox"]', dialog)); // untick exclude
      await click(buttonByText("Create draft feed", dialog));

      await waitFor(() => expect(postCalls(FEEDS_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(FEEDS_PATH)[0]!;
      expect(body).toEqual({
        name: "Sale picks",
        feed_type: "dynamic",
        max_items: 12,
        exclude_out_of_stock: false,
      });
      expectLiveAdminOptions(opts);
      await waitFor(() =>
        expect(mocks.toast.success).toHaveBeenCalledWith(
          'Draft feed "Sale picks" created',
        ),
      );
      await waitFor(() => expect(dialogs()).toHaveLength(0));
      await waitFor(() =>
        expect(getCalls(FEEDS_PATH).length).toBeGreaterThan(feedCallsBefore),
      );
    } finally {
      unmount(root);
    }
  });

  it("commerce-17: max_items outside 1..50 is refused before any request", async () => {
    const root = await mountPage("tab=feeds&catalog=cat_1");
    try {
      await waitFor(() => expect(text()).toContain("Best sellers"));
      await click(buttonByText("New feed"));
      const dialog = dialogContaining("New product feed");
      await type(q<HTMLInputElement>('input[id$="-name"]', dialog), "Too many");
      const max = q<HTMLInputElement>('input[id$="-max"]', dialog);

      // The bound is on the field itself (min=1, max=50, step=1), so the
      // browser refuses an over-limit value before the handler runs.
      await type(max, "51");
      expect(max.max).toBe("50");
      expect(max.checkValidity()).toBe(false);
      await click(buttonByText("Create draft feed", dialog));
      expect(mocks.apiPost).not.toHaveBeenCalled();

      // A cleared field passes native validation and meets the same bound in
      // the handler, which names it.
      await type(max, "");
      expect(max.checkValidity()).toBe(true);
      await click(buttonByText("Create draft feed", dialog));
      await waitFor(() =>
        expect(q<HTMLElement>('[role="alert"]', dialog).textContent).toBe(
          "Maximum items must be a whole number from 1 through 50.",
        ),
      );
      expect(mocks.apiPost).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("commerce-18: Resolve preview posts to the feed's resolve route without an idempotency key, renders rows verbatim, and sends the subscriber email when supplied", async () => {
    const root = await mountPage("tab=feeds&catalog=cat_1");
    try {
      await waitFor(() => expect(text()).toContain("Best sellers"));
      await click(buttonByLabel("Resolve a preview of Best sellers"));
      await waitFor(() => expect(postCalls(RESOLVE_PATH)).toHaveLength(1));
      const [, body, opts] = postCalls(RESOLVE_PATH)[0]!;
      expect(body).toEqual({});
      expect(opts).toEqual({ idempotencyKey: null });

      const dialog = dialogContaining("Resolve preview — Best sellers");
      await waitFor(() => expect(dialog.textContent).toContain("Enamel mug"));
      expect(dialog.textContent).toContain("Product prod_1 · Source src_1");
      expect(dialog.textContent).toContain("recently added");
      expect(dialog.textContent).toMatch(/19[.,]00/u);
      expect(dialog.textContent).toContain("Available");
      expect(dialog.textContent).toContain(
        "Preview represents the non-personalized resolver. No message was sent.",
      );

      await type(
        q<HTMLInputElement>('input[id$="-email"]', dialog),
        " Customer@Example.com ",
      );
      expect(dialog.textContent).toContain("The email draft has changed.");
      await click(q<HTMLButtonElement>('button[type="submit"]', dialog));
      await waitFor(() => expect(postCalls(RESOLVE_PATH)).toHaveLength(2));
      expect(postCalls(RESOLVE_PATH)[1]![1]).toEqual({
        subscriber_email: "customer@example.com",
      });
      await waitFor(() =>
        expect(
          dialogContaining("Resolve preview — Best sellers").textContent,
        ).toContain(
          "Preview represents the submitted subscriber context (customer@example.com). No message was sent.",
        ),
      );
    } finally {
      unmount(root);
    }
  });
});

/* ---------- Connect Shopify ---------- */

describe("/app/commerce — Connect Shopify (commerce-3)", () => {
  it("asks the server for the authorize link for the normalized shop and opens only the verified URL in a new tab", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("Connect Shopify"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("Connect Shopify"));
      const dialog = dialogContaining("Connect Shopify");
      await waitFor(() => expect(dialog.textContent).toContain(`${SHOP}`));
      await type(
        q<HTMLInputElement>('input[id$="-shop"]', dialog),
        "  Brand.MyShopify.com ",
      );
      await click(buttonByText("Open Shopify authorization", dialog));

      await waitFor(() => expect(getCalls(OAUTH_START_PATH)).toHaveLength(1));
      expect(getCalls(OAUTH_START_PATH)[0]).toEqual(
        expect.objectContaining({
          cache: "no-store",
          requireOnline: true,
          maxAttempts: 1,
          signal: expect.any(AbortSignal),
          query: { shop: SHOP },
        }),
      );
      await waitFor(() => expect(mocks.windowOpen).toHaveBeenCalledTimes(1));
      expect(mocks.windowOpen).toHaveBeenCalledWith(
        OAUTH_OK.authorize_url,
        "_blank",
        "noopener",
      );
      const after = dialogContaining("Connect Shopify");
      expect(after.textContent).toContain(
        `Authorization link ready for ${SHOP}`,
      );
      expect(after.textContent).toContain("If your browser did not open a tab");
      expect(q<HTMLAnchorElement>('a[target="_blank"]', after).href).toBe(
        OAUTH_OK.authorize_url,
      );
      expect(buttonByText("Refresh stores", after)).toBeTruthy();
    } finally {
      unmount(root);
    }
  });

  it("refuses an authorize URL that fails the Shopify safety check and opens no tab", async () => {
    oauthResponse.current = {
      ...OAUTH_OK,
      authorize_url: `https://${SHOP}.evil.example/admin/oauth/authorize?state=s1`,
    };
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("Connect Shopify"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("Connect Shopify"));
      const dialog = dialogContaining("Connect Shopify");
      await type(q<HTMLInputElement>('input[id$="-shop"]', dialog), SHOP);
      await click(buttonByText("Open Shopify authorization", dialog));
      await waitFor(() => expect(getCalls(OAUTH_START_PATH)).toHaveLength(1));
      await waitFor(() =>
        expect(dialogContaining("Connect Shopify").textContent).toContain(
          "The authorization destination failed the Shopify safety check. No browser tab was opened.",
        ),
      );
      expect(mocks.windowOpen).not.toHaveBeenCalled();
      expect(dialogContaining("Connect Shopify").textContent).not.toContain(
        "Authorization opened in a new tab",
      );
    } finally {
      unmount(root);
    }
  });

  it("refuses a plaintext downgrade the same way", async () => {
    oauthResponse.current = {
      ...OAUTH_OK,
      authorize_url: `http://${SHOP}/admin/oauth/authorize?state=s1`,
    };
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("Connect Shopify"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("Connect Shopify"));
      const dialog = dialogContaining("Connect Shopify");
      await type(q<HTMLInputElement>('input[id$="-shop"]', dialog), SHOP);
      await click(buttonByText("Open Shopify authorization", dialog));
      await waitFor(() =>
        expect(dialogContaining("Connect Shopify").textContent).toContain(
          "failed the Shopify safety check",
        ),
      );
      expect(mocks.windowOpen).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("a shop that is not a bare *.myshopify.com host never reaches the server", async () => {
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      await click(buttonByText("Connect Shopify"));
      // The dialog is a deferred module; wait for it to mount after the click.
      await waitFor(() => dialogContaining("Connect Shopify"));
      const dialog = dialogContaining("Connect Shopify");
      await type(
        q<HTMLInputElement>('input[id$="-shop"]', dialog),
        `https://${SHOP}/admin`,
      );
      await click(buttonByText("Open Shopify authorization", dialog));
      await waitFor(() =>
        expect(q<HTMLElement>('[role="alert"]', dialog).textContent).toContain(
          "Enter the store's *.myshopify.com domain",
        ),
      );
      expect(getCalls(OAUTH_START_PATH)).toHaveLength(0);
      expect(mocks.windowOpen).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});

/* ---------- role gating ---------- */

describe("/app/commerce — role gating", () => {
  it("withholds every admin verb from a viewer with the reason, while reads and the read-scope resolve stay available", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      expect(getCalls(CATALOGS_PATH)).toHaveLength(1);
      expect(text()).toContain(COMMERCE_ADMIN_ONLY_MESSAGE);
      expect(maybeButtonByText("New catalog")).toBeUndefined();
      expect(maybeButtonByText("Connect Shopify")).toBeUndefined();
      expect(
        document.querySelector(
          'button[aria-label="Import products into Spring collection"]',
        ),
      ).toBeNull();
      // The read verb on the row is still offered.
      expect(
        buttonByLabel("Show product feeds for Spring collection"),
      ).toBeTruthy();
    } finally {
      unmount(root);
    }

    const feeds = await mountPage("tab=feeds&catalog=cat_1");
    try {
      await waitFor(() => expect(text()).toContain("Best sellers"));
      expect(maybeButtonByText("New feed")).toBeUndefined();
      expect(buttonByLabel("Resolve a preview of Best sellers")).toBeTruthy();
    } finally {
      unmount(feeds);
    }
  });

  it("an owner in viewer mode is treated as a viewer", async () => {
    mocks.whoami.mockResolvedValue({ ...OWNER, viewer_mode: true });
    const root = await mountPage("");
    try {
      await waitFor(() => expect(text()).toContain("Spring collection"));
      expect(text()).toContain(COMMERCE_ADMIN_ONLY_MESSAGE);
      expect(maybeButtonByText("New catalog")).toBeUndefined();
      expect(maybeButtonByText("Connect Shopify")).toBeUndefined();
    } finally {
      unmount(root);
    }
  });
});
