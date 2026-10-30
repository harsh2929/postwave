// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "@/lib/approvals-api";
import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({ listApprovals: vi.fn() }));

vi.mock("@/lib/approvals-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approvals-api")>()),
  listApprovals: mocks.listApprovals,
}));

import { useNavBadges } from "@/lib/use-nav-badges";
import { qk } from "@/lib/query-keys";

const approval: Approval = {
  id: "approval-1",
  tenantId: "tenant-1",
  resourceType: "campaign",
  resourceId: "campaign-1",
  status: "pending",
  requestedAt: "2026-09-04T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};

function identity(patch: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "admin@example.test",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    ...patch,
  };
}

function BadgeProbe({ me }: { me: MeResponse | null }) {
  const badges = useNavBadges(me);
  return <output>{badges["/app/approvals"] ?? 0}</output>;
}

function testClient(me: MeResponse | null): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(qk.authMe(), me);
  return client;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  document.body.innerHTML = "";
});

describe("approval navigation badge authority", () => {
  it("makes zero protected reads for viewer mode", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const viewer = identity({ effective_role: "viewer", viewer_mode: true });
    const client = testClient(viewer);
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <BadgeProbe me={viewer} />
          </QueryClientProvider>,
        );
      });
      expect(container.textContent).toBe("0");
      expect(mocks.listApprovals).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("aborts and hides an old principal's pending count on downgrade", async () => {
    let resolveRead!: (value: Approval[]) => void;
    mocks.listApprovals.mockReturnValueOnce(
      new Promise<Approval[]>((resolve) => {
        resolveRead = resolve;
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const admin = identity();
    const client = testClient(admin);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <BadgeProbe me={admin} />
          </QueryClientProvider>,
        ),
      );
      await waitFor(() => expect(mocks.listApprovals).toHaveBeenCalledOnce());
      const signal = mocks.listApprovals.mock.calls[0]?.[2]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      await act(async () => {
        client.setQueryData(
          qk.authMe(),
          identity({ effective_role: "viewer", viewer_mode: true }),
        );
      });
      await waitFor(() => expect(signal?.aborted).toBe(true));
      expect(container.textContent).toBe("0");

      await act(async () => resolveRead([approval]));
      expect(container.textContent).toBe("0");
      expect(mocks.listApprovals).toHaveBeenCalledWith("pending", 100, {
        expectedTenantId: "tenant-1",
        signal,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears a loaded badge after a later poll fails", async () => {
    let poll: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      poll = handler as () => void;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    mocks.listApprovals
      .mockResolvedValueOnce([approval])
      .mockRejectedValueOnce(new Error("approval read denied"));
    const admin = identity();
    const client = testClient(admin);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <BadgeProbe me={admin} />
          </QueryClientProvider>,
        ),
      );
      await waitFor(() => expect(container.textContent).toBe("1"));
      expect(poll).toBeTypeOf("function");
      await act(async () => poll?.());
      await waitFor(() => expect(container.textContent).toBe("0"));
      expect(mocks.listApprovals).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });

  it("ignores an older overlapping poll after a newer denial", async () => {
    let poll: (() => void) | undefined;
    let resolveOldPoll!: (value: Approval[]) => void;
    const oldPoll = new Promise<Approval[]>((resolve) => {
      resolveOldPoll = resolve;
    });
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      poll = handler as () => void;
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    mocks.listApprovals
      .mockResolvedValueOnce([approval])
      .mockReturnValueOnce(oldPoll)
      .mockRejectedValueOnce(new Error("approval read denied"));
    const admin = identity();
    const client = testClient(admin);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <BadgeProbe me={admin} />
          </QueryClientProvider>,
        ),
      );
      await waitFor(() => expect(container.textContent).toBe("1"));
      await act(async () => poll?.());
      await waitFor(() => expect(mocks.listApprovals).toHaveBeenCalledTimes(2));
      await act(async () => poll?.());
      await waitFor(() => expect(container.textContent).toBe("0"));
      await act(async () => resolveOldPoll([approval]));
      expect(container.textContent).toBe("0");
    } finally {
      act(() => root.unmount());
    }
  });
});
