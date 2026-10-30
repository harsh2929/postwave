import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import GiftSubscriptionsRoute, {
  ErrorBoundary as GiftErrorBoundary,
} from "../app/(tabs)/gift-subscriptions";
import { GiftSubscriptionsScreen } from "../src/components/gift-subscriptions/GiftSubscriptionsScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useGiftSubscriptions", () =>
  require("./mocks/queryHooks.cjs"),
);

const ID = "a11ce001-1111-4111-8111-111111111111";

function gift(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    label: "Gift record A11CE001",
    planLabel: "Essentials Monthly",
    durationMonths: 12,
    status: "pending",
    createdAt: "2026-07-01T00:00:00Z",
    redeemedAt: null,
    expiresAt: "2027-07-01T00:00:00Z",
    canceledAt: null,
    messageRecorded: true,
    providerInvoiceLinked: true,
    gifterMemberLinked: false,
    recipientMemberLinked: false,
    issues: [],
    ...over,
  };
}

function page(over: Record<string, unknown> = {}) {
  return {
    items: [gift()],
    total: 25,
    limit: 24,
    offset: 0,
    snapshotAt: "2026-07-27T12:00:00Z",
    rejectedRows: 0,
    envelopeIssues: [],
    recognized: true,
    ...over,
  };
}

function stats(over: Record<string, unknown> = {}) {
  return {
    total: 25,
    pending: 5,
    paid: 1,
    redeemed: 12,
    cancelled: 3,
    expired: 2,
    refunded: 1,
    unclassified: 1,
    conversionRate: 12 / 18,
    generatedAt: "2026-07-27T12:00:00Z",
    issues: [],
    ...over,
  };
}

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: jest.fn(async () => ({ data: undefined })),
    ...over,
  };
}

function latestGiftListQuery(): {
  query: string;
  filter: string;
  sort: string;
} {
  const calls = queryHooks.__getHookCallsForTests("useGiftSubscriptions");
  return calls[calls.length - 1][0];
}

function withLoaded(
  over: {
    pages?: unknown[];
    stats?: unknown;
    fresh?: Record<string, unknown>;
    list?: Record<string, unknown>;
  } = {},
) {
  queryHooks.__setHookResultForTests(
    "useGiftSubscriptions",
    queryResult({
      data: { pages: over.pages ?? [page()], pageParams: [0] },
      ...over.list,
    }),
  );
  queryHooks.__setHookResultForTests(
    "useGiftStats",
    queryResult({ data: over.stats === undefined ? stats() : over.stats }),
  );
  queryHooks.__setHookResultForTests(
    "useGiftSubscription",
    queryResult(over.fresh),
  );
}

