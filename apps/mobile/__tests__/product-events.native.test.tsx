import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import ProductEventsRoute, {
  ErrorBoundary as ProductEventsErrorBoundary,
} from "../app/(tabs)/product-events";
import { ProductEventsScreen } from "../src/components/product-events/ProductEventsScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");

jest.mock("@/hooks/useProductEvents", () => require("./mocks/queryHooks.cjs"));

// `mock`-prefixed so jest's module factory may close over it (the factory is
// hoisted above the declaration, and jest only whitelists that name shape).
const mockSetString = jest.fn(async (_value: string) => true);
jest.mock("expo-clipboard", () => ({
  setStringAsync: (value: string) => mockSetString(value),
}));

/**
 * The product-event catalogue has four ways to be rendered dishonestly, and a
 * "does it mount" test reaches none of them:
 *
 *   STALE READ AS ZERO — a silent event keeps its cumulative window total
 *     forever, so a volume-sorted list shows a dead integration as a big
 *     healthy number. The default order must lead with silence.
 *   ABSENT READ AS PRESENT — the catalogue is a GROUP BY inside the window
 *     (track/extras.go:240-252), so an event that stopped BEFORE the window has
 *     no row at all. The screen must say that; otherwise "my event isn't in the
 *     list" reads as reassurance.
 *   TRUNCATED READ AS COMPLETE — `LIMIT 200` with a pre-limit
 *     `totalDistinctEventNames`.
 *   FAILED READ AS EMPTY — a fetch error must never render "no events".
 *
 * Plus the one permission split on the surface: `/track/events` needs
 * `read:subscribers` on top of `read:reports` (track/handlers.go:92), so the
 * drill-down can 403 while the catalogue above it works.
 */

const AS_OF = "2026-07-26T12:00:00Z";

function catalogRow(over: Record<string, unknown> = {}) {
  return {
    eventName: "order.placed",
    count: 4821,
    uniqueSubscribers: 990,
    firstSeen: "2026-06-26T00:00:00Z",
    lastSeen: "2026-07-26T11:00:00Z",
    daily: [
      { date: "2026-07-20", count: 700 },
      { date: "2026-07-21", count: 690 },
    ],
    ...over,
  };
}

const CATALOG = {
  items: [
    catalogRow(),
    catalogRow({
      eventName: "cart.abandoned",
      count: 51,
      uniqueSubscribers: 40,
      lastSeen: "2026-07-23T12:00:00Z",
    }),
    catalogRow({
      eventName: "review.submitted",
      count: 1200,
      uniqueSubscribers: 300,
      lastSeen: "2026-07-08T12:00:00Z",
    }),
  ],
  totalDistinctEventNames: 3,
  periodDays: 30,
  dailySeriesPeriodDays: 7,
  eventBoundsScope: "period",
  timeZone: "UTC",
  asOf: AS_OF,
};

const STATS = {
  periodDays: 30,
  totalEvents: 6072,
  uniqueSubscribers: 1330,
  uniqueEventNames: 3,
  daily: [
    { date: "2026-07-20", count: 700 },
    { date: "2026-07-21", count: 690 },
  ],
  timeZone: "UTC",
  asOf: AS_OF,
};

const SAMPLE = {
  items: [
    {
      id: "90071992547409911",
      eventName: "order.placed",
      subscriberId: "11111111-1111-4111-8111-111111111111",
      occurredAt: "2026-07-26T11:00:00Z",
      receivedAt: "2026-07-26T11:00:02Z",
      propertyKeys: ["currency", "order_id", "total"],
      raw: '{\n  "id": 90071992547409911\n}',
    },
  ],
  requested: 20,
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

function loaded(over: { sample?: unknown; catalog?: unknown } = {}) {
  queryHooks.__setHookResultForTests(
    "useProductEventStats",
    queryResult({ data: STATS }),
  );
  queryHooks.__setHookResultForTests(
    "useProductEventCatalog",
    queryResult(
      (over.catalog as Record<string, unknown>) ?? { data: CATALOG },
    ),
  );
  queryHooks.__setHookResultForTests(
    "useProductEventSample",
    queryResult((over.sample as Record<string, unknown>) ?? {}),
  );
}

function renderScreen(Component: React.ComponentType = ProductEventsScreen) {
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
  mockSetString.mockClear();
});

describe("product-events route file", () => {
  /**
   * Renders the ROUTE ENTRY POINT, not just the inner component: Expo Router
   * mounts the default export of app/(tabs)/product-events.tsx, so a screen
   * that renders in isolation while the route file is broken is a screen
   * nobody can open.
   */
  it("mounts the default export the router actually loads", async () => {
    loaded();
    const result = await renderScreen(ProductEventsRoute);
    expect(result.getByText("Product events")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof ProductEventsErrorBoundary).toBe("function");
  });
});

