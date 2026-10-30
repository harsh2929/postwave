// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /app/campaigns/[id]/translations — the per-campaign locale variant matrix.
// Web reached none of these three routes before: a search for
// `/translations/${` and "/translations`" across src found only the tenant-wide
// endpoints.
//
// Every assertion below is on the recorded request, because the whole point of
// this surface is that a variant is addressed BY LOCALE in the URL: a path
// built from a raw or un-normalized value writes to a row the operator never
// chose, and no rendered text would show it.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

// Authoring is withheld until per-locale routing ships (mirroring desktop).
// The authoring suites below run with routing switched ON so the write path
// stays proven for the day the flag flips; the default-off suite proves the
// withholding itself. A getter keeps the value live per render.
const mockRouting = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/campaign-locale-routing", () => ({
  get CAMPAIGN_LOCALE_ROUTING_ENABLED() {
    return mockRouting.enabled;
  },
}));

const CAMPAIGN_ID = "11111111-2222-3333-4444-555555555555";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/campaigns/[id]/translations",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: CAMPAIGN_ID }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

import { CampaignTranslationsClient } from "@/app/(dashboard)/app/campaigns/[id]/translations/campaign-translations-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const EDITOR = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@postwave.test",
  role: "editor" as const,
  effective_role: "editor" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "QA",
  workspace_slug: "qa",
};

const CAMPAIGN = {
  id: CAMPAIGN_ID,
  tenant_id: "tenant-1",
  name: "Spring launch",
  subject: "Spring is here",
  status: "draft",
  body_html: "<p>Spring is here</p>",
  created_at: "2026-01-01T00:00:00Z",
};

const VARIANTS = {
  campaign_id: CAMPAIGN_ID,
  translations: [
    {
      locale: "fr-CA",
      subject: "Le printemps",
      body_html: "<p>Le printemps</p>",
      body_mjml: "",
      updated_at: "2026-01-02T03:04:05Z",
    },
  ],
};

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

let calls: RecordedCall[] = [];

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
  [`/api/v1/campaigns/${CAMPAIGN_ID}`]: CAMPAIGN,
  [`/api/v1/campaigns/${CAMPAIGN_ID}/translations`]: VARIANTS,
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

async function settle(turns = 6): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
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
        createElement(CampaignTranslationsClient),
      ),
    );
  });
  await settle();
  return { container, root };
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

async function click(element: Element | null, what: string): Promise<void> {
  if (!element) throw new Error(`no control to click: ${what}`);
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await settle(4);
}

function byText(scope: ParentNode, text: string): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>("button")].find(
      (node) => node.textContent?.trim() === text,
    ) ?? null
  );
}

function byLabel(scope: ParentNode, label: string): HTMLElement | null {
  return (
    [...scope.querySelectorAll<HTMLElement>("button")].find(
      (node) => (node.getAttribute("aria-label") ?? "") === label,
    ) ?? null
  );
}

