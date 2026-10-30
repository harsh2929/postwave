import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import CommerceRoute, {
  ErrorBoundary as CommerceErrorBoundary,
} from "../app/(tabs)/commerce";
import { CommerceScreen } from "../src/components/commerce/CommerceScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");
const widgetCommerce = require("./mocks/widgetCommerce.cjs");

jest.mock("@/hooks/useCommerce", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * The store-pipeline screen has three states that a "does it render" test
 * never reaches, and each one is a place where the app could state something
 * about the workspace that is not true:
 *
 *   403  — the LIST route is admin-scoped while the analytics route under it
 *          is not, so an editor session legitimately cannot enumerate stores.
 *          Rendering "No stores connected" there would be the app inventing a
 *          fact. It must say whose permission is missing.
 *   202  — "Resume sync" is accepted, not completed. The toast wording and the
 *          absence of an optimistic green state are the whole point.
 *   cursor vs status — a store can be "active" and still have a dead backfill.
 *          The card must lead with the cursor.
 */

const STORES = [
  {
    id: "int-1",
    provider: "shopify",
    shopDomain: "acme.myshopify.com",
    status: "active",
    lastSyncAt: "2026-07-25T09:00:00Z",
    errorMessage: "",
    sync: {
      tone: "failed" as const,
      label: "Sync stopped on an error",
      attempts: 3,
      lastError: "401 Unauthorized from Shopify",
      retryDue: false,
      complete: false,
      nextAttemptAt: "",
    },
  },
];

const ANALYTICS = {
  customers: 1240,
  products: 88,
  orders: 3120,
  revenueCents: 4_512_300,
  averageOrderCents: 14_462,
  currency: "EUR",
  ordersByStatus: [
    { status: "paid", count: 3000 },
    { status: "refunded", count: 120 },
  ],
  lastOrderAt: "2026-07-25T08:00:00Z",
};

function order(over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    sourceId: "shopify://order/450789469",
    reference: "450789469",
    customerEmail: "ada@example.com",
    status: "paid",
    statusClass: "paid" as const,
    totalCents: 12_500,
    currency: "EUR",
    orderedAt: "2026-07-25T08:00:00Z",
    campaignId: "",
    ...over,
  };
}

const ORDERS_PAGE = {
  items: [
    order(),
    order({ id: "ord-2", reference: "450789470", campaignId: "camp-9" }),
  ],
  nextCursor: "",
};

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function renderScreen(Component: React.ComponentType = CommerceScreen) {
  return render(
    React.createElement(ToastProvider, null, React.createElement(Component)),
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

describe("commerce route file", () => {
  /**
   * Renders the ROUTE ENTRY POINT, not just the inner component. Expo Router
   * mounts the default export of app/(tabs)/commerce.tsx, so a screen that
   * renders in isolation while the route file is broken is a screen nobody can
   * open — which is exactly the failure this whole surface was built to avoid.
   */
  it("mounts the default export the router actually loads", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    const result = await renderScreen(CommerceRoute);
    expect(result.getByText("Stores")).toBeTruthy();
  });

  /**
   * COMMERCE#63: a render crash in a provider-shaped payload must cost this
   * tab, not the app shell. Expo Router only honours a route-scoped boundary
   * when the file EXPORTS one under that exact name.
   */
  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof CommerceErrorBoundary).toBe("function");
  });
});

