// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/translations could READ settings, the dictionary and a hard-coded
// French preview, and could write none of them. These assert the three writes
// it now makes AT THE WIRE — method, path, and body — because a spy on the
// client function proves a callback ran, not that a request left the browser.
//
// Two of them are gated differently on purpose and the difference is tested:
// PUT /settings is ScopeAdmin (enabling translation bills a gateway request
// per body and locale), while the dictionary is ScopeWriteCampaigns, which an
// editor holds. Showing one gate for both would either hide the dictionary
// from editors or hand them a settings form that only 403s.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/translations",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

import TranslationsPage from "@/app/(dashboard)/app/translations/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@postwave.test",
  role: "owner" as const,
  effective_role: "owner" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
};

const SETTINGS = {
  tenant_id: "tenant-1",
  enabled: false,
  default_locale: "en",
  supported_locales: ["en"],
  fallback_strategy: "subscriber_locale",
  locale_attribute: "language",
  updated_at: "0001-01-01T00:00:00Z",
};

const ENTRY = {
  id: "entry-1",
  term: "Moosewave",
  translations: { fr: "Moosewave" },
  case_sensitive: false,
  notes: "",
  updated_at: "2026-01-02T03:04:05Z",
};

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

let calls: RecordedCall[] = [];

/**
 * Answers 200 from a (method, path) table and records every call.
 *
 * 200 rather than a 404, deliberately: the question in each test below is
 * whether the write was ATTEMPTED with the right shape. A rejection would make
 * error handling the variable instead.
 */
function transport(
  routes: Record<string, unknown> = {},
  overrides: Record<string, { status: number; body: unknown }> = {},
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
        .replace(/^https?:\/\/[^/]+/u, "")
        .split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({ method, path, body });
      const override = overrides[`${method} ${path}`];
      if (override) {
        return new Response(JSON.stringify(override.body), {
          status: override.status,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(routes[path] ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

const DEFAULT_ROUTES = {
  "/api/v1/translations/settings": SETTINGS,
  "/api/v1/translations/dictionary": { entries: [ENTRY] },
};

function writes(): string[] {
  return calls
    .filter((call) => call.method !== "GET" && call.method !== "HEAD")
    .map((call) => `${call.method} ${call.path}`);
}

function lastBody(method: string, path: string): unknown {
  const match = [...calls]
    .reverse()
    .find((call) => call.method === method && call.path === path);
  if (!match) throw new Error(`no ${method} ${path} was recorded`);
  return match.body;
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TranslationsPage),
      ),
    );
  });
  await settle();
  return { container, root };
}

async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function typeInto(
  element: Element | null,
  value: string,
  what: string,
): Promise<void> {
  if (!element) throw new Error(`no field to type into: ${what}`);
  const node = element as HTMLInputElement | HTMLTextAreaElement;
  const proto =
    node.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!setter) throw new Error("no native value setter available");
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function choose(
  element: Element | null,
  value: string,
  what: string,
): Promise<void> {
  if (!element) throw new Error(`no select to choose in: ${what}`);
  const node = element as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  if (!setter) throw new Error("no native value setter available");
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element | null, what: string): Promise<void> {
  if (!element) throw new Error(`no control to click: ${what}`);
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // A submit handler's await chain (fresh-authority check, then the write)
  // resolves several turns later; one flush records the click but not the
  // request it caused.
  await settle(4);
}

function byLabel(scope: ParentNode, label: string): HTMLElement | null {
  return [...scope.querySelectorAll<HTMLElement>("button")].find(
    (node) => (node.getAttribute("aria-label") ?? "") === label,
  ) ?? null;
}

function byText(scope: ParentNode, text: string): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>("button")].find(
      (node) => node.textContent?.trim() === text,
    ) ?? null
  );
}

