// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A realtime event must reach the screens of a session whose effective role
// differs from its durable one: an owner acting as admin, or any operator
// previewing the workspace in viewer mode. Most screens key their reads by the
// effective role, but the dashboard's query provider handed the realtime
// invalidator the durable role, so for such a session an event about another
// operator's write — or a server job's — invalidated keys no screen used, and
// the index kept showing the old numbers until something else refetched it.
//
// The real provider and the real lists index, in front of an in-memory
// audience server. Only the event stream is replaced: the test captures the
// handler the invalidator registers and delivers the event itself.
//
// Some screens still key by the durable role (the suppressions page, the
// forms analytics panels), so the invalidator matches a tenant's resource
// under every role rather than trading one set of missed screens for another.

import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudienceServer } from "./_audience-server";
import { trackRoot, unmountRoots } from "./_roots";
import { importBeforeTests, waitFor } from "./pages/_wait";

type RealtimeHandler = (evt: { topic: string }) => void;

const mocks = vi.hoisted(() => ({
  server: null as unknown as import("./_audience-server").AudienceServer,
  whoami: vi.fn(),
  deliver: null as RealtimeHandler | null,
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: (path: string, opts?: { query?: Record<string, unknown> }) =>
        mocks.server.get(path, opts),
      post: (path: string, body?: unknown) => mocks.server.post(path, body),
      delete: (path: string) => mocks.server.delete(path),
    },
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));
vi.mock("@/lib/realtime/event-bus-client", () => ({
  connectRealtimeBus: (handler: RealtimeHandler) => {
    mocks.deliver = handler;
    return () => {
      if (mocks.deliver === handler) mocks.deliver = null;
    };
  },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/lists",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// An owner acting as admin: the durable and effective roles differ.
const OPERATOR = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "operator@example.com",
  role: "owner" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme Outfitters",
  workspace_slug: "acme",
};
const NEWSLETTER = {
  id: 7,
  postwaveUuid: "33333333-3333-4333-8333-333333333333",
  name: "Newsletter",
};
const BOB = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "bob@example.com" };

importBeforeTests(
  () => import("@/components/query-provider"),
  () => import("@/components/realtime-invalidator"),
  () => import("@/app/(dashboard)/app/lists/lists-admin-client"),
);

beforeEach(() => {
  mocks.server = new AudienceServer([NEWSLETTER], [BOB]);
  mocks.deliver = null;
  mocks.whoami.mockResolvedValue(OPERATOR);
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const indexCount = () =>
  /Newsletter[\s\S]*?(\d+) subscribers?/.exec(document.body.textContent ?? "")?.[1];

describe("realtime invalidation follows the effective role", () => {
  it("another operator's membership write reaches the lists index of an owner acting as admin", async () => {
    const [{ QueryProvider }, { ListsAdminClient }] = await Promise.all([
      import("@/components/query-provider"),
      import("@/app/(dashboard)/app/lists/lists-admin-client"),
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = trackRoot(container);
    act(() => {
      root.render(
        createElement(
          QueryProvider,
          { initialMe: OPERATOR },
          createElement(ListsAdminClient),
        ),
      );
    });
    await waitFor(() => {
      expect(indexCount()).toBe("0");
      expect(mocks.deliver).not.toBeNull();
    });

    // Another session adds Bob to the list; this tab learns of it only from
    // the event stream.
    await mocks.server.post(`/api/v1/lists/${NEWSLETTER.id}/subscribers`, {
      subscriber_ids: [BOB.id],
    });
    const listReadsBefore = mocks.server.requests.filter((r) =>
      r.startsWith("GET /api/v1/lists"),
    ).length;
    act(() => mocks.deliver!({ topic: "list.subscriber.added" }));

    // The invalidator batches events for two seconds before it invalidates.
    await waitFor(
      () => {
        expect(indexCount()).toBe("1");
      },
      { timeoutMs: 6_000 },
    );
    expect(
      mocks.server.requests.filter((r) => r.startsWith("GET /api/v1/lists"))
        .length,
    ).toBeGreaterThan(listReadsBefore);
  }, 15_000);

  it("invalidates the tenant's copies under every role, and nothing of another tenant's", async () => {
    const { RealtimeInvalidator } = await import(
      "@/components/realtime-invalidator"
    );
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const tenant = OPERATOR.tenant_id;
      const keys = {
        durableRoleScreen: ["lists", tenant, "owner"],
        effectiveRoleScreen: ["lists", tenant, "admin", { view: "index", q: "" }],
        viewerPreviewScreen: ["subscribers", tenant, "viewer", { page: 1 }],
        otherTenant: ["lists", "99999999-9999-4999-8999-999999999999", "admin"],
        otherResource: ["campaigns", tenant, "admin"],
      } as const;
      for (const key of Object.values(keys)) client.setQueryData(key, []);
      const container = document.createElement("div");
      document.body.append(container);
      const root = trackRoot(container);
      act(() => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(RealtimeInvalidator, { tenantId: tenant, role: "admin" }),
          ),
        );
      });
      expect(mocks.deliver).not.toBeNull();

      act(() => mocks.deliver!({ topic: "list.subscriber.added" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      const invalidated = Object.fromEntries(
        Object.entries(keys).map(([name, key]) => [
          name,
          client.getQueryState(key)?.isInvalidated ?? false,
        ]),
      );
      expect(invalidated).toEqual({
        durableRoleScreen: true,
        effectiveRoleScreen: true,
        viewerPreviewScreen: true,
        otherTenant: false,
        otherResource: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
