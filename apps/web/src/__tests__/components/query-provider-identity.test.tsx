// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QueryProvider } from "@/components/query-provider";
import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  providerKeys: [] as string[],
  setOfflineIdentity: vi.fn(),
  resetOfflineIdentity: vi.fn(),
  setQueryData: vi.fn(),
  clearQuery: vi.fn(),
  removePersisted: vi.fn(async () => undefined),
  installOnlineBridge: vi.fn(),
}));

vi.mock("@/lib/query-client", () => ({
  buildCacheBuster: (userId: string, tenantId: string) =>
    `test:${userId}:${tenantId}`,
  idbPersister: { removeClient: mocks.removePersisted },
  makeQueryClient: () => ({
    setQueryData: mocks.setQueryData,
    clear: mocks.clearQuery,
  }),
  purgeLegacyQueryCache: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tanstack-online-bridge", () => ({
  installTanstackOnlineBridge: mocks.installOnlineBridge,
}));

vi.mock("@/lib/offline-storage-identity", () => ({
  setOfflineStorageIdentity: mocks.setOfflineIdentity,
  resetOfflineStorageIdentity: mocks.resetOfflineIdentity,
}));

vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { children: ReactNode }) => {
    mocks.providerKeys.push("mounted");
    return createElement("div", { "data-testid": "query-client" }, children);
  },
}));

vi.mock("@/components/realtime-invalidator", () => ({
  RealtimeInvalidator: () => null,
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.providerKeys.length = 0;
  document.body.innerHTML = "";
});

describe("QueryProvider identity boundary", () => {
  it("seeds the cache and persistence from the server-resolved identity", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          QueryProvider,
          {
            initialMe: {
              user_id: "user-a",
              tenant_id: "tenant-a",
              email: "owner@example.com",
              role: "owner",
              auth_provider: "password",
              email_verified: true,
              workspace_name: "Acme",
              workspace_slug: "acme",
            },
          },
          createElement("span", null, "private dashboard"),
        ),
      );
    });

    expect(container.textContent).toContain("private dashboard");
    expect(mocks.providerKeys).toEqual(["mounted"]);
    expect(mocks.setOfflineIdentity).toHaveBeenCalledWith("user-a", "tenant-a");
    expect(mocks.setQueryData).toHaveBeenCalledWith(
      ["auth-me"],
      expect.objectContaining({ user_id: "user-a", tenant_id: "tenant-a" }),
    );
    expect(mocks.installOnlineBridge).toHaveBeenCalledTimes(1);
    expect(mocks.clearQuery).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    expect(mocks.resetOfflineIdentity).toHaveBeenCalled();
  });

  it("purges live and persisted query memory on an in-place identity switch", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const me = (userId: string, tenantId: string): MeResponse => ({
      user_id: userId,
      tenant_id: tenantId,
      email: `${userId}@example.com`,
      role: "owner",
      auth_provider: "password",
      email_verified: true,
      workspace_name: tenantId,
      workspace_slug: tenantId,
    });

    await act(async () => {
      root.render(
        createElement(QueryProvider, { initialMe: me("user-a", "tenant-a") }),
      );
    });
    mocks.clearQuery.mockClear();
    mocks.removePersisted.mockClear();
    mocks.setOfflineIdentity.mockClear();

    await act(async () => {
      root.render(
        createElement(QueryProvider, { initialMe: me("user-b", "tenant-b") }),
      );
    });

    expect(mocks.clearQuery).toHaveBeenCalledTimes(1);
    expect(mocks.removePersisted).toHaveBeenCalledTimes(1);
    expect(mocks.setOfflineIdentity).toHaveBeenCalledWith("user-b", "tenant-b");
    expect(mocks.setQueryData).toHaveBeenLastCalledWith(
      ["auth-me"],
      expect.objectContaining({ user_id: "user-b", tenant_id: "tenant-b" }),
    );

    await act(async () => root.unmount());
  });
});