describe("product-events catalogue", () => {
  it("leads with the silent event, not the busiest one", async () => {
    loaded();
    const result = await renderScreen();
    const names = result
      .getAllByRole("button")
      .map((node) => String(node.props.accessibilityLabel ?? ""))
      .filter((label) => label.includes("events from"));
    // review.submitted is 18 days quiet; order.placed has 4x its volume and is
    // an hour old. Volume order would bury the failure.
    expect(names[0]).toContain("review.submitted");
    expect(names[0]).toContain("Silent");
  });

  it("states the gap in days and never renders a stale event as zero", async () => {
    loaded();
    const result = await renderScreen();
    expect(
      result.getByLabelText(/^review\.submitted\. Silent\. No events for 18 days\./),
    ).toBeTruthy();
    // The row still carries its real cumulative total — the count is not the
    // thing that went stale, the last-seen is.
    expect(
      result.getByLabelText(/review\.submitted[\s\S]*1,200 events from 300 subscribers/),
    ).toBeTruthy();
  });

  it("says the denominator with the silent count", async () => {
    loaded();
    const result = await renderScreen();
    expect(
      result.getByText("1 of 3 events has sent nothing for a week or more."),
    ).toBeTruthy();
  });

  it("says out loud that an older stopped event is ABSENT, not zero", async () => {
    loaded();
    const result = await renderScreen();
    expect(
      result.getByText(
        "Only events seen in the last 30 days appear here. One that stopped before that is missing from this list, not zero — widen the window to find it.",
      ),
    ).toBeTruthy();
  });

  it("discloses the 200-row cap rather than presenting a page as the whole set", async () => {
    loaded({ catalog: { data: { ...CATALOG, totalDistinctEventNames: 312 } } });
    const result = await renderScreen();
    expect(
      result.getByText(
        "Showing the 3 busiest of 312 event names. The rest are on the web admin.",
      ),
    ).toBeTruthy();
  });

  it("admits an unknown freshness instead of aging against the device clock", async () => {
    // No `asOf` means no snapshot to measure against. The row must NOT fall
    // back to Date.now() — that is how a payload cached in a tunnel starts
    // reporting a live event as days old.
    loaded({
      catalog: { data: { ...CATALOG, asOf: "", eventBoundsScope: "period" } },
    });
    const result = await renderScreen();
    expect(
      result.getByLabelText(/^order\.placed\. Unknown\. The server didn't report/),
    ).toBeTruthy();
    expect(result.getAllByText("last seen not reported").length).toBe(3);
  });

  it("renders an error, never an empty catalogue, for a failed read", async () => {
    loaded({ catalog: { isError: true, error: { status: 500 } } });
    const result = await renderScreen();
    expect(result.queryByText("No events in this window")).toBeNull();
    expect(result.queryByText(/Only events seen in the last/)).toBeNull();
  });

  it("does not claim an empty workspace while offline", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    loaded({ catalog: { data: undefined } });
    const result = await renderScreen();
    expect(result.queryByText("No events in this window")).toBeNull();
    expect(
      result.getByText(
        "The event catalogue needs a connection. Reconnect and pull to refresh — this is not the same as receiving no events.",
      ),
    ).toBeTruthy();
  });
});

describe("product-events drill-down", () => {
  it("opens the newest raw rows and copies what the row SHOWS — never the property values", async () => {
    loaded({ sample: { data: SAMPLE } });
    const result = await renderScreen();

    await fireEvent.press(
      result.getByLabelText(/^order\.placed\. Live\./),
    );
    expect(result.getByText("The 1 newest event")).toBeTruthy();
    // Property KEYS, never the values: `Properties` is an untyped map that
    // routinely carries customer data (track/repo.go:35).
    expect(result.getByText("currency · order_id · total")).toBeTruthy();

    await fireEvent.press(
      result.getByLabelText(/^Event 90071992547409911, .*3 properties/),
    );
    // The comment above is the contract, and the copy used to break it: a
    // row-tap handed the server's raw JSON — property VALUES included — to
    // the clipboard. The copied text is now the shown shape: identity fields
    // and property KEYS, with no `properties` object at all.
    await waitFor(() => expect(mockSetString).toHaveBeenCalledTimes(1));
    const copied = String(mockSetString.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain('"event_name": "order.placed"');
    expect(copied).toContain('"property_keys"');
    expect(copied).toContain('"currency"');
    expect(copied).not.toContain('"properties"');
    await waitFor(() =>
      expect(result.getByText("Event copied — property values withheld, as shown.")).toBeTruthy(),
    );
  });

  it("explains the extra scope on a 403 instead of showing no rows", async () => {
    loaded({ sample: { isError: true, error: { status: 403 } } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^order\.placed\. Live\./));
    expect(
      result.getByText(/needs subscriber-read permission as well as report-read/),
    ).toBeTruthy();
    // The catalogue above it is unaffected — that route needs only read:reports.
    expect(result.getByLabelText(/^cart\.abandoned\. Quiet\./)).toBeTruthy();
  });

  it("collapses the row on a second press", async () => {
    loaded({ sample: { data: SAMPLE } });
    const result = await renderScreen();
    const row = () => result.getByLabelText(/^order\.placed\. Live\./);
    await fireEvent.press(row());
    expect(result.getByText("The 1 newest event")).toBeTruthy();
    await fireEvent.press(row());
    expect(result.queryByText("The 1 newest event")).toBeNull();
  });
});

describe("product-events activity strip", () => {
  it("ships the exact figure beside every compacted one", async () => {
    loaded();
    const result = await renderScreen();
    expect(result.getByLabelText("Events, 6,072 events")).toBeTruthy();
    expect(result.getByLabelText("Subscribers, 1,330 subscribers")).toBeTruthy();
  });

  it("names the window and the time zone the buckets are in", async () => {
    loaded();
    const result = await renderScreen();
    expect(
      result.getByText(/^Totals cover the last 30 days, in UTC days\. Measured /),
    ).toBeTruthy();
  });
});
