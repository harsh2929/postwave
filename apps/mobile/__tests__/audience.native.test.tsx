/**
 * Screen-level tests for the audience cluster.
 *
 * Before this file the cluster's ~2,900 lines were covered by one smoke render
 * in routes.native.test.tsx plus unit tests over pure helpers. Nothing tested
 * the branches that actually carry risk on these screens — which is where the
 * cluster's worst defect lived undetected: the lists stat strip summed `count`
 * over the rows it happened to hold and printed the result under the label
 * "Subscribers", even though the gateway forwards only `?query=` to Listmonk's
 * `/api/lists` and the client therefore holds one upstream page.
 *
 * What is asserted here, in order of how badly it would hurt to regress:
 *
 *  1. The lists strip NEVER labels a truncated sum with a workspace noun, and
 *     does use the plain noun once coverage is proven.
 *  2. A closed online gate renders a reconnect notice, not "no subscribers" —
 *     a manufactured negative claim about a tenant is the failure mode these
 *     screens are most prone to.
 *  3. Error before empty on both catalogues.
 *  4. The timeline facet control discloses that it filters only what is
 *     loaded, so an empty facet cannot read as a fact about the person.
 *
 * MOCK SHAPES. `__setQueryResultForTests` overrides EVERY useQuery /
 * useInfiniteQuery in the tree, so each test states the full result shape the
 * screen's hook really returns — `useListOptions` resolves to
 * `{ rows, total }`, not a bare array. A payload shaped like the wrong thing
 * passes only on its error path and hides every loaded-state assertion.
 */
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Lists from "../app/(tabs)/lists";
import Subscribers from "../app/(tabs)/subscribers";
import { TimelineFilterBar } from "../src/components/subscriber/TimelineFilterBar";

const reactQueryMock = require("./mocks/reactQuery.cjs");
const queryHooksMock = require("./mocks/queryHooks.cjs");

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>
  );
}

/**
 * `render` is asynchronous in this RNTL build — it returns a promise and the
 * tree is not mounted until it settles. Forgetting the await produces
 * "`render` function has not been called" from every query, which reads like
 * a mock problem and is not one.
 */
function draw(node: React.ReactElement) {
  return render(node, { wrapper });
}

/** The full shape `useListOptions` resolves to, with the query flags around it. */
function listsQuery(
  rows: { id: string; name: string; type?: string; optin?: string; count?: number }[],
  total: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: { rows, total },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    dataUpdatedAt: 0,
    refetch: jest.fn(async () => ({ data: undefined })),
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  };
}

/**
 * The full shape `useSubscribers` (an infinite query) resolves to. Asserting
 * against `{ data: [...] }` here would pass only on the error path and hide
 * every loaded-state claim below.
 */
function subscribersQuery(items: Record<string, unknown>[]) {
  return {
    data: { pages: [{ items, total: items.length }] },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: jest.fn(async () => undefined),
    refetch: jest.fn(async () => ({ data: undefined })),
    dataUpdatedAt: 0,
  };
}

const THREE_LISTS = [
  { id: "1", name: "Weekly digest", type: "public", optin: "double", count: 100 },
  { id: "2", name: "Beta testers", type: "private", optin: "single", count: 20 },
  { id: "3", name: "Ops", count: 5 },
];

afterEach(() => {
  reactQueryMock.__resetQueryResultForTests();
  queryHooksMock.__resetOnlineGateForTests();
  queryHooksMock.__resetHookResultsForTests();
});

