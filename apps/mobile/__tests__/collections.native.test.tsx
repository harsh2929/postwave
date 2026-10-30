import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import CollectionsRoute, {
  ErrorBoundary as CollectionsErrorBoundary,
} from "../app/(tabs)/collections";
import { CollectionsScreen } from "../src/components/collections/CollectionsScreen";
import { ToastProvider } from "../src/components/Toast";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useCollections", () => require("./mocks/queryHooks.cjs"));

/**
 * The reference-collection catalogue has five ways to be rendered dishonestly,
 * and a "does it mount" test reaches none of them:
 *
 *   ABSENT READ AS ZERO — `row_count` is the only real count in a list row
 *     (`data` is stubbed to `[]` for every summary, repo.go:367). A missing
 *     count must print an em-dash, and a REPORTED zero must print "Empty" —
 *     they are different findings and only one of them is a failed import.
 *   A PAGE READ AS THE WORKSPACE — the list is a keyset page beside an exact
 *     filter-wide `total` (repo.go:113-119).
 *   REFERENCE DATA READ AS A LIVE PROMOTION — the `coupons` type is explicitly
 *     NOT the coupon-pool runtime (types.go:6-11).
 *   A PERMISSION SPLIT READ AS AN EMPTY COLLECTION — the rows need
 *     `write:subscribers` (handlers.go:48) while the catalogue needs only
 *     `read:subscribers` (handlers.go:47), so a viewer must be told, not shown
 *     an empty table.
 *   FAILED OR OFFLINE READ AS EMPTY — neither may render "no collections".
 */

const NOW = "2026-07-24T02:15:00Z";

function summary(over: Record<string, unknown> = {}) {
  return {
    id: "3f7b1f1e-2c5d-4a6b-9f0a-1d2e3f4a5b6c",
    name: "Summer codes",
    collectionType: "coupons",
    sourceType: "uploaded",
    rowCount: 4318,
    createdAt: "2026-07-01T09:00:00Z",
    updatedAt: NOW,
    ...over,
  };
}

const ITEMS = [
  summary(),
  summary({
    id: "aaaa1111-2222-4333-8444-555566667777",
    name: "Nightly promo feed",
    collectionType: "content",
    sourceType: "api",
    rowCount: 0,
  }),
  summary({
    id: "bbbb1111-2222-4333-8444-555566667777",
    name: "Send windows",
    collectionType: "schedule",
    sourceType: "manual",
    rowCount: null,
  }),
];

const DETAIL = {
  ...summary(),
  rows: [
    { code: "SUMMER10", amount: 10 },
    { code: "SUMMER20" },
  ],
};

function queryResult(over: Record<string, unknown>) {
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
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function loaded(
  over: {
    list?: Record<string, unknown>;
    detail?: Record<string, unknown>;
  } = {},
) {
  queryHooks.__setHookResultForTests(
    "useCollectionsList",
    queryResult(
      over.list ?? {
        data: { pages: [{ items: ITEMS, total: ITEMS.length, nextCursor: null }] },
      },
    ),
  );
  queryHooks.__setHookResultForTests(
    "useCollectionDetail",
    queryResult(over.detail ?? {}),
  );
}

function renderScreen(Component: React.ComponentType = CollectionsScreen) {
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
  authStore.__resetAuthStateForTests();
});

describe("collections route file", () => {
  it("mounts the default export the router actually loads", async () => {
    loaded();
    const result = await renderScreen(CollectionsRoute);
    expect(result.getByText("Collections")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof CollectionsErrorBoundary).toBe("function");
  });
});