function openDialog(): HTMLElement {
  const nodes = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (nodes.length === 0) throw new Error("no dialog is open");
  if (nodes.length > 1) throw new Error(`${nodes.length} dialogs are open`);
  return nodes[0]!;
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("tenant translation settings (PUT /api/v1/translations/settings)", () => {
  it("sends the whole edited settings body and reports what it stored", async () => {
    transport(DEFAULT_ROUTES, {
      "PUT /api/v1/translations/settings": {
        status: 200,
        body: {
          ...SETTINGS,
          enabled: true,
          supported_locales: ["en", "fr-CA"],
          fallback_strategy: "default_only",
          locale_attribute: "lang",
          updated_at: "2026-02-03T04:05:06Z",
        },
      },
    });
    const view = await mount();

    await click(
      view.container.querySelector("#translation-enabled"),
      "enable translations",
    );
    await typeInto(
      view.container.querySelector("#translation-supported-locales"),
      "en, fr-CA",
      "supported locales",
    );
    await typeInto(
      view.container.querySelector("#translation-locale-attribute"),
      "lang",
      "locale attribute",
    );
    await choose(
      view.container.querySelector("#translation-fallback"),
      "default_only",
      "fallback strategy",
    );
    await click(byText(view.container, "Save settings"), "save settings");

    expect(writes()).toEqual(["PUT /api/v1/translations/settings"]);
    expect(lastBody("PUT", "/api/v1/translations/settings")).toEqual({
      enabled: true,
      default_locale: "en",
      supported_locales: ["en", "fr-CA"],
      fallback_strategy: "default_only",
      locale_attribute: "lang",
    });
    // The confirmation names the consequence, and it names what the SERVER
    // stored — the endpoint deduplicates and back-fills the list.
    expect(view.container.textContent).toContain(
      "Sends are translated into en, fr-CA",
    );
    act(() => view.root.unmount());
  });

  it("re-checks authority against the live session before writing", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();
    await click(
      view.container.querySelector("#translation-enabled"),
      "enable translations",
    );
    await click(byText(view.container, "Save settings"), "save settings");
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    act(() => view.root.unmount());
  });

  it("names the offending field and sends nothing when a locale is malformed", async () => {
    // PUT validates the whole body and rejects it whole, so an unchecked typo
    // in one locale would discard the other four fields' edits.
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await typeInto(
      view.container.querySelector("#translation-supported-locales"),
      "en, f",
      "supported locales",
    );
    await click(byText(view.container, "Save settings"), "save settings");

    expect(writes()).toEqual([]);
    expect(
      view.container.querySelector('[role="alert"]')?.textContent,
    ).toContain('Supported locale "f"');
    act(() => view.root.unmount());
  });

  it("withholds the settings form from an editor and says which tier it needs", async () => {
    mocks.whoami.mockResolvedValue({
      ...OWNER,
      role: "editor",
      effective_role: "editor",
    });
    transport(DEFAULT_ROUTES);
    const view = await mount();

    expect(
      view.container.querySelector("#translation-supported-locales"),
    ).toBeNull();
    expect(view.container.textContent).toContain(
      "Admin or owner access is required to change them",
    );
    // …but the dictionary, which is ScopeWriteCampaigns, stays available.
    expect(view.container.querySelector("#dictionary-term")).not.toBeNull();
    act(() => view.root.unmount());
  });
});

