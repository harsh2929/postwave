// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The history panel's verbs, asserted by the request each one makes and the
// row it puts on screen — not by the presence of a control.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { McpExecutionHistory } from "@/app/(dashboard)/app/agent-tools/_components/mcp-execution-history";
import type { MeResponse } from "@/lib/auth-api";
import { openStreamGateForTests } from "@/lib/realtime/stream-gate";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ADMIN: MeResponse = {
  user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  tenant_id: TENANT,
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const EDITOR: MeResponse = {
  ...ADMIN,
  role: "editor",
  effective_role: "editor",
};

function execution(id: number, tool: string, extra: object = {}) {
  return {
    id,
    tenantId: TENANT,
    apiKeyId: "key-1",
    apiKeyPrefix: "pwlive",
    method: "GET",
    path: "/api/v1/subscribers",
    queryString: "key_count=2",
    toolName: tool,
    statusCode: 200,
    latencyMs: 21,
    userAgent: "postwave-mcp-server/1.4.0",
    remoteIp: "203.0.113.7",
    requestBody: { _summary: true, type: "object", key_count: 3 },
    costMicros: 900,
    calledAt: "2026-09-05T11:30:00Z",
    ...extra,
  };
}

const STATS = {
  windowHours: 24,
  totalCalls: 12,
  successfulCalls: 12,
  averageLatencyMs: 25,
  p95LatencyMs: 80,
  totalCostMicros: 3_000,
  lastCallAt: "2026-09-05T11:30:00Z",
  topTools: [
    { toolName: "subscribers_list", calls: 9 },
    { toolName: "campaigns_list", calls: 3 },
  ],
  statusBreakdown: [{ class: 2, calls: 12 }],
};

const TREND = {
  points: [
    { bucket: "2026-09-05T09:00:00Z", calls: 1 },
    { bucket: "2026-09-05T10:00:00Z", calls: 5 },
    { bucket: "2026-09-05T11:00:00Z", calls: 6 },
  ],
};

let requested: string[] = [];
/** Answers every `/api/v1/mcp/executions` read; the URL selects the page. */
let executionPage: (url: string) => unknown = () => ({
  rows: [],
  detailPolicy: "minimized_v1",
});

function servePage(next: (url: string) => unknown) {
  executionPage = next;
}

function stubTransport(status = 200, stats = STATS) {
  requested = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    requested.push(url);
    if (status !== 200) {
      return new Response(
        JSON.stringify({ error: { code: "denied", message: "Denied." } }),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    const path = url.split("?")[0];
    const body =
      path === "/api/v1/mcp/stats"
        ? stats
        : path === "/api/v1/mcp/trend"
          ? TREND
          : executionPage(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;
  readonly listeners = new Map<string, EventListener[]>();
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  emit(name: string, data: unknown) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data: JSON.stringify(data) }));
    }
  }

  close() {
    this.closed = true;
  }
}

const refreshQuotas = vi.fn();
let root: Root | null = null;

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
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

async function render(identity: MeResponse = ADMIN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(McpExecutionHistory, {
          identity,
          onRefreshQuotas: refreshQuotas,
        }),
      ),
    );
  });
  await act(async () => flush());
  return container;
}

