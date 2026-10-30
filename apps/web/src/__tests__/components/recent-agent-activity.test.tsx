// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The routines-page activity strip: the exact page it asks for, and the
// difference between "not for your role" and "that read failed".

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecentAgentActivity } from "@/components/mcp/recent-agent-activity";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
}));

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ADMIN: MeResponse = {
  user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  tenant_id: TENANT,
  email: "admin@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

const ROW = {
  id: 501,
  tenantId: TENANT,
  method: "GET",
  path: "/api/v1/campaigns",
  toolName: "campaigns_list",
  statusCode: 200,
  latencyMs: 44,
  costMicros: 0,
  calledAt: "2026-09-05T11:45:00Z",
};

let requested: string[] = [];
let answer: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { rows: [ROW], detailPolicy: "minimized_v1" },
});

function stubTransport() {
  requested = [];
  const transport = vi.fn(async (input: RequestInfo | URL) => {
    requested.push(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url,
    );
    const { status, body } = answer();
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", transport);
  return transport;
}

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

async function render(identity: MeResponse | undefined = ADMIN) {
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
        createElement(RecentAgentActivity, { identity }),
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

beforeEach(() => {
  answer = () => ({
    status: 200,
    body: { rows: [ROW], detailPolicy: "minimized_v1" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("recent agent activity strip", () => {
  it("asks for the last eight calls and links to the full history", async () => {
    stubTransport();
    const container = await render();

    await waitFor(() => {
      expect(container.textContent).toContain("campaigns_list");
    });
    expect(requested).toContain("/api/v1/mcp/executions?limit=8");
    expect(
      container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href"),
    ).toBe("/app/agent-tools");
  });

  it("renders nothing at all for a role the route refuses", async () => {
    const transport = stubTransport();
    const container = await render({
      ...ADMIN,
      role: "editor",
      effective_role: "editor",
    });
    await act(async () => flush());
    expect(transport).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("stops polling on a denial and offers an explicit access re-check", async () => {
    const transport = stubTransport();
    answer = () => ({
      status: 403,
      body: {
        error: { code: "insufficient_role", message: "Admin role required." },
      },
    });
    const container = await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Admin role required.");
    });
    const afterDenial = transport.mock.calls.length;
    // A denial latches the loop off — there is no "Retry now" to press and no
    // background re-request.
    expect(control("Retry now")).toBeUndefined();
    await act(async () => flush());
    expect(transport.mock.calls.length).toBe(afterDenial);

    answer = () => ({
      status: 200,
      body: { rows: [ROW], detailPolicy: "minimized_v1" },
    });
    await act(async () => {
      control("Check access again")?.click();
      await flush();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("campaigns_list");
    });
    expect(transport.mock.calls.length).toBeGreaterThan(afterDenial);
  });

  it("keeps a transient failure retryable", async () => {
    const transport = stubTransport();
    answer = () => ({
      status: 400,
      body: { error: { code: "bad_request", message: "Could not read." } },
    });
    const container = await render();

    await waitFor(() => {
      expect(container.textContent).toContain("Could not read.");
    });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);

    answer = () => ({
      status: 200,
      body: { rows: [ROW], detailPolicy: "minimized_v1" },
    });
    const before = transport.mock.calls.length;
    await act(async () => {
      control("Retry now")?.click();
      await flush();
    });
    await waitFor(() => {
      expect(container.textContent).toContain("campaigns_list");
    });
    expect(transport.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not present an empty page as proof nothing ran", async () => {
    stubTransport();
    answer = () => ({
      status: 200,
      body: { rows: [], detailPolicy: "minimized_v1" },
    });
    const container = await render();

    await waitFor(() => {
      expect(container.textContent).toContain("No recent agent call");
    });
    expect(container.textContent).toContain("may be incomplete");
  });
});