function openDialog(): HTMLElement {
  const nodes = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  if (nodes.length === 0) throw new Error("no dialog is open");
  return nodes[0]!;
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  mockRouting.enabled = true;
  mocks.whoami.mockResolvedValue(EDITOR);
  mocks.whoamiFresh.mockResolvedValue(EDITOR);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("campaign language variants", () => {
  it("lists the campaign's authored locales and states that they are not delivered", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
      `GET /api/v1/campaigns/${CAMPAIGN_ID}/translations`,
    );
    expect(view.container.textContent).toContain("fr-CA");
    expect(view.container.textContent).toContain("Le printemps");
    // The honesty line: nothing in the dispatch loop reads these rows, so the
    // screen must not imply localized delivery.
    expect(view.container.textContent).toContain(
      "Language variants are read-only until routing is available",
    );
    act(() => view.root.unmount());
  });

  it("saves a new variant with PUT to the normalized locale's own path", async () => {
    transport(DEFAULT_ROUTES, {
      [`PUT /api/v1/campaigns/${CAMPAIGN_ID}/translations/es-MX`]: {
        status: 200,
        body: {
          locale: "es-MX",
          subject: "Ya llegó la primavera",
          body_html: "<p>Hola</p>",
          body_mjml: "",
          updated_at: "2026-02-02T00:00:00Z",
        },
      },
    });
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    // The editor opens seeded from the campaign so the operator localizes the
    // real copy instead of retyping it from another tab.
    expect(
      (view.container.querySelector("#variant-body") as HTMLTextAreaElement)
        .value,
    ).toBe("<p>Spring is here</p>");

    await typeInto(
      view.container.querySelector("#variant-locale"),
      "ES-mx",
      "locale",
    );
    await typeInto(
      view.container.querySelector("#variant-subject"),
      "Ya llegó la primavera",
      "subject",
    );
    await typeInto(
      view.container.querySelector("#variant-body"),
      "<p>Hola</p>",
      "body",
    );
    await click(byText(view.container, "Save variant"), "save variant");

    // Normalized: "ES-mx" and "es-MX" are ONE row on the server, so the client
    // must not address them as two.
    expect(writes()).toEqual([
      `PUT /api/v1/campaigns/${CAMPAIGN_ID}/translations/es-MX`,
    ]);
    expect(
      lastBody("PUT", `/api/v1/campaigns/${CAMPAIGN_ID}/translations/es-MX`),
    ).toEqual({ subject: "Ya llegó la primavera", body_html: "<p>Hola</p>" });
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(view.container.textContent).toContain(
      "Recipients still receive the campaign's default subject and body",
    );
    act(() => view.root.unmount());
  });

  it("refuses a locale the server would reject, before anything leaves", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    await typeInto(
      view.container.querySelector("#variant-locale"),
      "en_US",
      "locale",
    );
    await click(byText(view.container, "Save variant"), "save variant");

    expect(writes()).toEqual([]);
    expect(view.container.textContent).toContain("Locale must look like");
    act(() => view.root.unmount());
  });

  it("refuses to silently replace an existing locale from the new-variant form", async () => {
    // PUT is an upsert. Typing "fr-CA" into the ADD form would overwrite the
    // authored French copy with no warning at all.
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    await typeInto(
      view.container.querySelector("#variant-locale"),
      "fr-ca",
      "locale",
    );
    await click(byText(view.container, "Save variant"), "save variant");

    expect(writes()).toEqual([]);
    expect(view.container.textContent).toContain(
      "A fr-CA variant already exists",
    );
    act(() => view.root.unmount());
  });

  it("edits an existing variant in place and pins its locale", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(
      byLabel(view.container, "Edit the fr-CA variant"),
      "edit variant",
    );
    expect(
      (view.container.querySelector("#variant-locale") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await typeInto(
      view.container.querySelector("#variant-subject"),
      "Le printemps arrive",
      "subject",
    );
    await click(byText(view.container, "Save variant"), "save variant");

    expect(writes()).toEqual([
      `PUT /api/v1/campaigns/${CAMPAIGN_ID}/translations/fr-CA`,
    ]);
    expect(
      lastBody("PUT", `/api/v1/campaigns/${CAMPAIGN_ID}/translations/fr-CA`),
    ).toEqual({
      subject: "Le printemps arrive",
      body_html: "<p>Le printemps</p>",
    });
    act(() => view.root.unmount());
  });

  it("deletes a variant only after a confirmation that names what is lost", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(
      byLabel(view.container, "Delete the fr-CA variant"),
      "delete variant",
    );
    const dialog = openDialog();
    expect(writes()).toEqual([]);
    expect(dialog.textContent).toContain("Delete the fr-CA variant?");
    expect(dialog.textContent).toContain("cannot be recovered");

    await click(byText(dialog, "Cancel"), "cancel");
    expect(writes()).toEqual([]);

    await click(
      byLabel(view.container, "Delete the fr-CA variant"),
      "delete variant again",
    );
    await click(byText(openDialog(), "Delete variant"), "confirm delete");

    expect(writes()).toEqual([
      `DELETE /api/v1/campaigns/${CAMPAIGN_ID}/translations/fr-CA`,
    ]);
    act(() => view.root.unmount());
  });

  it("withholds every write control from a viewer", async () => {
    mocks.whoami.mockResolvedValue({
      ...EDITOR,
      role: "viewer",
      effective_role: "viewer",
    });
    transport(DEFAULT_ROUTES);
    const view = await mount();

    expect(byText(view.container, "Add a language")).toBeNull();
    expect(byLabel(view.container, "Edit the fr-CA variant")).toBeNull();
    expect(byLabel(view.container, "Delete the fr-CA variant")).toBeNull();
    expect(view.container.textContent).toContain(
      "Campaign changes are read-only for this session",
    );
    // The list itself still renders: reading is not the thing being withheld.
    expect(view.container.textContent).toContain("Le printemps");
    act(() => view.root.unmount());
  });
});