describe("Lists — the stat strip may not present one page as the workspace", () => {
  it("labels the sum 'On loaded lists' and discloses the scope when the server holds more", async () => {
    reactQueryMock.__setQueryResultForTests(listsQuery(THREE_LISTS, 143));
    await draw(<Lists />);

    expect(screen.getByText("On loaded lists")).toBeTruthy();
    expect(screen.getByText("Lists loaded")).toBeTruthy();
    // The word that would make it a claim about the audience must be absent.
    expect(screen.queryByText("Subscribers")).toBeNull();
    expect(
      screen.getByText("Counts cover the 3 of 143 lists this screen has loaded."),
    ).toBeTruthy();
  });

  it("admits ignorance when the gateway echoes no total at all", async () => {
    reactQueryMock.__setQueryResultForTests(listsQuery(THREE_LISTS, null));
    await draw(<Lists />);

    expect(screen.getByText("On loaded lists")).toBeTruthy();
    expect(
      screen.getByText(/does not report a workspace total/),
    ).toBeTruthy();
  });

  it("uses the plain nouns, and no caveat, once coverage is proven", async () => {
    reactQueryMock.__setQueryResultForTests(listsQuery(THREE_LISTS, 3));
    await draw(<Lists />);

    // Via the cells' own grouped labels: "Lists" is also the screen title,
    // so a bare text query would match the header and prove nothing.
    expect(screen.getByLabelText("Subscribers: 125 subscribers")).toBeTruthy();
    expect(screen.getByLabelText("Lists: 3 lists")).toBeTruthy();
    expect(screen.queryByText("On loaded lists")).toBeNull();
    expect(screen.queryByText(/Counts cover/)).toBeNull();
  });

  it("speaks the caveat inside the value's own label, not only as a footnote", async () => {
    reactQueryMock.__setQueryResultForTests(listsQuery(THREE_LISTS, 143));
    await draw(<Lists />);

    expect(
      screen.getByLabelText(
        "On loaded lists: 125 subscribers across the 3 lists loaded",
      ),
    ).toBeTruthy();
  });
});

describe("Lists — the five-state ladder", () => {
  it("renders a failed load as an error, never as an empty catalogue", async () => {
    reactQueryMock.__setQueryResultForTests(
      listsQuery([], null, {
        data: undefined,
        isError: true,
        isSuccess: false,
        error: new Error("gateway exploded"),
      }),
    );
    await draw(<Lists />);

    expect(screen.queryByText("No lists yet")).toBeNull();
    expect(screen.getByLabelText("Retry")).toBeTruthy();
  });

  it("shows the reconnect notice — not 'No lists yet' — while the gate is closed", async () => {
    queryHooksMock.__setOnlineGateForTests({ enabled: false });
    reactQueryMock.__setQueryResultForTests(
      listsQuery([], null, { data: undefined, isSuccess: false }),
    );
    await draw(<Lists />);

    expect(screen.getByText("Reconnect to load lists")).toBeTruthy();
    expect(screen.queryByText("No lists yet")).toBeNull();
  });

  it("only claims an empty workspace when the load genuinely succeeded with no rows", async () => {
    reactQueryMock.__setQueryResultForTests(listsQuery([], 0));
    await draw(<Lists />);

    expect(screen.getByText("No lists yet")).toBeTruthy();
    // With no rows there is nothing to qualify, so the strip is hidden whole.
    expect(screen.queryByText("On loaded lists")).toBeNull();
  });

  it("survives a catalogue whose rows are not an array", async () => {
    // `lists.data?.rows ?? []` is a NULLISH guard and `rows` is fed straight
    // into `.filter` and into computeListsInventory. `useListOptions` is
    // snapshot-backed, and `loadSnapshotBacked` returns the stored blob's
    // `value` with no shape check (`isStored` proves only that `capturedAt` is
    // a number), so a projection from an older build reaches this screen as a
    // truthy non-array.
    reactQueryMock.__setQueryResultForTests(
      listsQuery([], null, { data: { rows: {}, total: null } }),
    );
    await expect(draw(<Lists />)).resolves.toBeTruthy();
  });
});

