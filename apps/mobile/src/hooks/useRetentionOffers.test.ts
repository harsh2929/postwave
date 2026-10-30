import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useOnlineQueryGate: vi.fn(),
  useAuthStore: vi.fn(),
  listRetentionOffers: vi.fn(),
  fetchRetentionFunnel: vi.fn(),
  fetchWinbackSettings: vi.fn(),
  fetchPaywallTierNames: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({
  useOnlineQueryGate: mocks.useOnlineQueryGate,
}));
vi.mock("@/store/auth", () => ({ useAuthStore: mocks.useAuthStore }));
vi.mock("@/api/retentionOffers", () => ({
  listRetentionOffers: mocks.listRetentionOffers,
  fetchRetentionFunnel: mocks.fetchRetentionFunnel,
  fetchWinbackSettings: mocks.fetchWinbackSettings,
  fetchPaywallTierNames: mocks.fetchPaywallTierNames,
}));

import {
  usePaywallTierNames,
  useRetentionFunnel,
  useRetentionOffers,
  useWinbackSettings,
} from "./useRetentionOffers";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

let authState: {
  mode: "api_key" | "session" | null;
  session: { viewerMode: boolean } | null;
};

function queryOptions() {
  return mocks.useQuery.mock.calls.map(
    ([options]) =>
      options as {
        enabled: boolean;
        queryKey: readonly unknown[];
        queryFn: () => unknown;
      },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState = { mode: "session", session: { viewerMode: false } };
  mocks.useAuthStore.mockImplementation(
    (selector: (state: typeof authState) => unknown) => selector(authState),
  );
  mocks.useOnlineQueryGate.mockReturnValue({
    enabled: true,
    baseUrl: "https://api.postwave.test",
    tenantId: TENANT_ID,
    userId: USER_ID,
    effectiveRole: "owner",
    canReadOfflineSnapshots: true,
  });
  mocks.useQuery.mockImplementation((options) => options);
  mocks.listRetentionOffers.mockResolvedValue([]);
});

describe("retention query authority", () => {
  it.each([
    ["viewer mode", "owner", true, "session"],
    ["viewer role", "viewer", false, "session"],
    ["editor role", "editor", false, "session"],
    ["API-key mode", "owner", false, "api_key"],
  ] as const)(
    "issues zero protected requests for %s",
    (_label, effectiveRole, viewerMode, mode) => {
      authState = { mode, session: { viewerMode } };
      mocks.useOnlineQueryGate.mockReturnValue({
        ...mocks.useOnlineQueryGate(),
        effectiveRole,
      });

      useRetentionOffers();
      useRetentionFunnel();
      useWinbackSettings();
      usePaywallTierNames();

      expect(queryOptions()).toHaveLength(4);
      expect(queryOptions().every((options) => options.enabled === false)).toBe(
        true,
      );
      expect(mocks.listRetentionOffers).not.toHaveBeenCalled();
      expect(mocks.fetchRetentionFunnel).not.toHaveBeenCalled();
      expect(mocks.fetchWinbackSettings).not.toHaveBeenCalled();
      expect(mocks.fetchPaywallTierNames).not.toHaveBeenCalled();
    },
  );

  it("admits owner/admin sessions, binds the tenant decoder, and scopes the cache to identity", async () => {
    useRetentionOffers();
    const first = queryOptions()[0];
    expect(first?.enabled).toBe(true);
    expect(first?.queryKey).toEqual([
      "retention-offers",
      "list",
      TENANT_ID,
      USER_ID,
      "owner",
      "session",
      "member-mode",
    ]);
    await first?.queryFn();
    expect(mocks.listRetentionOffers).toHaveBeenCalledWith(TENANT_ID);

    mocks.useQuery.mockClear();
    mocks.useOnlineQueryGate.mockReturnValue({
      ...mocks.useOnlineQueryGate(),
      userId: "33333333-3333-4333-8333-333333333333",
      effectiveRole: "admin",
    });
    useRetentionOffers();
    expect(queryOptions()[0]?.queryKey).not.toEqual(first?.queryKey);
  });

  it("fails closed before request when the cached tenant identity is malformed", () => {
    mocks.useOnlineQueryGate.mockReturnValue({
      ...mocks.useOnlineQueryGate(),
      tenantId: "not-a-uuid",
    });
    useRetentionOffers();
    expect(queryOptions()[0]?.enabled).toBe(false);
  });
});
