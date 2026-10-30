// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listKeys: vi.fn(),
  listProviders: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/byok-api", () => ({
  listByokKeys: mocks.listKeys,
  getByokProviders: mocks.listProviders,
}));

import EncryptionKeysPage from "@/app/(dashboard)/app/encryption-keys/page";

const admin = {
  user_id: "admin-user",
  tenant_id: "tenant-a",
  email: "admin@example.test",
  role: "admin" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
};
const viewer = {
  ...admin,
  user_id: "viewer-user",
  role: "viewer" as const,
  effective_role: "viewer" as const,
};

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(EncryptionKeysPage),
      ),
    );
  });
  return { client, container, root };
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

let mounted: Root | null = null;
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listKeys.mockResolvedValue([{ id: "key-1", alias: "private-key" }]);
  mocks.listProviders.mockResolvedValue({
    providers: ["aws"],
    supported: ["aws"],
  });
});

describe("admin-only read containment", () => {
  it("issues no protected transport for a viewer", async () => {
    mocks.whoami.mockResolvedValue(viewer);
    const view = mount();
    mounted = view.root;
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "No encryption-key configuration was fetched",
      ),
    );
    expect(mocks.listKeys).not.toHaveBeenCalled();
    expect(mocks.listProviders).not.toHaveBeenCalled();
  });

  it("issues no protected transport when identity verification fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("offline"));
    const view = mount();
    mounted = view.root;
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "No encryption-key request was made",
      ),
    );
    expect(mocks.listKeys).not.toHaveBeenCalled();
    expect(mocks.listProviders).not.toHaveBeenCalled();
  });

  it("removes protected data immediately on an admin-to-viewer transition", async () => {
    mocks.whoami.mockResolvedValue(admin);
    const view = mount();
    mounted = view.root;
    await waitFor(() =>
      expect(view.container.textContent).toContain("private-key"),
    );

    await act(async () => {
      view.client.setQueryData(["whoami"], viewer);
    });
    await waitFor(() =>
      expect(view.container.textContent).not.toContain("private-key"),
    );
    expect(view.container.textContent).toContain(
      "No encryption-key configuration was fetched",
    );
    expect(
      view.client
        .getQueryCache()
        .findAll({ queryKey: ["byok", "tenant-a", "admin"] })
        .some((query) => query.state.data !== undefined),
    ).toBe(false);
  });
});
