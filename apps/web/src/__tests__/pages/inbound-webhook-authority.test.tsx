// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import InboundWebhooksPage from "@/app/(dashboard)/app/inbound-webhooks/page";
import InboundWebhookTriggersPage from "@/app/(dashboard)/app/inbound-webhooks/[id]/triggers/page";
import type { AuthRole, MeResponse } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  createEndpoint: vi.fn(),
  createTrigger: vi.fn(),
  deleteEndpoint: vi.fn(),
  deleteTrigger: vi.fn(),
  getEndpoint: vi.fn(),
  listEndpoints: vi.fn(),
  listFlows: vi.fn(),
  listTriggers: vi.fn(),
  rotateEndpoint: vi.fn(),
  updateEndpoint: vi.fn(),
  updateTrigger: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "endpoint_1" }),
  usePathname: () => "/app/inbound-webhooks/endpoint_1/triggers",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/inbound-webhooks-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbound-webhooks-api")>()),
  createInboundWebhook: mocks.createEndpoint,
  createInboundTrigger: mocks.createTrigger,
  deleteInboundWebhook: mocks.deleteEndpoint,
  deleteInboundTrigger: mocks.deleteTrigger,
  getInboundWebhook: mocks.getEndpoint,
  listInboundWebhooks: mocks.listEndpoints,
  listInboundTriggers: mocks.listTriggers,
  rotateInboundWebhookSecret: mocks.rotateEndpoint,
  updateInboundWebhook: mocks.updateEndpoint,
  updateInboundTrigger: mocks.updateTrigger,
}));

vi.mock("@/lib/flows-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/flows-api")>()),
  flowsApi: { listAll: mocks.listFlows },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

function identity(
  role: AuthRole,
  overrides: Partial<MeResponse> = {},
): MeResponse {
  return {
    user_id: "user_1",
    tenant_id: "tenant_1",
    email: "operator@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Inbound QA",
    workspace_slug: "inbound-qa",
    ...overrides,
  };
}

const endpoint = {
  id: "endpoint_1",
  tenantId: "tenant_1",
  slug: "quality-hook",
  name: "Quality hook",
  enabled: true,
  transform_jq: "",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const trigger = {
  id: "trigger_1",
  webhook_id: endpoint.id,
  name: "Onboard signup",
  active: true,
  match_jsonpath: "$.event_type",
  match_operator: "equals" as const,
  match_value: "user.created",
  email_jsonpath: "$.email",
  action_type: "add_tag" as const,
  action_target_id: "onboarded",
  fired_count: 0,
  last_fired_at: null,
  created_at: "2026-09-01T00:00:00.000Z",
  updated_at: "2026-09-01T00:00:00.000Z",
};

function render(Page: ComponentType): {
  client: QueryClient;
  container: HTMLDivElement;
  root: Root;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Page)),
    );
  });
  return { client, container, root };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(
        async () =>
          new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
      );
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const candidate = Array.from(document.querySelectorAll("button")).find(
    (entry): entry is HTMLButtonElement =>
      entry instanceof HTMLButtonElement && entry.textContent?.trim() === label,
  );
  if (!candidate) throw new Error(`Button not found: ${label}`);
  return candidate;
}

