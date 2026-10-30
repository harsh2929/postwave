// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSmsQuietHours: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/sms-scheduling-api", () => ({
  listSmsQuietHours: mocks.listSmsQuietHours,
}));
vi.mock("@/lib/sending-reputation-api", () => ({
  eligibleIsCounterfactual: () => false,
  getAutoSuppress: vi.fn(async () => ({
    active_suppressions: 0,
    auto_suppress: true,
    eligible_now: 0,
    observed_at: "2026-08-23T10:00:00Z",
  })),
  getSenderReputation: vi.fn(async () => []),
  getSendSettings: vi.fn(async () => ({ default_sto_strategy: "none" })),
  getSendingStatus: vi.fn(async () => ({
    bucket_count: 0,
    quiet_hours_per_recipient: false,
  })),
  getSpamTrapHits: vi.fn(async () => ({ hits: [] })),
  perRecipientTimingIsInert: () => false,
}));

import SendingHealthPage from "@/app/(dashboard)/app/sending-health/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

async function renderPage(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <SendingHealthPage />
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

beforeEach(() => {
  mocks.listSmsQuietHours.mockReset();
  mocks.whoami.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("sending-health SMS boundary", () => {
  it.each([
    ["effective viewer", { effective_role: "viewer", viewer_mode: false }],
    ["view-as owner", { effective_role: "owner", viewer_mode: true }],
  ])("makes zero SMS requests for %s", async (_label, role) => {
    mocks.whoami.mockResolvedValue({
      user_id: "22222222-2222-4222-8222-222222222222",
      tenant_id: "11111111-1111-4111-8111-111111111111",
      email: "viewer@example.test",
      role: "owner",
      effective_role: role.effective_role,
      viewer_mode: role.viewer_mode,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Test",
      workspace_slug: "test",
    });

    const container = await renderPage();
    expect(container.textContent).toContain("No SMS timing data was requested");
    expect(container.textContent).toContain(
      "sms_broadcast_dispatch_release_held",
    );
    expect(mocks.listSmsQuietHours).not.toHaveBeenCalled();
  });

  it("forwards cancellation only after exact effective-admin access", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "22222222-2222-4222-8222-222222222222",
      tenant_id: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.test",
      role: "admin",
      effective_role: "admin",
      viewer_mode: false,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Test",
      workspace_slug: "test",
    });
    mocks.listSmsQuietHours.mockResolvedValue([]);

    await renderPage();
    expect(mocks.listSmsQuietHours).toHaveBeenCalledTimes(1);
    expect(mocks.listSmsQuietHours).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { signal: expect.any(AbortSignal) },
    );
  });
});
