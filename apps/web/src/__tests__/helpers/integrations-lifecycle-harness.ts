// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared harness for the integration lifecycle component suites: a routed
// fetch stub that records every request the REAL transport sends (method,
// path, query, body), wire fixtures shaped like apps/api/internal/
// integrations/handlers.go responses, and the react-dom/client + act
// mounting helpers the neighbouring suites use.

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const CONN_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export function identity(role: "owner" | "admin" | "editor" | "viewer") {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "ada@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

/* ---------- routed fetch ------------------------------------------------ */

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
}

type RouteResult = { status?: number; body: unknown };
type RouteHandler =
  | RouteResult
  | ((request: RecordedRequest) => RouteResult | Promise<RouteResult>);

export interface FetchRouter {
  requests: RecordedRequest[];
  /** Requests other than GET (the writes a verb actually sent). */
  writes(): RecordedRequest[];
  /** Replace/add a route: key is "METHOD /api/v1/path". */
  route(key: string, handler: RouteHandler): void;
}

export function installFetchRouter(
  routes: Record<string, RouteHandler>,
): FetchRouter {
  const table = new Map(Object.entries(routes));
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = undefined;
      if (typeof init?.body === "string" && init.body.length > 0) {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const request: RecordedRequest = {
        method,
        path: url.pathname,
        search: url.search,
        body,
      };
      requests.push(request);
      const handler = table.get(`${method} ${url.pathname}`);
      const result: RouteResult = !handler
        ? {
            status: 404,
            body: { error: { code: "not_found", message: "no route" } },
          }
        : typeof handler === "function"
          ? await handler(request)
          : handler;
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return {
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
    route: (key, handler) => {
      table.set(key, handler);
    },
  };
}

/* ---------- mounting ---------------------------------------------------- */

const roots: Root[] = [];

export function mount(ui: ReactNode): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, ui));
  });
  return queryClient;
}

export function unmountAll(): void {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
}

export async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

export async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

export function buttonNamed(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

export async function click(element: Element | undefined | null): Promise<void> {
  if (!element) throw new Error("element to click was not rendered");
  await act(async () => {
    (element as HTMLElement).click();
    await flush();
  });
}

export async function type(
  input: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype =
      input instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(
      new Event(input instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
    await flush();
  });
}

export function text(): string {
  return document.body.textContent ?? "";
}

/* ---------- wire fixtures ---------------------------------------------- */

export function catalogItem(overrides: Record<string, unknown> = {}) {
  return {
    slug: "hubspot",
    name: "HubSpot",
    category: "crm",
    badge: "native",
    runtime_status: "available",
    summary: "Two-way CRM contact sync.",
    capabilities: ["contacts"],
    docs_url: "https://docs.example/hubspot",
    setup_path: "/integrations",
    native: true,
    sources: ["crm"],
    ...overrides,
  };
}

export function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    slug: "hubspot",
    name: "HubSpot",
    category: "crm",
    badge: "native",
    runtime_status: "available",
    connected: true,
    status: "active",
    count: 1,
    primary_connection_id: CONN,
    connection_ids: [CONN],
    health_state: "healthy",
    health_message: "Connection healthy.",
    ...overrides,
  };
}

export function healthReport(overrides: Record<string, unknown> = {}) {
  return {
    state: "healthy",
    severity: "info",
    message: "Last pull completed.",
    monitoring_surface: "crm_sync_runs",
    checks: [
      {
        key: "credentials",
        label: "Credential reference",
        state: "pass",
        message: "Vault reference resolves.",
      },
    ],
    retry_policy: {
      mode: "bounded",
      max_attempts: 5,
      backoff: "exponential",
      dead_letter: "crm_dead_letters",
      idempotency: "provider_event_id",
    },
    sync_history: [],
    audit_trail: [],
    data_delete: [],
    ...overrides,
  };
}

export function contract(overrides: Record<string, unknown> = {}) {
  return {
    slug: "hubspot",
    owner: "postwave_crm",
    badge: "native",
    runtime_status: "available",
    native_managed: true,
    native_verified: false,
    implementation_depth: "native_foundation",
    public_claim: "Native CRM foundation with managed OAuth.",
    auth_modes: ["oauth"],
    credential_storage: "vault reference",
    secret_policy: "no raw secrets",
    setup_surface: "/integrations",
    monitoring: ["crm_sync_runs"],
    lifecycle_actions: ["connect/start", "sync", "backfill", "pause", "disconnect"],
    data_objects: ["contacts"],
    event_topics: [],
    compliance_gates: ["consent"],
    privacy_actions: [],
    rate_limit_policy: "provider limits",
    partner_review: "not_required",
    ...overrides,
  };
}

export function recipe(overrides: Record<string, unknown> = {}) {
  return {
    id: "hubspot-contacts-to-list",
    name: "HubSpot contacts → Moosewave list",
    provider: "hubspot",
    source_slug: "hubspot",
    target_slug: "postwave",
    summary: "Sync HubSpot contacts into a list.",
    badge: "native",
    available: true,
    estimated_minutes: 10,
    setup_path: "/integrations",
    capabilities: ["contacts"],
    steps: [
      {
        title: "Connect HubSpot",
        description: "Authorize the CRM connection.",
        required_fields: ["credentials_ref"],
      },
    ],
    blueprint: {
      trigger: "contact.updated",
      destination: "list",
      postwave_surface: "crm",
      required_scopes: ["crm.objects.contacts.read"],
      required_secrets: ["hubspot_oauth"],
      field_mappings: [
        { source: "email", target: "subscriber.email", required: true },
      ],
    },
    ...overrides,
  };
}

export function detailBody(overrides: Record<string, unknown> = {}) {
  return {
    item: catalogItem(),
    connection: connectionRow(),
    setup: [
      {
        title: "Store the credential",
        description: "Put the OAuth token in the vault.",
      },
    ],
    recipes: [recipe()],
    lifecycle_actions: ["connect/start", "sync", "backfill", "pause", "disconnect"],
    health: healthReport(),
    contract: contract(),
    ...overrides,
  };
}

export function actionBody(
  slug: string,
  action: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    slug,
    action,
    status: "delegated",
    message: `${slug} is managed through the existing Moosewave surface.`,
    delegated_to: `POST /api/v1/marketing-integrations/{id}/${action}`,
    required_fields: ["id"],
    manage_path: "/integrations",
    ...overrides,
  };
}