beforeEach(() => {
  const admin = identity("admin");
  mocks.whoami.mockResolvedValue(admin);
  mocks.whoamiFresh.mockResolvedValue(admin);
  mocks.listEndpoints.mockResolvedValue({ items: [endpoint] });
  mocks.getEndpoint.mockResolvedValue(endpoint);
  mocks.listTriggers.mockResolvedValue({ items: [trigger] });
  mocks.listFlows.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("inbound webhook protected reads", () => {
  it.each([
    ["editor", identity("editor")],
    ["viewer", identity("viewer")],
    ["viewer mode", identity("owner", { viewer_mode: true })],
  ])("does not request endpoint data for %s", async (_label, current) => {
    mocks.whoami.mockResolvedValue(current);
    const { client, root } = render(InboundWebhooksPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Administrator access required",
        ),
      );
      expect(mocks.listEndpoints).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Create endpoint");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("does not request endpoint, trigger, or flow inventories for an editor", async () => {
    mocks.whoami.mockResolvedValue(identity("editor"));
    const { client, root } = render(InboundWebhookTriggersPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "No endpoint, trigger, or flow-target inventory was requested",
        ),
      );
      expect(mocks.getEndpoint).not.toHaveBeenCalled();
      expect(mocks.listTriggers).not.toHaveBeenCalled();
      expect(mocks.listFlows).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Add trigger");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("loads the admin inventory, then removes protected cache data on downgrade", async () => {
    const { client, root } = render(InboundWebhooksPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(endpoint.name),
      );
      expect(mocks.listEndpoints).toHaveBeenCalledTimes(1);

      await act(async () => {
        client.setQueryData(qk.authMe(), identity("editor"));
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Administrator access required",
        ),
      );
      expect(document.body.textContent).not.toContain(endpoint.name);
      const protectedData = client
        .getQueriesData({ queryKey: ["inbound-webhooks"] })
        .map(([, data]) => data)
        .filter((data) => data !== undefined);
      expect(protectedData).toEqual([]);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});

describe("inbound webhook fresh mutation authority", () => {
  it("re-checks authority for each endpoint in a bulk mutation", async () => {
    const secondEndpoint = {
      ...endpoint,
      id: "endpoint_2",
      slug: "quality-hook-two",
      name: "Quality hook two",
    };
    mocks.listEndpoints.mockResolvedValue({
      items: [endpoint, secondEndpoint],
    });
    const { client, root } = render(InboundWebhooksPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(secondEndpoint.name),
      );
      const first = document.querySelector<HTMLInputElement>(
        `input[aria-label="Select ${endpoint.name}"]`,
      );
      const second = document.querySelector<HTMLInputElement>(
        `input[aria-label="Select ${secondEndpoint.name}"]`,
      );
      if (!first || !second) throw new Error("Bulk endpoint controls missing");
      await act(async () => {
        first.click();
        second.click();
      });
      await waitFor(() => expect(button("Disable")).toBeTruthy());
      await act(async () => button("Disable").click());
      await waitFor(() =>
        expect(mocks.updateEndpoint).toHaveBeenCalledTimes(2),
      );
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateEndpoint.mock.invocationCallOrder[0]!,
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.updateEndpoint.mock.invocationCallOrder[1]!,
      );
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keeps a failed rotate confirmation retryable and re-checks authority", async () => {
    mocks.rotateEndpoint
      .mockRejectedValueOnce(new Error("Rotation transport failed"))
      .mockResolvedValueOnce({ endpoint, secret: "secret-once" });
    const { client, root } = render(InboundWebhooksPage);
    try {
      await waitFor(() =>
        expect(document.body.textContent).toContain(endpoint.name),
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Rotate signing secret"]',
      );
      if (!trigger) throw new Error("Rotate control missing");
      await act(async () => trigger.click());
      await act(async () => button("Rotate secret").click());
      await waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Rotation transport failed",
        ),
      );
      expect(mocks.rotateEndpoint).toHaveBeenCalledTimes(1);
      await act(async () => button("Rotate secret").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain("secret-once"),
      );
      expect(mocks.rotateEndpoint).toHaveBeenCalledTimes(2);
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("blocks endpoint creation when online authority was downgraded", async () => {
    mocks.whoamiFresh.mockResolvedValue(identity("editor"));
    const { client, root } = render(InboundWebhooksPage);
    try {
      await waitFor(() => expect(button("Create endpoint")).toBeTruthy());
      const name = document.getElementById("wh-name");
      if (!(name instanceof HTMLInputElement)) {
        throw new Error("Endpoint name input not found");
      }
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set?.call(name, "Stale endpoint");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        name.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => button("Create endpoint").click());
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(mocks.createEndpoint).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("authority changed");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("blocks a trigger toggle when online authority was downgraded", async () => {
    mocks.whoamiFresh.mockResolvedValue(identity("viewer"));
    const { client, root } = render(InboundWebhookTriggersPage);
    try {
      await waitFor(() => expect(button("Pause")).toBeTruthy());
      await act(async () => button("Pause").click());
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      expect(mocks.updateTrigger).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("authority changed");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});