describe("commerce store-pipeline screen", () => {
  it("leads with the sync cursor, not the connection status", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    const result = await renderScreen();

    // Twice: the card title, and the section label for its numbers.
    expect(result.getAllByText("acme.myshopify.com").length).toBe(2);
    // "active" is the connection; the cursor is what says the data stopped.
    expect(result.getByText("Sync stopped on an error")).toBeTruthy();
    expect(
      result.getByText("401 Unauthorized from Shopify"),
    ).toBeTruthy();
  });

  it("formats revenue in the store's OWN currency, from integer cents", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    const result = await renderScreen();

    // 4,512,300 cents in EUR — never a hard-coded dollar sign, and never the
    // raw cents figure. `money` drops ".00" on a whole-unit tile figure.
    expect(result.getByLabelText("€45,123 Revenue")).toBeTruthy();
    // The average IS fractional, so it keeps its cents.
    expect(result.getByLabelText("€144.62 Avg order")).toBeTruthy();
    // A compacted count always ships the exact value to assistive tech.
    expect(result.getByLabelText("3,120 Orders")).toBeTruthy();
  });

  it("explains a 403 instead of claiming the workspace has no stores", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({}),
    );
    const result = await renderScreen();

    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No stores connected")).toBeNull();
  });

  it("still renders the error state for a NON-scope failure", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({}),
    );
    const result = await renderScreen();
    expect(result.queryByText("Needs an owner or admin session")).toBeNull();
    expect(result.queryByText("No stores connected")).toBeNull();
  });

  it("says a resume was REQUESTED, never that it completed", async () => {
    const mutate = jest.fn(
      (_id: unknown, opts: { onSuccess?: () => void } = {}) => {
        opts.onSuccess?.();
      },
    );
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests("useResumeCommerceSync", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    const result = await renderScreen();

    await fireEvent.press(
      result.getByLabelText("Resume the acme.myshopify.com sync"),
    );
    expect(mutate).toHaveBeenCalledWith("int-1", expect.any(Object));
    // 202 is "accepted". Wording that implied completion would be a lie.
    expect(
      result.getByText("Sync requested for acme.myshopify.com."),
    ).toBeTruthy();
  });

  it("surfaces the 422 'this provider can't be resumed here' answer verbatim", async () => {
    const mutate = jest.fn(
      (_id: unknown, opts: { onError?: (e: unknown) => void } = {}) => {
        opts.onError?.({ status: 422 });
      },
    );
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests("useResumeCommerceSync", {
      mutate,
      mutateAsync: async () => undefined,
      isPending: false,
      reset: () => undefined,
    });
    const result = await renderScreen();

    await fireEvent.press(
      result.getByLabelText("Resume the acme.myshopify.com sync"),
    );
    expect(
      result.getByText(
        "This provider can't be resumed from the app — it needs a sync run from the web admin.",
      ),
    ).toBeTruthy();
  });

  it("hides the resume action entirely while offline", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    const result = await renderScreen();
    // A commerce write is never queued for later replay — offering a button
    // that cannot reach the server is worse than not offering it.
    expect(
      result.queryByLabelText("Resume the acme.myshopify.com sync"),
    ).toBeNull();
  });

  /**
   * The aggregate cannot tell you whether ingest is CURRENT — a store whose
   * backfill died last Tuesday still totals 3,120 orders forever. These cover
   * the rows that distinguish "the numbers are big" from "still moving".
   */
  it("renders the newest orders and never presents the page as a total", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceOrders",
      queryResult({ data: ORDERS_PAGE }),
    );
    const result = await renderScreen();

    expect(result.getByText("Recent orders")).toBeTruthy();
    // The sample is disclosed as a sample, not stated as a count of all orders.
    expect(result.getByText("The 2 most recent orders")).toBeTruthy();
    // Per-ORDER currency, from integer cents (12,500 EUR cents = €125.00).
    expect(
      result.getByLabelText(
        /^Order 450789469, €125\.00, paid\. ada@example\.com\./,
      ),
    ).toBeTruthy();
  });

  it("scopes campaign attribution to the sample it was computed over", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceOrders",
      queryResult({ data: ORDERS_PAGE }),
    );
    const result = await renderScreen();

    // One of the two rows carries a campaign_id, and it is paid, so its
    // €125.00 counts. "of the last 2" is the load-bearing phrase.
    expect(
      result.getByText(
        "1 of the last 2 orders came from a campaign, worth €125.00 in paid orders.",
      ),
    ).toBeTruthy();
  });

  it("drops the attributed-revenue figure when the sample mixes currencies", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceOrders",
      queryResult({
        data: {
          items: [
            order({ id: "a", campaignId: "c1", currency: "EUR" }),
            order({ id: "b", campaignId: "c2", currency: "USD" }),
          ],
          nextCursor: "",
        },
      }),
    );
    const result = await renderScreen();

    // Adding euros to dollars would be a wrong total; a missing one is honest.
    expect(
      result.getByText("2 of the last 2 orders came from a campaign."),
    ).toBeTruthy();
  });

  it("shows an em-dash, not a currency zero, for an average that was never computed", async () => {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    // `Repo.Analytics` only assigns AverageOrderCents inside `if Orders > 0`
    // (repo.go:2588-2590), so this 0 means "never computed", not "zero euros".
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({
        data: { ...ANALYTICS, orders: 0, averageOrderCents: 0 },
      }),
    );
    const result = await renderScreen();

    expect(result.queryByLabelText("€0 Avg order")).toBeNull();
    expect(result.queryByLabelText("€0.00 Avg order")).toBeNull();
    expect(
      result.getByLabelText("No average yet — no orders ingested, Avg order"),
    ).toBeTruthy();
    // Revenue IS a real count(*)-backed measurement, so 0 there stays a 0.
    expect(result.getByLabelText("0 Orders")).toBeTruthy();
  });
});

