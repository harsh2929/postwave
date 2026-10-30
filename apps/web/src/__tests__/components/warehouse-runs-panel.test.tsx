// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-91: tenant-wide warehouse sync runs — search, status filter,
// refresh, and admin-only redacted error evidence (desktop
// components/dataplatform/WarehouseRunsPanel.tsx:293-330, :485-504).
// Drives the real transport through a stubbed fetch, mounted the way
// warehouse-manager.tsx mounts it (the page's runs query feeds the panel and
// Refresh re-runs that query), so the assertions cover the requests actually
// sent: GET /api/v1/warehouse/runs and GET /api/v1/warehouse/runs/{id}/errors.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WarehouseRunsPanel } from "@/app/(dashboard)/app/warehouse/warehouse-runs-panel";
import {
  listWarehouseRuns,
  type WarehouseAuthority,
} from "@/lib/warehouse-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONN_A = "33333333-3333-4333-8333-333333333333";
const CONN_B = "44444444-4444-4444-8444-444444444444";
const RUN_OK = "55555555-5555-4555-8555-555555555555";
const RUN_FAIL = "66666666-6666-4666-8666-666666666666";
const RUN_IMPORT = "77777777-7777-4777-8777-777777777777";
const ADMIN: WarehouseAuthority = {
  tenantId: TENANT,
  userId: USER,
  role: "admin",
};

function run(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tenant_id: TENANT,
    connection_id: CONN_A,
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: ["subscribers"],
    rows_scanned: 100,
    rows_exported: 100,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 0,
    issue_present: false,
    started_at: "2026-09-12T08:00:00Z",
    completed_at: "2026-09-12T08:01:00Z",
    created_at: "2026-09-12T08:00:00Z",
    updated_at: "2026-09-12T08:01:00Z",
    ...overrides,
  };
}

const RUNS = [
  run(RUN_OK),
  run(RUN_FAIL, {
    status: "failed",
    rows_failed: 3,
    issue_present: true,
    connection_id: CONN_B,
  }),
  run(RUN_IMPORT, { direction: "import", run_mode: "manual" }),
];

let fetchMock: ReturnType<
  typeof vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >
>;
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requests(): Array<{ method: string; path: string }> {
  return fetchMock.mock.calls.map(([input, init]) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    return {
      method: (input instanceof Request ? input.method : init?.method) ?? "GET",
      path: new URL(url, "http://localhost").pathname,
    };
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    ).pathname;
    if (path === `/api/v1/warehouse/runs/${RUN_FAIL}/errors`) {
      return json(200, {
        items: [
          {
            id: 9,
            run_id: RUN_FAIL,
            source_object: "subscribers",
            row_number: 42,
            error_code: "schema_invalid",
            message_present: true,
            created_at: "2026-09-12T08:00:30Z",
          },
        ],
      });
    }
    if (path === "/api/v1/warehouse/runs") return json(200, { items: RUNS });
    return json(404, { error: { code: "not_found", message: "nope" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const QUERY_ROOT = ["warehouse-manager", TENANT, "admin"];
const NAMES = new Map([
  [CONN_A, "Snowflake nightly"],
  [CONN_B, "BigQuery events"],
]);

/** Mirrors warehouse-manager.tsx: runsQuery feeds the panel. */
function Harness({ authority }: { authority: WarehouseAuthority | null }) {
  const runsQuery = useQuery({
    queryKey: [...QUERY_ROOT, "runs"],
    queryFn: ({ signal }) => listWarehouseRuns({ tenantId: TENANT, signal }),
  });
  return createElement(WarehouseRunsPanel, {
    runs: Array.isArray(runsQuery.data) ? runsQuery.data : [],
    loading: runsQuery.isLoading,
    error: runsQuery.isError,
    refreshing: runsQuery.isFetching,
    onRefresh: () => runsQuery.refetch(),
    connectionNames: NAMES,
    authority,
    queryRoot: QUERY_ROOT,
  });
}

function render(authority: WarehouseAuthority | null): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(Harness, { authority }),
      ),
    ),
  );
  return host;
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function rows(el: HTMLElement): string[] {
  return [
    ...el.querySelectorAll('[data-testid="warehouse-run-row"]'),
  ].map((row) => row.textContent ?? "");
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  act(() => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}

function buttonNamed(el: HTMLElement, name: RegExp): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((button) =>
    name.test(
      button.getAttribute("aria-label") ?? button.textContent ?? "",
    ),
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("WarehouseRunsPanel", () => {
  it("searches and filters the loaded runs by status", async () => {
    const el = render(ADMIN);
    await eventually(() => expect(rows(el)).toHaveLength(3));
    expect(requests()).toEqual([
      { method: "GET", path: "/api/v1/warehouse/runs" },
    ]);

    const search = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    setValue(search, "bigquery");
    expect(rows(el)).toHaveLength(1);
    expect(rows(el)[0]).toContain(RUN_FAIL);
    expect(el.textContent).toContain("1 of 3 loaded");

    setValue(search, RUN_IMPORT.slice(0, 8));
    expect(rows(el)).toHaveLength(1);
    expect(rows(el)[0]).toContain("import · manual");

    setValue(search, "");
    const status = el.querySelector<HTMLSelectElement>("select")!;
    expect([...status.options].map((o) => o.value)).toEqual([
      "all",
      "completed",
      "failed",
    ]);
    setValue(status, "failed");
    expect(rows(el)).toHaveLength(1);
    expect(rows(el)[0]).toContain("BigQuery events");

    setValue(search, "snowflake");
    expect(rows(el)).toHaveLength(0);
    expect(el.textContent).toContain("No runs match these filters");
    click(buttonNamed(el, /Clear filters/));
    expect(rows(el)).toHaveLength(3);
    // Filtering is client-side over the loaded page: no extra request.
    expect(requests()).toHaveLength(1);
  });

  it("Refresh re-reads GET /api/v1/warehouse/runs", async () => {
    const el = render(ADMIN);
    await eventually(() => expect(rows(el)).toHaveLength(3));
    click(buttonNamed(el, /^Refresh$/));
    await eventually(() =>
      expect(requests()).toEqual([
        { method: "GET", path: "/api/v1/warehouse/runs" },
        { method: "GET", path: "/api/v1/warehouse/runs" },
      ]),
    );
  });

  it("admins open redacted error evidence for a failing run", async () => {
    const el = render(ADMIN);
    await eventually(() => expect(rows(el)).toHaveLength(3));
    click(buttonNamed(el, new RegExp(`error evidence for run ${RUN_FAIL}`)));
    await eventually(() =>
      expect(document.body.textContent).toContain("schema_invalid"),
    );
    expect(requests()).toContainEqual({
      method: "GET",
      path: `/api/v1/warehouse/runs/${RUN_FAIL}/errors`,
    });
    expect(document.body.textContent).toContain("row 42");
    expect(document.body.textContent).toContain("message retained server-side");
  });

  it("readers see the issue but never request error evidence", async () => {
    const el = render(null);
    await eventually(() => expect(rows(el)).toHaveLength(3));
    expect(
      [...el.querySelectorAll("button")].some((b) =>
        /error evidence/i.test(b.getAttribute("aria-label") ?? ""),
      ),
    ).toBe(false);
    expect(rows(el)[1]).toContain("Error evidence requires an owner or admin.");
    expect(rows(el)[1]).toContain(
      "One or more rows failed without exposing rejected values.",
    );
    expect(requests().some((r) => r.path.endsWith("/errors"))).toBe(false);
  });
});
