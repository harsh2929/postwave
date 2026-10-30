/**
 * Detail headers seed themselves from the list cache (LOVE#78).
 *
 * The defect: tapping a campaign row opened a screen whose header said
 * "Campaign" and nothing else for the whole detail round trip, even though the
 * row the operator had just tapped was still mounted one screen away with the
 * name in memory. Detail routes are siblings in the Tabs navigator, so the
 * list is not even unmounted — the data is right there.
 *
 * What is pinned here is the thing a unit test of `findCachedRow` cannot
 * reach: that the ROUTE addresses the cache root the LIST HOOK actually wrote
 * to. That is one shared builder (`campaignsQueryRootKey`), and if the two
 * ever drift the seed silently returns nothing and the header goes quietly
 * back to being blank — a regression with no error and no failing unit test.
 * So the mock filters positionally, exactly as TanStack's partial matching
 * does, and the assertions below fail if the prefix stops matching.
 *
 * Also pinned: the seed must LOSE to real data, and must never survive into a
 * screen about a different entity.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useCampaigns";
import * as ReactQuery from "@tanstack/react-query";

import CampaignDetail from "../app/(tabs)/campaigns/[id]";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ROUTE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

let mockRouteParams: Record<string, string> = { id: ROUTE_ID };

jest.mock("expo-router", () => {
  const actual = jest.requireActual<Record<string, unknown>>("expo-router");
  return { ...actual, useLocalSearchParams: () => mockRouteParams };
});

const hooks = QueryHooks as unknown as {
  __setHookResultForTests: (name: string, value: unknown) => void;
  __resetHookResultsForTests: () => void;
  __resetOnlineGateForTests: () => void;
};

const cache = ReactQuery as unknown as {
  __setCachedQueriesForTests: (entries: unknown[]) => void;
  __resetQueryResultForTests: () => void;
};

afterEach(() => {
  mockRouteParams = { id: ROUTE_ID };
  hooks.__resetHookResultsForTests();
  hooks.__resetOnlineGateForTests();
  cache.__resetQueryResultForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

/** The detail query still in flight — the whole window this seed covers. */
function stillLoading() {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: true,
    isLoading: true,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

function loaded(campaign: Record<string, unknown>) {
  return {
    data: campaign,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => ({ data: campaign })),
  };
}

/** The shape `useCampaignsPaginated` leaves under ["campaigns", tenantId, …]. */
function pagedCampaignsCache(rows: Record<string, unknown>[]) {
  return [
    [
      ["campaigns", TENANT, "paged", "", "u1", "admin", "network"],
      { pages: [rows], pageParams: [1] },
    ],
  ];
}

describe("campaign detail header, seeded from the list cache", () => {
  it("shows the tapped row's name while the detail request is still in flight", async () => {
    cache.__setCachedQueriesForTests(
      pagedCampaignsCache([
        { id: ROUTE_ID, name: "Spring launch", subject: "Spring is here" },
      ]),
    );
    hooks.__setHookResultForTests("useCampaign", stillLoading());
    await render(<CampaignDetail />, { wrapper });
    expect(screen.getByText("Spring launch")).toBeTruthy();
  });

  it("falls back to the row's subject when it has no name", async () => {
    cache.__setCachedQueriesForTests(
      pagedCampaignsCache([{ id: ROUTE_ID, subject: "Spring is here" }]),
    );
    hooks.__setHookResultForTests("useCampaign", stillLoading());
    await render(<CampaignDetail />, { wrapper });
    expect(screen.getByText("Spring is here")).toBeTruthy();
  });

  it("never borrows another campaign's identity", async () => {
    cache.__setCachedQueriesForTests(
      pagedCampaignsCache([{ id: OTHER_ID, name: "Somebody else's send" }]),
    );
    hooks.__setHookResultForTests("useCampaign", stillLoading());
    await render(<CampaignDetail />, { wrapper });
    expect(screen.queryByText("Somebody else's send")).toBeNull();
  });

  it("ignores a cache entry sitting under a DIFFERENT root", async () => {
    // The regression this guards: the route and the list hook spelling the
    // query key differently. A row cached under ["sequences", …] must not be
    // reachable from the campaigns root, and — more importantly — the passing
    // tests above must be passing because the prefix MATCHED, not because the
    // mock returned everything it had.
    cache.__setCachedQueriesForTests([
      [["sequences", TENANT], { items: [{ id: ROUTE_ID, name: "Wrong root" }] }],
    ]);
    hooks.__setHookResultForTests("useCampaign", stillLoading());
    await render(<CampaignDetail />, { wrapper });
    expect(screen.queryByText("Wrong root")).toBeNull();
  });

  it("loses to the loaded campaign the moment real data lands", async () => {
    cache.__setCachedQueriesForTests(
      pagedCampaignsCache([{ id: ROUTE_ID, name: "Stale list name" }]),
    );
    hooks.__setHookResultForTests(
      "useCampaign",
      loaded({
        id: ROUTE_ID,
        name: "Renamed on the server",
        subject: "Spring is here",
        status: "draft",
      }),
    );
    await render(<CampaignDetail />, { wrapper });
    expect(screen.getByText("Renamed on the server")).toBeTruthy();
    expect(screen.queryByText("Stale list name")).toBeNull();
  });
});