/**
 * COMMERCE#70 — the home-screen widget's commerce record.
 *
 * This screen is the only foreground writer of it, and that is forced by the
 * API rather than chosen: the analytics route needs an integration id, and the
 * one route that can enumerate integrations is admin-scoped. So "which store"
 * is a decision made here and nowhere else.
 *
 * The three tests below are the three ways the publish could lie: naming a
 * store the screen isn't showing, stamping a cached number with the current
 * clock, or publishing a section heading as if it were a shop.
 */
describe("commerce widget mirror", () => {
  // `commerce_integrations.id` is `uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  // (infra/migrations/0028_mailchimp_compatibility.sql:378), and the record
  // carries that id so a background wake can re-read the SAME store without
  // the admin-scoped list route. A non-uuid is refused, so the fixture uses a
  // real shape rather than the "int-1" the other suites use.
  const STORE_ID = "3f2a1c4e-9b7d-4c2a-8e10-5b6d7f8a9c01";
  const UUID_STORES = [{ ...STORES[0], id: STORE_ID }];
  const FETCHED_AT = 1_774_000_000_000;

  function withAnalytics(over: Record<string, unknown> = {}) {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: UUID_STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS, dataUpdatedAt: FETCHED_AT, ...over }),
    );
  }

  it("publishes the selected store stamped with the FETCH time, not now", async () => {
    withAnalytics();
    await renderScreen();

    // `dataUpdatedAt`, never `Date.now()`: a phone parked on this tab with no
    // signal still renders the cached totals, and stamping that render with
    // the current clock would put a two-hour-old measurement on a home screen
    // as though it had just been taken.
    expect(widgetCommerce.writeCommerceWidgetSnapshot).toHaveBeenCalledWith({
      storeId: STORE_ID,
      storeLabel: "acme.myshopify.com",
      orders: 3120,
      revenueCents: 4_512_300,
      currency: "EUR",
      measuredAtMs: FETCHED_AT,
    });
  });

  it("publishes nothing when the analytics were never fetched", async () => {
    // No `dataUpdatedAt` means nothing has landed. An absent measurement is an
    // absence, and the widget's own empty state says so.
    withAnalytics({ data: undefined, dataUpdatedAt: 0 });
    await renderScreen();
    expect(widgetCommerce.writeCommerceWidgetSnapshot).not.toHaveBeenCalled();
  });

  it("never publishes the section heading as a shop name", async () => {
    // `activeName` falls back to "Store numbers" for the heading. That is UI
    // copy; putting it on a home screen would state it as a fact about a shop.
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS, dataUpdatedAt: FETCHED_AT }),
    );
    await renderScreen();
    expect(widgetCommerce.writeCommerceWidgetSnapshot).not.toHaveBeenCalled();
  });
});

