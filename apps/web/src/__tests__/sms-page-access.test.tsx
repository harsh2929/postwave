// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  loadSmsPageData: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami };
});
vi.mock("@/app/(dashboard)/app/sms/sms-page-data", () => ({
  loadSmsPageData: mocks.loadSmsPageData,
}));

import SmsPage from "@/app/(dashboard)/app/sms/page";
import {
  canAccessSmsAdminSurface,
  canonicalSmsTabUrl,
} from "@/app/(dashboard)/app/sms/sms-page-access";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function identity(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "22222222-2222-4222-8222-222222222222",
    tenant_id: "11111111-1111-4111-8111-111111111111",
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

beforeEach(() => {
  mocks.loadSmsPageData.mockReset();
  mocks.whoami.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SMS page access boundary", () => {
  it.each([
    ["effective viewer", identity({ effective_role: "viewer" })],
    ["view-as mode", identity({ viewer_mode: true })],
  ])("mounts no SMS request surface for %s", async (_label, me) => {
    mocks.whoami.mockResolvedValue(me);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      ["sms", me.tenant_id, "owner", me.user_id, "inbox-v2"],
      { private: "cached SMS body" },
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SmsPage />
        </QueryClientProvider>,
      );
    });
    await eventually(() => {
      expect(container.textContent).toContain("Owner or admin access required");
    });

    expect(mocks.loadSmsPageData).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === "sms"),
    ).toHaveLength(0);
  });

  it("uses only exact effective owner/admin authority", () => {
    expect(canAccessSmsAdminSurface(identity(), "owner")).toBe(true);
    expect(canAccessSmsAdminSurface(identity(), "admin")).toBe(true);
    expect(canAccessSmsAdminSurface(identity(), "editor")).toBe(false);
    expect(canAccessSmsAdminSurface(identity(), "viewer")).toBe(false);
    expect(
      canAccessSmsAdminSurface(identity({ viewer_mode: true }), "owner"),
    ).toBe(false);
    expect(canAccessSmsAdminSurface(null, "owner")).toBe(false);
  });

  it("omits the fallback tab while preserving canonical inbox deep links", () => {
    expect(
      canonicalSmsTabUrl(
        "https://app.example.test/app/sms?tab=inbox#panel",
        "overview",
      ),
    ).toBe("https://app.example.test/app/sms#panel");
    expect(
      canonicalSmsTabUrl("https://app.example.test/app/sms", "inbox"),
    ).toBe("https://app.example.test/app/sms?tab=inbox");
  });
});