function control(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

async function setSelect(id: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`#${id}`);
  await act(async () => {
    if (select) select.value = value;
    select?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function setInput(id: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    if (input) setter?.call(input, value);
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    input?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

function executionCalls() {
  return requested.filter((url) => url.startsWith("/api/v1/mcp/executions?"));
}

beforeEach(() => {
  // See realtime-stream-gate.test.ts for WHEN a stream opens; this suite is
  // about what it does once connected.
  openStreamGateForTests();
  servePage(() => ({ rows: [], detailPolicy: "minimized_v1" }));
  refreshQuotas.mockClear();
  FakeEventSource.instances = [];
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MCP execution history", () => {
  it("withholds success rates and latency measurements when no calls were recorded", async () => {
    stubTransport(200, {
      ...STATS,
      totalCalls: 0,
      successfulCalls: 0,
      averageLatencyMs: 0,
      p95LatencyMs: 0,
      totalCostMicros: 0,
    });
    const container = await render();
    await waitFor(() =>
      expect(container.textContent).toContain("No recorded calls to measure"),
    );
    expect(container.textContent).toContain("No latency sample in this window");
    expect(container.textContent).not.toContain("0.0%");
    expect(container.textContent).not.toContain("<1 ms");
  });

  it("reads stats, trend and the first page, and renders the rows", async () => {
    stubTransport();
    servePage(() => ({
      rows: [execution(90, "subscribers_list")],
      nextBeforeId: 90,
      detailPolicy: "minimized_v1",
      evidenceClass: "best_effort_observability",
    }));

    const container = await render();

    await waitFor(() => {
      expect(container.textContent).toContain("subscribers_list");
    });
    // Every read is scoped to the default window and the npm-proxy source.
    expect(
      requested.some((url) => url === "/api/v1/mcp/stats?window=24h"),
    ).toBe(true);
    expect(
      requested.some((url) => url === "/api/v1/mcp/trend?window=24h"),
    ).toBe(true);
    expect(executionCalls()[0]).toMatch(/^\/api\/v1\/mcp\/executions\?since=/u);
    expect(executionCalls()[0]).toContain("limit=50");
    expect(executionCalls()[0]).not.toContain("include=all");

    // The aggregates are rendered, not just fetched.
    expect(container.textContent).toContain("100.0%");
    expect(container.textContent).toContain("Peak 6 calls in one hour");
  });

  it("re-reads every aggregate when the window and source change", async () => {
    stubTransport();
    await render();
    await waitFor(() => {
      expect(requested).toContain("/api/v1/mcp/stats?window=24h");
    });

    await setSelect("mcp-history-window", "7d");
    await waitFor(() => {
      expect(requested).toContain("/api/v1/mcp/stats?window=7d");
      expect(requested).toContain("/api/v1/mcp/trend?window=7d");
    });

    await setSelect("mcp-history-source", "all");
    await waitFor(() => {
      expect(requested).toContain("/api/v1/mcp/stats?window=7d&include=all");
      expect(executionCalls().some((url) => url.includes("include=all"))).toBe(
        true,
      );
    });
  });

  it("drills from a top tool into an exact tool filter", async () => {
    stubTransport();
    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("Top tools");
    });

    await act(async () => {
      control("subscribers_list")?.click();
      await flush();
    });

    await waitFor(() => {
      expect(
        executionCalls().some((url) => url.includes("tool=subscribers_list")),
      ).toBe(true);
    });
    expect(
      document.querySelector<HTMLInputElement>("#mcp-history-tool")?.value,
    ).toBe("subscribers_list");
  });

  it("withholds a tool filter the server would reject, and says why", async () => {
    stubTransport();
    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("Exact tool identifier");
    });
    const before = executionCalls().length;

    await setInput("mcp-history-tool", "9-lives");

    expect(container.textContent).toContain("Not a canonical tool token");
    expect(executionCalls()).toHaveLength(before);
  });

  it("loads older executions from the cursor and appends them once", async () => {
    stubTransport();
    servePage((url) =>
      url.includes("before_id=90")
        ? {
            rows: [execution(70, "campaigns_list")],
            detailPolicy: "minimized_v1",
          }
        : {
            rows: [execution(90, "subscribers_list")],
            nextBeforeId: 90,
            detailPolicy: "minimized_v1",
          },
    );

    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("subscribers_list");
    });
    expect(container.textContent).toContain(
      "The next page begins before execution 90",
    );

    await act(async () => {
      control("Load older")?.click();
      await flush();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("campaigns_list");
    });
    expect(
      executionCalls().filter((url) => url.includes("before_id=90")),
    ).toHaveLength(1);
    // The cursor is exhausted, so the control is replaced by the honest note.
    expect(control("Load older")).toBeUndefined();
    expect(container.textContent).toContain(
      "No older matching row was returned",
    );
  });

  it("opens a row's detail and copies only the minimized body metadata", async () => {
    stubTransport();
    servePage(() => ({
      rows: [
        execution(90, "subscribers_list", {
          requestBody: { email: "someone@example.test", tag: "vip" },
        }),
      ],
      detailPolicy: "minimized_v1",
    }));

    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("subscribers_list");
    });

    await act(async () => {
      control("View")?.click();
      await flush();
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain("Execution 90");
    });
    // The raw values never reached the page at all.
    expect(document.body.textContent).not.toContain("someone@example.test");
    expect(document.body.textContent).toContain(
      "Removed before this page retained it",
    );

    await act(async () => {
      control("Copy metadata")?.click();
      await flush();
    });

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    expect(JSON.parse(writeText.mock.calls[0][0] as string)).toEqual({
      _summary: true,
      type: "object",
      key_count: 2,
      _truncated: false,
    });
  });

  it("prepends a named stream row only while the live tail is on", async () => {
    stubTransport();
    vi.stubGlobal(
      "EventSource",
      FakeEventSource as unknown as typeof EventSource,
    );
    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("Live table updates");
    });
    // Nothing is subscribed until the operator asks for it.
    expect(FakeEventSource.instances).toHaveLength(0);

    const toggle = document.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    await act(async () => {
      toggle?.click();
      await flush();
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe(
      "/api/v1/mcp/executions/stream",
    );

    await act(async () => {
      FakeEventSource.instances[0].onopen?.(new Event("open"));
      // The server names EVERY row frame `event: execution`; a consumer bound
      // only to onmessage receives nothing.
      FakeEventSource.instances[0].emit(
        "execution",
        execution(120, "flows_list"),
      );
      await flush();
    });

    await waitFor(() => {
      expect(container.textContent).toContain("flows_list");
    });

    // Reconnect tears the old subscription down and opens a fresh one.
    await act(async () => {
      control("Reconnect live stream")?.click();
      await flush();
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it("carries the source into the live stream URL", async () => {
    stubTransport();
    vi.stubGlobal(
      "EventSource",
      FakeEventSource as unknown as typeof EventSource,
    );
    await render();
    await setSelect("mcp-history-source", "all");
    const toggle = document.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    );
    await act(async () => {
      toggle?.click();
      await flush();
    });
    expect(FakeEventSource.instances.at(-1)?.url).toBe(
      "/api/v1/mcp/executions/stream?include=all",
    );
  });

  it("refreshes the aggregates, the first page and the quota configuration", async () => {
    stubTransport();
    const container = await render();
    await waitFor(() => {
      expect(container.textContent).toContain("Recorded calls");
    });
    const before = requested.length;

    await act(async () => {
      control("Refresh")?.click();
      await flush();
    });

    await waitFor(() => {
      expect(requested.length).toBeGreaterThan(before);
    });
    expect(refreshQuotas).toHaveBeenCalledTimes(1);
    const after = requested.slice(before);
    expect(after).toContain("/api/v1/mcp/stats?window=24h");
    expect(after).toContain("/api/v1/mcp/trend?window=24h");
    expect(after.some((url) => url.startsWith("/api/v1/mcp/executions?"))).toBe(
      true,
    );
  });

  it("shows one failure for the section rather than presenting silence as calm", async () => {
    // 403 is the shape this route actually refuses with, and it is terminal —
    // no retry backoff to wait out.
    stubTransport(403);
    const container = await render();
    await waitFor(() => {
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    });
    // The server's own refusal sentence, not an invented one.
    expect(container.textContent).toContain("Denied.");
    // A failed read must not also render as "no rows" — that reads as calm.
    expect(container.textContent).not.toContain("No recorded row was returned");
  });

  it("requests nothing for a role the server would refuse", async () => {
    const transport = stubTransport();
    const container = await render(EDITOR);
    await act(async () => flush());
    expect(transport).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "restricted to an effective owner or admin role",
    );
    expect(container.textContent).toContain("editor");
  });

  it("requests nothing while viewer mode is on", async () => {
    const transport = stubTransport();
    const container = await render({ ...ADMIN, viewer_mode: true });
    await act(async () => flush());
    expect(transport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("viewer mode is on");
  });
});
