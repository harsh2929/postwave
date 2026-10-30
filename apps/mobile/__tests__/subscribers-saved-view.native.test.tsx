/**
 * Subscribers — the saved-view WRITE seam (save the applied view, delete a
 * chip), asserted at the screen level.
 *
 * The lib rules (which views are saveable, the predicate shape, the delete
 * copy) are node-tested in src/lib/subscriberSavedSegmentDraft.test.ts and
 * the wire bodies in src/api/subscribersSavedSegments.test.ts. What none of
 * those can see is the SEAM this file pins: the screen hands the strip the
 * SETTLED view and a `canEdit` that is editor+ AND online AND un-gated. Get
 * that wire wrong and either a viewer is offered a verb that 403s, or an
 * editor loses the feature silently — both invisible to unit tests.
 *
 * Role honesty is the load-bearing claim: for a viewer the Save chip and the
 * delete gesture DO NOT EXIST (not disabled — absent).
 */
import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Subscribers from "../app/(tabs)/subscribers";

const reactQueryMock = require("./mocks/reactQuery.cjs");
const queryHooksMock = require("./mocks/queryHooks.cjs");
const expoRouterMock = require("./mocks/expoRouter.cjs");

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>{children}</SafeAreaProvider>
  );
}

/** render() returns a PROMISE in this RNTL build — every call is awaited. */
function draw(node: React.ReactElement) {
  return render(node, { wrapper });
}

/** The full infinite-query shape `useSubscribers` resolves to. */
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

/** One applicable saved bookmark, in the parseSavedSegments row shape. */
const SEGMENT_ROWS = [
  {
    id: "seg-1",
    name: "Engaged EU",
    description: "",
    visibility: "workspace",
    isPinned: false,
    lastCount: 41,
    lastEvaluatedAt: null,
    predicate: { filters: { status: "enabled", q: "" } },
  },
];

/** The saved-segments query resolves through the GLOBAL react-query mock. */
function primeSavedSegments() {
  reactQueryMock.__setQueryResultForTests({
    data: SEGMENT_ROWS,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: 0,
    refetch: jest.fn(async () => ({ data: undefined })),
  });
}

async function drawSubscribers(role: string) {
  queryHooksMock.__setOnlineGateForTests({ effectiveRole: role });
  queryHooksMock.__setHookResultForTests(
    "useSubscribers",
    subscribersQuery([{ id: "s1", email: "ada@acme.dev", status: "enabled" }]),
  );
  // A settled search term makes the view saveable (a bookmarkable narrowing)
  // and keeps the growth card out of the tree.
  expoRouterMock.__setSearchParamsForTests({ q: "acme" });
  primeSavedSegments();
  await draw(<Subscribers />);
}

afterEach(() => {
  reactQueryMock.__resetQueryResultForTests();
  queryHooksMock.__resetOnlineGateForTests();
  queryHooksMock.__resetHookResultsForTests();
  expoRouterMock.__setSearchParamsForTests({});
});

describe("Subscribers — saved-view save/delete affordances follow the editor floor", () => {
  it("offers an editor the Save-view chip and the long-press delete on a chip", async () => {
    await drawSubscribers("editor");
    expect(screen.getByText("+ Save view")).toBeTruthy();
    // The spoken save label carries what the bookmark reproduces.
    expect(
      screen.getByLabelText(/Save the current view as a segment/),
    ).toBeTruthy();
    // The delete gesture exists exactly when the role can use it, and it is
    // announced rather than being a secret gesture.
    expect(
      screen.getByHintText("Long press to delete this saved view."),
    ).toBeTruthy();
  });

  it("gives a viewer NEITHER the Save chip nor the delete gesture — absent, not disabled", async () => {
    await drawSubscribers("viewer");
    // The read half still renders: the bookmark strip itself is viewer-safe.
    expect(screen.getByText("Engaged EU")).toBeTruthy();
    expect(screen.queryByText("+ Save view")).toBeNull();
    expect(
      screen.queryByHintText("Long press to delete this saved view."),
    ).toBeNull();
  });

  it("withholds the write affordances from an editor who is offline", async () => {
    queryHooksMock.__setIsOnlineForTests(false);
    await drawSubscribers("editor");
    // A bookmark names the view on screen NOW — an offline-queued create
    // hours later would bookmark an abandoned search, so the verb is gone.
    expect(screen.queryByText("+ Save view")).toBeNull();
    expect(
      screen.queryByHintText("Long press to delete this saved view."),
    ).toBeNull();
  });
});
