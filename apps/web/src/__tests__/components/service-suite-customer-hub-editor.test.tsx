// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Customer Hub config (desktop CustomerHubConfig parity): status + five
// toggles saved as ONE complete, version-guarded PUT. Rendered through the
// real service-suite page and the real transport; only `fetch` is stubbed, so
// the assertions are on the wire: method, path, If-Match, and the full body.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import catalogFixture from "../fixtures/api/service-suite_catalog.json";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const V1 = "2026-09-01T10:00:00.1Z";
const V2 = "2026-09-12T08:30:00.25Z";

const mocks = vi.hoisted(() => ({ whoami: vi.fn() }));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/context-epoch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/context-epoch")>()),
  readContextEpoch: () => "epoch-customer-hub",
  onContextEpochObserved: () => () => undefined,
}));
vi.mock("@/lib/use-app-origin", () => ({
  useAppOrigin: () => "https://app.postwave.test",
}));

import ServiceSuitePage from "@/app/(dashboard)/app/service-suite/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CARRY = {
  storefronts: [{ id: "main", domain: "shop.example.test" }],
  content_blocks: [{ kind: "banner", text: "Welcome back" }],
  personalization_rules: { segment: "vip" },
  support_settings: { hours: "9-5" },
  styling: { accent: "#123456" },
  metadata: { owner: "ops" },
};

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    tenant_id: TENANT,
    version: V1,
    status: "draft",
    order_history_enabled: true,
    favorites_enabled: false,
    coupons_enabled: true,
    recommendations_enabled: false,
    customer_agent_enabled: false,
    runtime_available: false,
    runtime_status: "held",
    runtime_reason_code: "customer_hub_runtime_unavailable",
    customer_agent_effective_enabled: false,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: V1,
    ...CARRY,
    ...overrides,
  };
}

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

let seen: Seen[] = [];
let getConfig: () => unknown = () => configRow();
let putResponse: () => Response = () => json(200, configRow());
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubTransport() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = new URL(raw, "http://postwave.test").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      seen.push({
        method,
        path,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path === "/api/v1/service-suite/catalog") return json(200, catalogFixture);
      if (path === "/api/v1/service-suite/config" && method === "GET") {
        return json(200, getConfig());
      }
      if (path === "/api/v1/service-suite/config" && method === "PUT") {
        return putResponse();
      }
      return json(404, { error: { code: "not_found", message: "" } });
    }),
  );
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ServiceSuitePage />
      </QueryClientProvider>,
    );
  });
  await eventually(() =>
    expect(container.textContent).toContain("Replace configuration record"),
  );
  return container;
}

