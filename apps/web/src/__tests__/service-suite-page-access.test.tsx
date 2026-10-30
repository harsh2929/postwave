// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  getConfig: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/context-epoch", () => ({
  readContextEpoch: () => "epoch-service-suite-access",
  onContextEpochObserved: () => () => undefined,
}));
vi.mock("@/lib/use-app-origin", () => ({
  useAppOrigin: () => "https://app.postwave.test",
}));
vi.mock("@/lib/service-suite-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-suite-api")>()),
  getServiceSuiteCatalog: mocks.getCatalog,
  getServiceSuiteConfig: mocks.getConfig,
}));

import ServiceSuitePage from "@/app/(dashboard)/app/service-suite/page";
import { serviceSuiteIdentity } from "@/lib/service-suite-access";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const UPPERCASE_USER = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
    ...overrides,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

async function mount(client: QueryClient): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ServiceSuitePage />
      </QueryClientProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  mocks.getCatalog.mockReset();
  mocks.getConfig.mockReset();
  mocks.whoami.mockReset();
  mocks.getConfig.mockResolvedValue({
    tenantId: TENANT,
    version: "2026-08-24T10:00:00.1Z",
    status: "draft",
    orderHistoryEnabled: false,
    favoritesEnabled: false,
    couponsEnabled: false,
    recommendationsEnabled: false,
    customerAgentEnabled: false,
    runtimeAvailable: false,
    runtimeStatus: "held",
    runtimeReasonCode: "customer_hub_runtime_unavailable",
    customerAgentEffectiveEnabled: false,
    updatedAt: null,
  });
  mocks.getCatalog.mockResolvedValue({
    schemaVersion: "postwave.service_suite.v2",
    provenance: { tenantBound: false, source: "static_server_catalog" },
    channels: [],
    conversationStatuses: ["open"],
    capabilities: [],
    guardrail: {
      draftOnly: true,
      providerExecuted: false,
      customerMutations: false,
      requiresHumanReview: true,
    },
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("service-suite exact-admin boundary", () => {
  it.each([
    ["effective viewer", me({ effective_role: "viewer" })],
    ["view-as", me({ viewer_mode: true })],
    ["whitespace-wrapped tenant", me({ tenant_id: ` ${TENANT}` })],
    ["uppercase user", me({ user_id: UPPERCASE_USER })],
  ])("makes zero service-suite requests for %s", async (_label, identity) => {
    mocks.whoami.mockResolvedValue(identity);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      ["service-suite-v2", "retired-identity", TENANT, "private-config"],
      { private: "cached configuration" },
    );
    const container = await mount(client);
    await eventually(() => {
      expect(container.textContent).toContain(
        "Owner or admin access is required",
      );
    });
    expect(mocks.whoami).toHaveBeenCalledTimes(1);
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.getCatalog).not.toHaveBeenCalled();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === "service-suite-v2"),
    ).toHaveLength(0);
  });

  it("mounts only config and static catalog after fresh admin verification", async () => {
    mocks.whoami.mockResolvedValue(me({ effective_role: "admin" }));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = await mount(client);
    await eventually(() => {
      expect(container.textContent).toContain("Service suite availability");
      expect(mocks.getConfig).toHaveBeenCalledTimes(1);
      expect(mocks.getCatalog).toHaveBeenCalledTimes(1);
    });
    expect(mocks.getConfig).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.getCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).not.toMatch(
      /reply sent|live queue|macros defined/iu,
    );
  });

  it("keys authority to origin, tenant, user, role, and context epoch", () => {
    expect(
      serviceSuiteIdentity({
        me: me({ effective_role: "admin" }),
        origin: "https://app.postwave.test/path",
        contextEpoch: "epoch-one",
      })?.queryBase,
    ).toEqual(
      expect.arrayContaining([
        "https://app.postwave.test",
        TENANT,
        USER,
        "admin",
        "epoch-one",
      ]),
    );
    expect(
      serviceSuiteIdentity({
        me: me({ viewer_mode: true }),
        origin: "https://app.postwave.test",
        contextEpoch: "epoch-one",
      }),
    ).toBeNull();
    expect(
      serviceSuiteIdentity({
        me: me(),
        origin: "javascript:alert(1)",
        contextEpoch: "epoch-one",
      }),
    ).toBeNull();
    expect(
      serviceSuiteIdentity({
        me: me(),
        origin: "https://app.postwave.test",
        contextEpoch: "epoch\u202espoof",
      }),
    ).toBeNull();
    expect(
      serviceSuiteIdentity({
        me: me({ tenant_id: ` ${TENANT}` }),
        origin: "https://app.postwave.test",
        contextEpoch: "epoch-one",
      }),
    ).toBeNull();
    expect(
      serviceSuiteIdentity({
        me: me({ user_id: UPPERCASE_USER }),
        origin: "https://app.postwave.test",
        contextEpoch: "epoch-one",
      }),
    ).toBeNull();
  });
});