async function renderScreen(
  Component: React.ComponentType = GiftSubscriptionsScreen,
) {
  return await render(
    <ToastProvider>
      <Component />
    </ToastProvider>,
    {
      wrapper: ({ children }) => (
        <SafeAreaProvider
          initialMetrics={{
            frame: { height: 844, width: 390, x: 0, y: 0 },
            insets: { bottom: 34, left: 0, right: 0, top: 47 },
          }}
        >
          {children}
        </SafeAreaProvider>
      ),
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("Gift history route boundary", () => {
  it("mounts the router default and exports a local error boundary", async () => {
    withLoaded();
    const result = await renderScreen(GiftSubscriptionsRoute);
    expect(result.getByText("Gift history")).toBeTruthy();
    expect(typeof GiftErrorBoundary).toBe("function");
  });

  it("states the privacy and read-only boundary in plain language", async () => {
    withLoaded();
    const result = await renderScreen();
    expect(
      result.getByText("Lifecycle evidence, without identities"),
    ).toBeTruthy();
    expect(
      result.getByText(/recipient and purchaser emails.*remain unavailable/s),
    ).toBeTruthy();
  });
});

describe("sanitized archive presentation", () => {
  it("renders safe labels and counts without exposing opaque or injected secrets", async () => {
    withLoaded({
      pages: [
        page({
          items: [
            gift({
              purchaserEmail: "giver@example.com",
              message: "private greeting",
              redemptionUrl: "https://provider.invalid/secret",
            }),
          ],
        }),
      ],
    });
    const result = await renderScreen();
    expect(result.getByText("Gift record A11CE001")).toBeTruthy();
    expect(result.getByText(/Essentials Monthly/)).toBeTruthy();
    expect(result.queryByText(ID)).toBeNull();
    expect(result.queryByText("giver@example.com")).toBeNull();
    expect(result.queryByText("private greeting")).toBeNull();
    expect(result.queryByText(/provider\.invalid/)).toBeNull();
    expect(result.getByLabelText("25 records in total")).toBeTruthy();
    expect(result.getByLabelText("6 gifts still open")).toBeTruthy();
  });

  it("expands route-backed evidence and reports lifecycle drift", async () => {
    withLoaded({
      fresh: {
        data: gift({
          status: "redeemed",
          redeemedAt: "2026-07-20T00:00:00Z",
          planLabel: "Studio Annual",
          durationMonths: 24,
          providerInvoiceLinked: false,
        }),
      },
    });
    const result = await renderScreen();
    await fireEvent.press(
      result.getByLabelText(
        "Gift record A11CE001. Essentials Monthly. Pending.",
      ),
    );
    expect(
      result.getByText("Lifecycle changed from Pending to Redeemed."),
    ).toBeTruthy();
    expect(
      result.getByLabelText("Gift record A11CE001. Studio Annual. Redeemed."),
    ).toBeTruthy();
    expect(result.getByText(/Studio Annual · 24 months/)).toBeTruthy();
    expect(
      result.getByLabelText(/Evidence: .*Provider invoice: not recorded/),
    ).toBeTruthy();
  });

  it("contains contradictory rows as an integrity review", async () => {
    withLoaded({
      pages: [
        page({
          items: [gift({ status: "unclassified", issues: ["Bad status"] })],
        }),
      ],
    });
    const result = await renderScreen();
    expect(result.getByText("Some archive evidence needs review")).toBeTruthy();
    expect(
      result.getByLabelText(
        "Gift record A11CE001. Essentials Monthly. Data issue.",
      ),
    ).toBeTruthy();
  });

  it("sanitizes search input and describes an identity-free prefix search", async () => {
    withLoaded();
    const result = await renderScreen();
    const search = result.getByLabelText(
      "Search Gift history by record prefix",
    );
    await fireEvent.changeText(search, "Gift #A11CE001/@");
    expect(result.getByDisplayValue("Gift #A11CE001/@")).toBeTruthy();
    expect(
      result.getByText(/This edit is not sent.*last accepted prefix/s),
    ).toBeTruthy();
    await fireEvent.changeText(search, "Gift record A11CE001");
    expect(result.getByText(/opaque record prefix only/)).toBeTruthy();
  });

  it("retains the last accepted prefix while an invalid edit stays local", async () => {
    withLoaded();
    const result = await renderScreen();
    const search = result.getByLabelText(
      "Search Gift history by record prefix",
    );

    expect(latestGiftListQuery()).toMatchObject({ query: "" });
    await fireEvent.changeText(search, "Gift record A11CE001");
    expect(latestGiftListQuery()).toMatchObject({ query: "a11ce001" });

    await fireEvent.changeText(search, "recipient@example.invalid");
    expect(
      result.getByText(/This edit is not sent.*last accepted prefix/s),
    ).toBeTruthy();
    expect(latestGiftListQuery()).toMatchObject({ query: "a11ce001" });

    await fireEvent.changeText(search, "");
    expect(latestGiftListQuery()).toMatchObject({ query: "" });
  });
});

describe("independent remote states and pagination", () => {
  it("presents the initial aggregate read as loading, never failed or zero", async () => {
    withLoaded();
    queryHooks.__setHookResultForTests(
      "useGiftStats",
      queryResult({
        isFetching: true,
        isLoading: true,
        isPending: true,
      }),
    );
    const result = await renderScreen();
    expect(
      result.getByText(
        "Loading archive statistics. Counts remain unknown until the aggregate read lands; archive records load independently.",
      ),
    ).toBeTruthy();
    expect(result.getByLabelText("Records loading")).toBeTruthy();
    expect(result.queryByText(/Statistics are unavailable/)).toBeNull();
    expect(result.queryByLabelText("0 records in total")).toBeNull();
  });

  it("shows aggregate values as unknown when only stats fail", async () => {
    withLoaded({ stats: undefined });
    queryHooks.__setHookResultForTests(
      "useGiftStats",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    expect(
      result.getByLabelText("Records unavailable — unknown, not zero"),
    ).toBeTruthy();
    expect(result.getByText(/Statistics are unavailable/)).toBeTruthy();
    expect(result.getByText("Gift record A11CE001")).toBeTruthy();
    expect(result.queryByLabelText("0 records in total")).toBeNull();
  });

  it("distinguishes a genuine zero-resolved aggregate from unavailable statistics", async () => {
    withLoaded({
      stats: stats({
        pending: 20,
        paid: 5,
        redeemed: 0,
        cancelled: 0,
        expired: 0,
        refunded: 0,
        unclassified: 0,
        conversionRate: 0,
      }),
    });
    const result = await renderScreen();
    expect(result.getByLabelText("25 records in total")).toBeTruthy();
    expect(
      result.getByLabelText(
        "Archive conversion cannot be calculated because no gifts have resolved.",
      ),
    ).toBeTruthy();
    expect(result.getByText(/Archive conversion — · 0 resolved/)).toBeTruthy();
    expect(
      result.getByText(/No terminal gifts have resolved yet/),
    ).toBeTruthy();
    expect(result.queryByText(/Statistics are unavailable/)).toBeNull();
  });

  it("distinguishes a true empty archive from a failed read", async () => {
    withLoaded({ pages: [page({ items: [], total: 0 })] });
    const empty = await renderScreen();
    expect(empty.getByText("No Gift history yet")).toBeTruthy();
    await empty.unmount();

    queryHooks.__setHookResultForTests(
      "useGiftSubscriptions",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    queryHooks.__setHookResultForTests("useGiftStats", queryResult());
    queryHooks.__setHookResultForTests("useGiftSubscription", queryResult());
    const failed = await renderScreen();
    expect(failed.queryByText("No Gift history yet")).toBeNull();
  });

  it("loads more only through an explicit accessible control", async () => {
    const fetchNextPage = jest.fn(async () => undefined);
    withLoaded({
      list: { hasNextPage: true, fetchNextPage },
    });
    const result = await renderScreen();
    expect(result.getByText("Showing 1 of 25 matching records")).toBeTruthy();
    fireEvent.press(result.getByLabelText("Load more Gift history records"));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("renders offline as unknown rather than empty", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    queryHooks.__setHookResultForTests(
      "useGiftSubscriptions",
      queryResult({ isLoading: false, isPending: true }),
    );
    queryHooks.__setHookResultForTests("useGiftStats", queryResult());
    queryHooks.__setHookResultForTests("useGiftSubscription", queryResult());
    const result = await renderScreen();
    expect(result.getByText(/Gift history needs a connection/)).toBeTruthy();
    expect(result.queryByText("No Gift history yet")).toBeNull();
  });

  it("renders a role denial instead of an empty archive", async () => {
    queryHooks.__setHookResultForTests(
      "useGiftSubscriptions",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests("useGiftStats", queryResult());
    queryHooks.__setHookResultForTests("useGiftSubscription", queryResult());
    const result = await renderScreen();
    expect(result.getByText("Your role can't read Gift history")).toBeTruthy();
    expect(result.queryByText("No Gift history yet")).toBeNull();
  });
});
