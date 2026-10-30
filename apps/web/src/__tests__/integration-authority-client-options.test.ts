// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

import { surfaceForCatalogItem } from "@/lib/catalog-connect-map";
import { crmApi } from "@/lib/crm-api";
import { slackIntegrationsApi } from "@/lib/integrations-api";
import { integrationsCatalogApi } from "@/lib/integrations-catalog-api";
import { reviewSurfaceApi } from "@/lib/integrations-surface-api";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: mocks.get,
      post: mocks.post,
      delete: mocks.delete,
    },
  };
});

const CATALOG = {
  schema_version: "1",
  target_public_entries: 0,
  target_native_managed: 0,
  honest_badges: [],
  categories: [],
  capabilities: [],
  counts: {},
  items: [],
};

function expectBoundedOptions(value: unknown, signal: AbortSignal) {
  expect(value).toMatchObject({
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation((path: string) => {
    if (path === "/api/v1/integrations/catalog") {
      return Promise.resolve(CATALOG);
    }
    if (path === "/api/v1/commerce/integrations") {
      return Promise.resolve([]);
    }
    if (path.endsWith("/oauth/availability")) {
      return Promise.resolve({ available: true });
    }
    if (path.startsWith("/api/v1/integrations/")) {
      return Promise.resolve([]);
    }
    return Promise.resolve({ items: [] });
  });
  mocks.post.mockResolvedValue({});
  mocks.delete.mockResolvedValue({});
});

describe("integration authority transport options", () => {
  it("makes catalog and connected-chat reads abortable, online-only, and single-attempt", async () => {
    const controller = new AbortController();

    await integrationsCatalogApi.get({ signal: controller.signal });
    await slackIntegrationsApi.list({ signal: controller.signal });

    expectBoundedOptions(mocks.get.mock.calls[0]?.[1], controller.signal);
    expectBoundedOptions(mocks.get.mock.calls[1]?.[1], controller.signal);
  });

  it("forwards the same bounded options through every generic surface lifecycle operation", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await reviewSurfaceApi.providers(options);
    await reviewSurfaceApi.list(options);
    await reviewSurfaceApi.create(
      { provider: "trustpilot", credentials_ref: "vault://reviews/key" },
      options,
    );
    await reviewSurfaceApi.sync("review-1", options);
    await reviewSurfaceApi.pause("review-1", options);
    await reviewSurfaceApi.disconnect("review-1", options);
    await reviewSurfaceApi.provisionIngest?.(
      { provider: "trustpilot" },
      options,
    );
    await reviewSurfaceApi.rotateIngest?.("review-1", options);

    for (const call of mocks.get.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
    for (const call of mocks.post.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
    for (const call of mocks.delete.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
  });

  it("forwards bounded options through CRM and commerce reads and writes", async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await crmApi.providers(options);
    await crmApi.list(options);
    await crmApi.oauthAvailability("salesforce", options);
    await crmApi.create(
      {
        provider: "salesforce",
        credentials_ref: "vault://crm/key",
      },
      options,
    );
    await crmApi.sync("crm-1", options);
    await crmApi.pause("crm-1", options);
    await crmApi.resume("crm-1", options);
    await crmApi.disconnect("crm-1", options);

    const commerce = surfaceForCatalogItem({
      category: "commerce",
      sources: ["commerce"],
    });
    expect(commerce).not.toBeNull();
    await commerce!.client.providers(options);
    await commerce!.client.list(options);
    await commerce!.client.create(
      {
        provider: "shopify",
        credentials_ref: "vault://commerce/key",
      },
      options,
    );
    await commerce!.client.sync("commerce-1", options);
    await commerce!.client.pause("commerce-1", options);
    await commerce!.client.disconnect("commerce-1", options);

    for (const call of mocks.get.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
    for (const call of mocks.post.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
    for (const call of mocks.delete.mock.calls) {
      expectBoundedOptions(call.at(-1), controller.signal);
    }
  });
});
