// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";

import { waitFor } from "./_wait";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listWebhooks: vi.fn(),
  listDeliveries: vi.fn(),
  getDelivery: vi.fn(),
  testWebhook: vi.fn(),
  replayDelivery: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/webhooks-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webhooks-api")>()),
  listWebhooks: mocks.listWebhooks,
  listDeliveries: mocks.listDeliveries,
  getDelivery: mocks.getDelivery,
  testWebhook: mocks.testWebhook,
  replayDelivery: mocks.replayDelivery,
}));

vi.mock("@/components/settings/webhook-owner-email-preference-card", () => ({
  WebhookOwnerEmailPreferenceCard: () => null,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import WebhooksPage from "@/app/(dashboard)/app/settings/webhooks/page";
import DeliveriesPage from "@/app/(dashboard)/app/settings/webhooks/[id]/deliveries/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const owner = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  user_id: "owner_1",
  tenant_id: "tenant_1",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Webhooks",
  workspace_slug: "webhooks",
  ...overrides,
});

const webhook = {
  id: "hook_1",
  tenantId: "tenant_1",
  url: "https://hooks.example.test/events",
  events: ["subscriber.created"] as const,
  status: "active" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const delivery = {
  id: 41,
  webhookId: "hook_1",
  event: "subscriber.created",
  statusCode: 500,
  attempt: 1,
  responseMs: 25,
  error: "receiver failed",
  at: "2026-09-01T00:00:00.000Z",
};

let root: Root | null = null;
let client: QueryClient | null = null;

async function render(ui: ReactNode): Promise<void> {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, { client: client as QueryClient }, ui),
    );
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === label,
  );
}

beforeEach(() => {
  mocks.listWebhooks.mockResolvedValue([webhook]);
  mocks.listDeliveries.mockResolvedValue([delivery]);
  mocks.getDelivery.mockResolvedValue({
    ...delivery,
    requestBody: '{"sensitive":"payload"}',
    payloadRetained: true,
  });
  mocks.testWebhook.mockResolvedValue({
    ok: true,
    statusCode: 200,
    responseMs: 12,
  });
  mocks.replayDelivery.mockResolvedValue({
    ok: true,
    replayed_delivery_id: delivery.id,
    webhook_id: webhook.id,
    event_type: delivery.event,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("outbound webhook page authority", () => {
  it.each([
    owner({ role: "editor", effective_role: "editor" }),
    owner({ effective_role: "viewer", viewer_mode: true }),
  ])(
    "suppresses protected endpoint reads for non-admin authority",
    async (identity) => {
      mocks.whoami.mockResolvedValue(identity);
      await render(createElement(WebhooksPage));
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "Owner or admin access required",
        ),
      );
      expect(mocks.listWebhooks).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "No endpoint or delivery data was fetched",
      );
    },
  );

  it("distinguishes identity failure and never starts the endpoint request", async () => {
    mocks.whoami.mockRejectedValue(new Error("session unavailable"));
    await render(createElement(WebhooksPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "identity could not be verified",
      ),
    );
    expect(mocks.listWebhooks).not.toHaveBeenCalled();
  });

  it("dedupes a same-tick test and blocks transport after a fresh downgrade", async () => {
    mocks.whoami.mockResolvedValue(owner());
    mocks.whoamiFresh.mockResolvedValue(
      owner({ role: "editor", effective_role: "editor" }),
    );
    await render(createElement(WebhooksPage));
    await waitFor(() => expect(buttons("Test").length).toBeGreaterThan(0));
    act(() => {
      buttons("Test")[0]?.click();
      buttons("Test")[0]?.click();
    });
    await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
    expect(mocks.testWebhook).not.toHaveBeenCalled();
  });

  it("purges the prior protected cache when authority downgrades", async () => {
    mocks.whoami.mockResolvedValue(owner());
    await render(createElement(WebhooksPage));
    await waitFor(() =>
      expect(document.body.textContent).toContain(webhook.url),
    );
    const activeClient = client as QueryClient;
    act(() => {
      activeClient.setQueryData(
        qk.authMe(),
        owner({ role: "editor", effective_role: "editor" }),
      );
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    expect(document.body.textContent).not.toContain(webhook.url);
    expect(
      activeClient
        .getQueryCache()
        .findAll({ queryKey: qk.settings("tenant_1", "owner", "webhooks") })
        .some((query) => query.state.data != null),
    ).toBe(false);
  });
});

describe("outbound webhook delivery authority", () => {
  const page = () =>
    createElement(DeliveriesPage, {
      params: Promise.resolve({ id: webhook.id }),
    });

  it("suppresses endpoint, delivery, and inspector reads for an editor", async () => {
    mocks.whoami.mockResolvedValue(
      owner({ role: "editor", effective_role: "editor" }),
    );
    await render(page());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    expect(mocks.listWebhooks).not.toHaveBeenCalled();
    expect(mocks.listDeliveries).not.toHaveBeenCalled();
    expect(mocks.getDelivery).not.toHaveBeenCalled();
  });

  it("dedupes same-tick replay and freezes the selected delivery", async () => {
    mocks.whoami.mockResolvedValue(owner());
    let resolveFresh: ((value: MeResponse) => void) | undefined;
    mocks.whoamiFresh.mockImplementation(
      () => new Promise<MeResponse>((resolve) => (resolveFresh = resolve)),
    );
    await render(page());
    await waitFor(() => expect(buttons("Redeliver").length).toBeGreaterThan(0));
    act(() => {
      buttons("Redeliver")[0]?.click();
      buttons("Redeliver")[0]?.click();
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFresh?.(owner());
      await flush();
    });
    expect(mocks.replayDelivery).toHaveBeenCalledTimes(1);
    expect(mocks.replayDelivery).toHaveBeenCalledWith(webhook.id, delivery.id, {
      signal: expect.any(AbortSignal),
    });
  });

  it("clears an inspected payload and its cache on identity downgrade", async () => {
    mocks.whoami.mockResolvedValue(owner());
    await render(page());
    await waitFor(() => expect(buttons("Inspect").length).toBeGreaterThan(0));
    act(() => buttons("Inspect")[0]?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("sensitive"),
    );
    const activeClient = client as QueryClient;
    act(() => {
      activeClient.setQueryData(
        qk.authMe(),
        owner({ role: "viewer", effective_role: "viewer" }),
      );
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    expect(document.body.textContent).not.toContain("sensitive");
    expect(
      activeClient
        .getQueryCache()
        .findAll({ queryKey: qk.settings("tenant_1", "owner", "webhooks") })
        .some((query) => query.state.data != null),
    ).toBe(false);
  });
});