/**
 * COMMERCE#25 — the recovery queue.
 *
 * The desktop's RecoveryTab is 1,408 lines of list+create across three
 * subscription types. What ports to a phone is the ONE number that represents
 * an unkept promise: rows the server marked `eligible` (the stock arrived, the
 * price dropped) that carry no `notified_at`. These tests pin the three ways
 * that number could be told dishonestly.
 */
describe("commerce recovery queue", () => {
  function withStore(recovery: Record<string, unknown>) {
    queryHooks.__setHookResultForTests(
      "useCommerceStores",
      queryResult({ data: STORES }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceAnalytics",
      queryResult({ data: ANALYTICS }),
    );
    queryHooks.__setHookResultForTests(
      "useCommerceRecovery",
      queryResult(recovery),
    );
  }

  it("counts only eligible rows, and always with their denominator", async () => {
    withStore({
      data: {
        items: [
          {
            id: "b1",
            kind: "back-in-stock",
            subject: "ada@example.com",
            status: "eligible",
            statusClass: "eligible",
            reference: "…ef123456",
            startedAt: "2026-07-20T00:00:00Z",
            eligibleAt: "2026-07-24T00:00:00Z",
            notifiedAt: "",
            originalPriceCents: null,
            targetPriceCents: null,
            minDropPercent: null,
            currency: "",
          },
          {
            id: "b2",
            kind: "back-in-stock",
            subject: "grace@example.com",
            status: "notified",
            statusClass: "notified",
            reference: "…ef123456",
            startedAt: "2026-07-19T00:00:00Z",
            eligibleAt: "2026-07-20T00:00:00Z",
            notifiedAt: "2026-07-21T00:00:00Z",
            originalPriceCents: null,
            targetPriceCents: null,
            minDropPercent: null,
            currency: "",
          },
        ],
        sampled: 2,
        hasMore: true,
      },
    });
    const result = await renderScreen();

    // "the newest 2", never a bare "1 waiting" that reads as a total.
    expect(
      result.getByText(/1 of the newest 2 is waiting to be told\./),
    ).toBeTruthy();
    expect(result.getByText("ada@example.com")).toBeTruthy();
  });

  it("states the quiet case positively instead of showing a zero", async () => {
    withStore({
      data: {
        items: [
          {
            id: "c1",
            kind: "carts",
            subject: "",
            status: "converted",
            statusClass: "converted",
            reference: "cart_42",
            startedAt: "2026-07-20T00:00:00Z",
            eligibleAt: "",
            notifiedAt: "",
            originalPriceCents: null,
            targetPriceCents: null,
            minDropPercent: null,
            currency: "",
          },
        ],
        sampled: 1,
        hasMore: false,
      },
    });
    const result = await renderScreen();

    expect(
      result.getByText(/Nothing is waiting to be told, across the only row\./),
    ).toBeTruthy();
    // A row with no email says so rather than rendering a blank line.
    expect(result.getByText("No email on the request")).toBeTruthy();
  });

  it("is an empty state, never a claim, when the store has no queue", async () => {
    withStore({ data: { items: [], sampled: 0, hasMore: false } });
    const result = await renderScreen();
    expect(result.getByText("Nobody is waiting on stock")).toBeTruthy();
  });

  it("keeps an unrecognised server status verbatim", async () => {
    withStore({
      data: {
        items: [
          {
            id: "b9",
            kind: "back-in-stock",
            subject: "ada@example.com",
            status: "quarantined",
            statusClass: "other",
            reference: "",
            startedAt: "2026-07-20T00:00:00Z",
            eligibleAt: "",
            notifiedAt: "",
            originalPriceCents: null,
            targetPriceCents: null,
            minDropPercent: null,
            currency: "",
          },
        ],
        sampled: 1,
        hasMore: false,
      },
    });
    const result = await renderScreen();
    expect(result.getByLabelText("Status: quarantined")).toBeTruthy();
  });
});