describe("terminology dictionary writes", () => {
  it("POSTs the term with its locale pairs, case flag and notes", async () => {
    transport(DEFAULT_ROUTES, {
      "POST /api/v1/translations/dictionary": {
        status: 200,
        body: { id: "entry-2", term: "Pro plan" },
      },
    });
    const view = await mount();

    await typeInto(
      view.container.querySelector("#dictionary-term"),
      "Pro plan",
      "term",
    );
    await typeInto(
      view.container.querySelector("#dictionary-notes"),
      "Product name",
      "notes",
    );
    await click(
      view.container.querySelector("#dictionary-case-sensitive"),
      "case sensitive",
    );
    await typeInto(
      view.container.querySelector("#dictionary-pair-locale-0"),
      "fr",
      "pair locale",
    );
    await typeInto(
      view.container.querySelector("#dictionary-pair-value-0"),
      "Forfait Pro",
      "pair value",
    );
    await click(byText(view.container, "Save term"), "save term");

    expect(writes()).toEqual(["POST /api/v1/translations/dictionary"]);
    expect(lastBody("POST", "/api/v1/translations/dictionary")).toEqual({
      term: "Pro plan",
      translations: { fr: "Forfait Pro" },
      case_sensitive: true,
      notes: "Product name",
    });
    expect(view.container.textContent).toContain(
      '"Pro plan" saved with 1 locale replacement(s)',
    );
    act(() => view.root.unmount());
  });

  it("sends a term with no locale rows as a protected term and says so", async () => {
    // An empty translations map is the dictionary's primary use: leave this
    // term untouched. It must reach the server as {} rather than be dropped.
    transport(DEFAULT_ROUTES, {
      "POST /api/v1/translations/dictionary": {
        status: 200,
        body: { id: "entry-3", term: "Moosewave" },
      },
    });
    const view = await mount();

    await typeInto(
      view.container.querySelector("#dictionary-term"),
      "Moosewave",
      "term",
    );
    await click(byText(view.container, "Save term"), "save term");

    expect(lastBody("POST", "/api/v1/translations/dictionary")).toEqual({
      term: "Moosewave",
      translations: {},
      case_sensitive: false,
      notes: "",
    });
    expect(view.container.textContent).toContain(
      '"Moosewave" is protected — the translator will leave it untouched',
    );
    act(() => view.root.unmount());
  });

  it("deletes only after a confirmation that names the consequence", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(byLabel(view.container, "Delete Moosewave"), "delete term");
    const dialog = openDialog();
    // Opening performs nothing.
    expect(writes()).toEqual([]);
    expect(dialog.textContent).toContain(
      'Delete "Moosewave" from the dictionary?',
    );
    expect(dialog.textContent).toContain("stops being protected");

    await click(byText(dialog, "Cancel"), "cancel");
    expect(writes()).toEqual([]);

    await click(byLabel(view.container, "Delete Moosewave"), "delete term again");
    await click(byText(openDialog(), "Delete term"), "confirm delete");

    expect(writes()).toEqual([
      "DELETE /api/v1/translations/dictionary/entry-1",
    ]);
    act(() => view.root.unmount());
  });
});

describe("translation preview", () => {
  it("previews the locale the operator chose, not a hard-coded French", async () => {
    transport(
      {
        ...DEFAULT_ROUTES,
        "/api/v1/translations/settings": {
          ...SETTINGS,
          enabled: true,
          supported_locales: ["en", "sv"],
        },
      },
      {
        "POST /api/v1/translations/preview": {
          status: 200,
          body: {
            body: "<p>Hej</p>",
            locale: "sv",
            skipped: false,
            dictionary_matches: 2,
            cache_hit: false,
          },
        },
      },
    );
    const view = await mount();

    await typeInto(
      view.container.querySelector("#translation-preview-body"),
      "<p>Hello</p>",
      "preview body",
    );
    await typeInto(
      view.container.querySelector("#translation-preview-locale"),
      "sv",
      "preview locale",
    );
    await click(byText(view.container, "Translate into sv"), "translate");

    expect(writes()).toEqual(["POST /api/v1/translations/preview"]);
    expect(lastBody("POST", "/api/v1/translations/preview")).toEqual({
      body: "<p>Hello</p>",
      locale: "sv",
    });
    expect(view.container.textContent).toContain(
      "Translated into sv using 2 glossary term(s)",
    );
    expect(view.container.textContent).toContain("<p>Hej</p>");
    act(() => view.root.unmount());
  });

  it("does not present an untranslated body as a translation", async () => {
    transport(
      {
        ...DEFAULT_ROUTES,
        "/api/v1/translations/settings": {
          ...SETTINGS,
          supported_locales: ["en", "sv"],
        },
      },
      {
        "POST /api/v1/translations/preview": {
          status: 200,
          body: {
            body: "<p>Hello</p>",
            locale: "sv",
            skipped: true,
            dictionary_matches: 0,
            cache_hit: false,
          },
        },
      },
    );
    const view = await mount();
    await click(byText(view.container, "Translate into sv"), "translate");
    expect(view.container.textContent).toContain("Nothing was translated");
    expect(view.container.textContent).not.toContain("Translated into sv using");
    act(() => view.root.unmount());
  });
});