describe("collections catalogue", () => {
  it("keeps an unreported count and a reported zero as different findings", async () => {
    loaded();
    const result = await renderScreen();
    // A count the server never sent.
    expect(
      result.getByLabelText(/^Send windows\..*Row count not reported\./),
    ).toBeTruthy();
    // `includeHiddenElements` because the trailing count column is
    // deliberately hidden from assistive tech — the Pressable's own label
    // already carries the exact figure as a sentence, and announcing both
    // reads the number twice. The PRINTED text still has to be right.
    expect(
      result.getByText("not reported", { includeHiddenElements: true }),
    ).toBeTruthy();
    // A count the server DID send, and which is the interesting failure.
    expect(
      result.getByLabelText(
        /^Nightly promo feed\..*0 rows — this collection holds nothing\./,
      ),
    ).toBeTruthy();
    expect(
      result.getByText("Empty", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("speaks the exact row count beside the compacted one", async () => {
    loaded();
    const result = await renderScreen();
    expect(result.getByLabelText(/^Summer codes\..*4,318 rows\./)).toBeTruthy();
  });

  it("names the source in the row's spoken label, not just its type", async () => {
    loaded();
    const result = await renderScreen();
    // "api" is the difference between a stale table being fine and being an
    // integration outage, and the word alone does not carry it.
    expect(
      result.getByLabelText(/Nightly promo feed\..*API — written through the API\./),
    ).toBeTruthy();
  });

  it("says the denominator when the page is not the whole set", async () => {
    loaded({
      list: {
        data: {
          pages: [{ items: ITEMS, total: 312, nextCursor: "eyJ2IjoxfQ" }],
        },
        hasNextPage: true,
      },
    });
    const result = await renderScreen();
    expect(result.getByText("Showing 3 of 312 collections.")).toBeTruthy();
    expect(result.getByLabelText("Load more collections")).toBeTruthy();
  });

  it("stays silent about coverage when the page IS the whole set", async () => {
    loaded();
    const result = await renderScreen();
    expect(result.queryByText(/^Showing \d/)).toBeNull();
    expect(result.queryByLabelText("Load more collections")).toBeNull();
  });

  it("refuses to let a coupons collection read as a live promotion", async () => {
    loaded();
    const result = await renderScreen();
    expect(
      result.getByText(/not the coupon pool that discounts issue codes from/),
    ).toBeTruthy();
  });

  it("drops the caveat when no coupons collection is on screen", async () => {
    loaded({
      list: {
        data: {
          pages: [{ items: [ITEMS[1]], total: 1, nextCursor: null }],
        },
      },
    });
    const result = await renderScreen();
    expect(
      result.queryByText(/not the coupon pool that discounts issue codes from/),
    ).toBeNull();
  });

  it("renders an error, never an empty catalogue, for a failed read", async () => {
    loaded({ list: { isError: true, error: { status: 500 } } });
    const result = await renderScreen();
    expect(result.queryByText("No reference collections")).toBeNull();
  });

  it("does not claim an empty workspace while offline", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    loaded({ list: { data: undefined } });
    const result = await renderScreen();
    expect(result.queryByText("No reference collections")).toBeNull();
    expect(
      result.getByText(
        "The collection catalogue needs a connection. Reconnect and pull to refresh — this is not the same as having no collections.",
      ),
    ).toBeTruthy();
  });
});

describe("collection rows", () => {
  it("shows the rows to an editor-or-better session and states the cap", async () => {
    loaded({ detail: { data: DETAIL } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(
      result.getByText(
        "Showing the first 2 of 4,318 rows. The rest are on the web admin.",
      ),
    ).toBeTruthy();
    expect(result.getByText("SUMMER10")).toBeTruthy();
  });

  it("says a field is absent from a row instead of leaving it silent", async () => {
    loaded({ detail: { data: DETAIL } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    // Row 2 has no `amount`. An import that dropped a column halfway through a
    // file IS the finding; a blank cell hides it.
    expect(
      result.getByLabelText("Row 2. code: SUMMER20. amount: not in this row"),
    ).toBeTruthy();
  });

  it("explains the editor floor to a viewer instead of showing an empty table", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    loaded();
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(
      result.getByText("Row contents need an editor session"),
    ).toBeTruthy();
    // The catalogue above it is unaffected — that route needs only
    // read:subscribers, which every role clears.
    expect(result.getByLabelText(/^Send windows\./)).toBeTruthy();
  });

  it("says the same thing for a LIVE 403, plus that the role may have changed", async () => {
    loaded({ detail: { isError: true, error: { status: 403 } } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(
      result.getByText("Row contents need an editor session"),
    ).toBeTruthy();
    expect(
      result.getByText(/The server refused this read just now/),
    ).toBeTruthy();
  });

  it("reports a 404 as a deletion, never as an empty collection", async () => {
    loaded({ detail: { isError: true, error: { status: 404 } } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(
      result.getByText(/no longer in this workspace/),
    ).toBeTruthy();
    expect(result.queryByText(/This collection exists but holds no rows/)).toBeNull();
  });

  it("calls a genuinely empty collection a real state, not a failed read", async () => {
    loaded({ detail: { data: { ...DETAIL, rowCount: 0, rows: [] } } });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(
      result.getByText(/This collection exists but holds no rows/),
    ).toBeTruthy();
  });

  it("strips text-direction characters from values and says it did", async () => {
    loaded({
      detail: {
        data: {
          ...DETAIL,
          rowCount: 1,
          rows: [{ code: "invoice\u202Efdp.exe" }],
        },
      },
    });
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Summer codes\./));
    expect(result.getByText("invoicefdp.exe")).toBeTruthy();
    expect(
      result.getByText(
        "Some values contained text-direction characters, which were removed so they could not reorder what you are reading.",
      ),
    ).toBeTruthy();
  });

  it("collapses the row on a second press", async () => {
    loaded({ detail: { data: DETAIL } });
    const result = await renderScreen();
    const row = () => result.getByLabelText(/^Summer codes\./);
    await fireEvent.press(row());
    expect(result.getByText("SUMMER10")).toBeTruthy();
    await fireEvent.press(row());
    expect(result.queryByText("SUMMER10")).toBeNull();
  });
});

describe("collections header", () => {
  it("carries the denominator into the header, not just the page count", async () => {
    loaded({
      list: {
        data: {
          pages: [{ items: ITEMS, total: 312, nextCursor: "eyJ2IjoxfQ" }],
        },
        hasNextPage: true,
      },
    });
    const result = await renderScreen();
    // "3 collections" beside a 312-collection workspace is the same lie the
    // coverage note exists to prevent, and the header is the line people quote.
    expect(result.getByText("3 of 312 collections")).toBeTruthy();
  });

  it("says the plain count when the page IS the whole set", async () => {
    loaded();
    const result = await renderScreen();
    // `getAllBy`: the search field's polite live region announces the same
    // count, which is deliberate — the header states it and the live region
    // repeats it when a query narrows the list.
    expect(result.getAllByText("3 collections").length).toBeGreaterThan(0);
  });
});