describe("with per-locale routing off (the shipped default, as on desktop)", () => {
  it("keeps variants readable but withholds adding, editing and deleting from an editor", async () => {
    mockRouting.enabled = false;
    transport(DEFAULT_ROUTES);
    const view = await mount();

    // Reading is not withheld: the stored variant and the reason both render.
    expect(view.container.textContent).toContain("Le printemps");
    expect(view.container.textContent).toContain(
      "Adding, editing, and deleting variants is disabled until per-locale delivery is enforced by the send plan.",
    );
    // An editor has the campaign-write role, so the absence below is the
    // routing flag, not the role gate.
    expect(view.container.textContent).not.toContain(
      "Campaign changes are read-only for this session",
    );
    expect(byText(view.container, "Add a language")).toBeNull();
    expect(byLabel(view.container, "Edit the fr-CA variant")).toBeNull();
    expect(byLabel(view.container, "Delete the fr-CA variant")).toBeNull();
    // Nothing was written.
    expect(
      calls.filter((call) => call.method === "PUT" || call.method === "DELETE"),
    ).toEqual([]);
    act(() => view.root.unmount());
  });
});

describe("drafting a variant body with the translator", () => {
  it("translates the campaign body for the chosen locale and applies it only on request", async () => {
    transport(DEFAULT_ROUTES, {
      "POST /api/v1/translations/preview": {
        status: 200,
        body: {
          body: "<p>Hola</p>",
          locale: "es",
          skipped: false,
          dictionary_matches: 1,
          cache_hit: false,
        },
      },
    });
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    await typeInto(
      view.container.querySelector("#variant-locale"),
      "es",
      "locale",
    );
    // Type something ELSE into the editor first. Without this the draft and
    // the campaign body are byte-identical, and a translator wired to the
    // wrong one would pass the assertion below for free.
    await typeInto(
      view.container.querySelector("#variant-body"),
      "<p>half-finished draft</p>",
      "body",
    );
    await click(
      byText(view.container, "Translate the campaign body"),
      "translate",
    );

    expect(writes()).toEqual(["POST /api/v1/translations/preview"]);
    // The CAMPAIGN's canonical body is the source. Translating the editor's
    // contents would translate a translation on the second press.
    expect(lastBody("POST", "/api/v1/translations/preview")).toEqual({
      body: "<p>Spring is here</p>",
      locale: "es",
    });
    // The result is a proposal, not an edit: the editor still holds what the
    // operator typed until they apply it.
    expect(
      (view.container.querySelector("#variant-body") as HTMLTextAreaElement)
        .value,
    ).toBe("<p>half-finished draft</p>");

    await click(
      byText(view.container, "Use this as the variant body"),
      "apply translation",
    );
    expect(
      (view.container.querySelector("#variant-body") as HTMLTextAreaElement)
        .value,
    ).toBe("<p>Hola</p>");
    // Applying is local. Nothing else was written.
    expect(writes()).toEqual(["POST /api/v1/translations/preview"]);
    act(() => view.root.unmount());
  });

  it("never offers an untranslated body as a translation to apply", async () => {
    // `skipped: true` returns the body UNCHANGED. Offering it would file the
    // English copy under a Spanish locale, and nothing on screen would say so.
    transport(DEFAULT_ROUTES, {
      "POST /api/v1/translations/preview": {
        status: 200,
        body: {
          body: "<p>Spring is here</p>",
          locale: "es",
          skipped: true,
          dictionary_matches: 0,
          cache_hit: false,
        },
      },
    });
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    await typeInto(
      view.container.querySelector("#variant-locale"),
      "es",
      "locale",
    );
    await click(
      byText(view.container, "Translate the campaign body"),
      "translate",
    );

    expect(view.container.textContent).toContain("Nothing was translated");
    expect(byText(view.container, "Use this as the variant body")).toBeNull();
    act(() => view.root.unmount());
  });

  it("asks for the locale before calling the translator", async () => {
    transport(DEFAULT_ROUTES);
    const view = await mount();

    await click(byText(view.container, "Add a language"), "add a language");
    await click(
      byText(view.container, "Translate the campaign body"),
      "translate",
    );

    expect(writes()).toEqual([]);
    expect(view.container.textContent).toContain(
      "Enter the target locale first",
    );
    act(() => view.root.unmount());
  });
});