describe("Subscribers — a closed gate is never a claim about the tenant", () => {
  it("renders the reconnect notice instead of an empty-audience state", async () => {
    queryHooksMock.__setOnlineGateForTests({ enabled: false });
    // isLoading must be false or the empty ladder stops at the skeleton —
    // the gate branch sits BELOW loading and error, deliberately.
    queryHooksMock.__setHookResultForTests("useSubscribers", subscribersQuery([]));
    await draw(<Subscribers />);

    expect(screen.getByText("Reconnect to load subscribers")).toBeTruthy();
  });

  it("keeps cached rows readable but withholds the compliance write", async () => {
    // A restored-but-unvalidated session that still holds rows. Two claims in
    // one branch: the human status label is shown (never the Postgres enum),
    // and `onSuppress` is NOT wired — so the row publishes no Suppress action
    // to VoiceOver and a cached session cannot fire a compliance write.
    queryHooksMock.__setOnlineGateForTests({ enabled: false });
    queryHooksMock.__setHookResultForTests(
      "useSubscribers",
      subscribersQuery([
        {
          id: "s1",
          email: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          status: "blocklisted",
        },
      ]),
    );
    await draw(<Subscribers />);

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    // Through the ROW's own spoken label: "Unsubscribed" is also a filter
    // chip, so a bare text query would match the chip and prove nothing.
    expect(
      screen.getByLabelText(
        "Open Ada Lovelace, ada@example.com, Unsubscribed",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("blocklisted")).toBeNull();
    // The stale-data notice sits above the rows rather than replacing them.
    expect(
      screen.getByText(
        "Reconnect before refreshing subscribers. Showing the last loaded results.",
      ),
    ).toBeTruthy();
    const row = screen.getByLabelText(
      "Open Ada Lovelace, ada@example.com, Unsubscribed",
    );
    expect(
      (row.props.accessibilityActions ?? []).some(
        (a: { name?: string }) => a.name === "Suppress",
      ),
    ).toBe(false);
  });
});

describe("TimelineFilterBar — a filter over loaded pages must say so", () => {
  const counts = { all: 7, sends: 1, engagement: 2, problems: 2, lifecycle: 1 };

  it("renders nothing at all when there is nothing loaded to filter", async () => {
    await draw(
      <TimelineFilterBar
        facet="all"
        onChange={jest.fn()}
        counts={{ all: 0, sends: 0, engagement: 0, problems: 0, lifecycle: 0 }}
        shown={0}
        loaded={0}
        unclassified={0}
        hasMore={false}
      />,
    );
    // A prefix, not the exact "All": a rendered chip would be named with its
    // count ("All, 0"), and an exact query would pass even if the bar showed.
    expect(screen.queryByLabelText(/^All\b/)).toBeNull();
  });

  it("scopes a filtered count to what is loaded", async () => {
    await draw(
      <TimelineFilterBar
        facet="problems"
        onChange={jest.fn()}
        counts={counts}
        shown={2}
        loaded={7}
        unclassified={0}
        hasMore={false}
      />,
    );
    expect(screen.getByText(/2 of 7 loaded events/)).toBeTruthy();
  });

  it("warns that older pages exist, so an empty facet is not a verdict", async () => {
    await draw(
      <TimelineFilterBar
        facet="problems"
        onChange={jest.fn()}
        counts={counts}
        shown={0}
        loaded={200}
        unclassified={0}
        hasMore
      />,
    );
    expect(screen.getByText(/load older activity/)).toBeTruthy();
  });

  it("announces selection as state and reports the chosen facet", async () => {
    const onChange = jest.fn();
    await draw(
      <TimelineFilterBar
        facet="all"
        onChange={onChange}
        counts={counts}
        shown={7}
        loaded={7}
        unclassified={0}
        hasMore={false}
      />,
    );
    // Each facet is named with its loaded count, which the chip shows beside
    // the label (`counts` above): "All, 7", "Problems, 2".
    expect(
      screen.getByLabelText("All, 7").props.accessibilityState.selected,
    ).toBe(true);
    fireEvent.press(screen.getByLabelText("Problems, 2"));
    expect(onChange).toHaveBeenCalledWith("problems");
  });
});