function checkbox(label: string): HTMLInputElement {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const input = found ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no toggle ${label}`);
  return input;
}

function saveButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Save configuration",
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("no save button");
  return found;
}

function statusSelect(): HTMLSelectElement {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === "Record status",
  );
  const select = found ? document.getElementById(found.htmlFor) : null;
  if (!(select instanceof HTMLSelectElement)) throw new Error("no status select");
  return select;
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

function puts(): Seen[] {
  return seen.filter((request) => request.method === "PUT");
}

beforeEach(() => {
  seen = [];
  getConfig = () => configRow();
  putResponse = () =>
    json(
      200,
      configRow({
        version: V2,
        updated_at: V2,
        status: "paused",
        favorites_enabled: true,
      }),
    );
  mocks.whoami.mockReset().mockResolvedValue({
    user_id: USER,
    tenant_id: TENANT,
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  });
  stubTransport();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Customer Hub configuration replacement", () => {
  it("PUTs the complete record with the edited scalars, the carried objects, and the verified If-Match", async () => {
    const container = await mount();
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain("No unsaved changes.");

    await choose(statusSelect(), "paused");
    await click(checkbox("Favorites"));
    expect(saveButton().disabled).toBe(false);
    await click(saveButton());

    await eventually(() => expect(puts()).toHaveLength(1));
    const [put] = puts();
    expect(put?.path).toBe("/api/v1/service-suite/config");
    expect(put?.headers.get("If-Match")).toBe(`"${V1}"`);
    expect(put?.body).toEqual({
      status: "paused",
      order_history_enabled: true,
      favorites_enabled: true,
      coupons_enabled: true,
      recommendations_enabled: false,
      customer_agent_enabled: false,
      ...CARRY,
    });
    await eventually(() =>
      expect(container.textContent).toContain(
        `Configuration record replaced at version ${V2}`,
      ),
    );
    // The receipt's record is now the baseline: nothing left to save.
    expect(saveButton().disabled).toBe(true);
    expect(statusSelect().value).toBe("paused");
  });

  it("guards an absent record with If-Match \"absent\"", async () => {
    getConfig = () => {
      const row: Record<string, unknown> = configRow({ version: "absent" });
      delete row.created_at;
      delete row.updated_at;
      return row;
    };
    const container = await mount();
    expect(container.textContent).toContain("No stored configuration");
    await click(checkbox("Recommendations"));
    await click(saveButton());
    await eventually(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.headers.get("If-Match")).toBe('"absent"');
    expect(puts()[0]?.body).toMatchObject({ recommendations_enabled: true });
  });

  it("keeps Active and Customer agent enablement release-held", async () => {
    await mount();
    const active = [...statusSelect().options].find((o) => o.value === "active");
    expect(active?.disabled).toBe(true);
    expect(active?.textContent).toContain("publication release held");
    expect(checkbox("Customer agent").disabled).toBe(true);
  });

  it("lets a recorded Active status and Customer agent only be turned off, and blocks saving until they are", async () => {
    getConfig = () =>
      configRow({ status: "active", customer_agent_enabled: true });
    const container = await mount();
    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain(
      "Customer Hub publication and Customer Agent enablement are release-held.",
    );
    await choose(statusSelect(), "draft");
    expect(saveButton().disabled).toBe(true);
    await click(checkbox("Customer agent"));
    expect(checkbox("Customer agent").checked).toBe(false);
    await click(saveButton());
    await eventually(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.body).toMatchObject({
      status: "draft",
      customer_agent_enabled: false,
    });
  });

  it("withholds saving when the advanced fields cannot be carried forward", async () => {
    getConfig = () => configRow({ storefronts: undefined });
    const container = await mount();
    expect(container.textContent).toContain(
      "The stored advanced configuration could not be verified",
    );
    expect(saveButton().disabled).toBe(true);
    expect(checkbox("Favorites").disabled).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("treats a 2xx that did not advance the version as an unknown outcome", async () => {
    putResponse = () => json(200, configRow());
    const container = await mount();
    await click(checkbox("Favorites"));
    await click(saveButton());
    await eventually(() =>
      expect(container.textContent).toContain(
        "Service-suite config replacement did not advance its version",
      ),
    );
    expect(container.textContent).toContain("Verified record retired");
    expect(container.textContent).not.toContain("Configuration record replaced");
    expect(saveButton().disabled).toBe(true);
  });

  it("renders the server's sentence on a version conflict and retires the record until refreshed", async () => {
    putResponse = () =>
      json(412, {
        error: {
          code: "precondition_failed",
          message: "The resource changed; refetch it and review before retrying.",
        },
      });
    const container = await mount();
    await click(checkbox("Coupons"));
    await click(saveButton());
    await eventually(() =>
      expect(container.textContent).toContain(
        "The resource changed; refetch it and review before retrying.",
      ),
    );
    expect(container.textContent).toContain("Verified record retired");
    expect(saveButton().disabled).toBe(true);
    expect(puts()).toHaveLength(1);

    // Someone else's save landed in between: the refresh brings a new
    // version, which replaces the stale draft rather than merging into it.
    expect(checkbox("Coupons").checked).toBe(false);
    getConfig = () => configRow({ version: V2, updated_at: V2 });
    const refresh = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh verified config"),
    ) as HTMLButtonElement;
    await click(refresh);
    await eventually(() =>
      expect(container.textContent).not.toContain("Verified record retired"),
    );
    expect(checkbox("Coupons").checked).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });
});
