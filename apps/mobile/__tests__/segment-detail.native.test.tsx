/**
 * Segment detail — the sentences this route is allowed to say about a segment
 * it has not loaded.
 *
 * WHY THIS FILE EXISTS. `app/(tabs)/segments/[id].tsx` had never been mounted
 * by anything: `segment-recompute.native.test.tsx` drives `SegmentSummaryCard`
 * directly, `route-tree` only checks the path exists, and `routes.native` does
 * not import it. So the route's own state ladder — the part that decides
 * between "loading", "gone", and "your session can't reach this" — had never
 * been executed.
 *
 * The ladder ends in a DEFINITE NEGATIVE CLAIM ("That segment no longer
 * exists"), which makes its guard conditions load-bearing. `useSegment` is
 * disabled without an id, and a disabled TanStack v5 query reports isLoading
 * false, isError false and no data — the exact shape a 404 produces. So a
 * malformed deep link, or a cold universal link that drops the param, told the
 * operator a segment had been deleted when the app was never told which
 * segment to open. The sibling route `campaigns/[id]` names that case
 * explicitly; this one did not.
 *
 * The harness sets ONE result for every useQuery in the module graph, and this
 * screen has two (the segment and its size history). Every assertion below is
 * about a state where BOTH are legitimately in the same condition — disabled,
 * errored, or resolved-to-nothing — so the shared payload is coherent rather
 * than a mock-shape coincidence.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import * as ExpoRouter from "expo-router";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import SegmentDetail from "../app/(tabs)/segments/[id]";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (value: Record<string, unknown> | null) => void;
};

const hookHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  hookHarness.__resetOnlineGateForTests();
  // Module state, not a jest.fn() — clearMocks does not reset it, so leaving
  // it set would hand the next suite's screen these params.
  routerHarness.__setSearchParamsForTests(null);
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

/** A query TanStack never ran: `enabled` was false. Not loading, not errored. */
function neverRan() {
  return {
    data: undefined,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    isPending: true,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

/** A fetch that resolved and found nothing — `fetchSegment` returns null. */
function resolvedEmpty() {
  return {
    data: null,
    error: null,
    isError: false,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: null })),
  };
}

function failed() {
  return {
    data: undefined,
    error: new Error("upstream unavailable"),
    isError: true,
    isLoading: false,
    isFetching: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: jest.fn(async () => ({ data: undefined })),
  };
}

const GONE = "That segment no longer exists.";

describe("segment detail route", () => {
  it("mounts at all", async () => {
    // The baseline this file is really for: nothing had ever rendered it.
    queryHarness.__setQueryResultForTests(resolvedEmpty());
    await render(<SegmentDetail />, { wrapper });
    expect(screen.getByText("Segment")).toBeTruthy();
  });

  it("does not claim the segment was deleted when the link had no id", async () => {
    // THE BUG. Without an id `useSegment` never runs, which is byte-identical
    // to a 404 in the query's flags — so the screen asserted a deletion it had
    // no evidence for. What it must say instead names the actual problem and
    // points somewhere the operator can act.
    routerHarness.__setSearchParamsForTests({ id: undefined });
    queryHarness.__setQueryResultForTests(neverRan());
    await render(<SegmentDetail />, { wrapper });
    expect(screen.queryByText(GONE)).toBeNull();
    expect(screen.getByText(/didn't include a segment/u)).toBeTruthy();
  });

  it("still reports a genuine 404 as gone", async () => {
    // The counterweight. Without it the assertion above would also pass for a
    // screen that had stopped reporting deleted segments altogether.
    routerHarness.__setSearchParamsForTests({ id: "seg-1" });
    queryHarness.__setQueryResultForTests(resolvedEmpty());
    await render(<SegmentDetail />, { wrapper });
    expect(screen.getByText(GONE)).toBeTruthy();
    expect(screen.queryByText(/didn't include a segment/u)).toBeNull();
  });

  it("does not report a failed load as a deleted segment", async () => {
    // Error wins over "gone" for the same reason it wins over "empty": a 500
    // is not evidence about what the workspace contains.
    routerHarness.__setSearchParamsForTests({ id: "seg-1" });
    queryHarness.__setQueryResultForTests(failed());
    await render(<SegmentDetail />, { wrapper });
    expect(screen.queryByText(GONE)).toBeNull();
    expect(screen.getByText(/Something went wrong loading this/u)).toBeTruthy();
  });

  it("says the session is cached rather than that the segment is gone", async () => {
    // Offline the query never runs either, so the same false claim was one
    // closed gate away.
    hookHarness.__setOnlineGateForTests({ enabled: false, tenantId: "t1" });
    routerHarness.__setSearchParamsForTests({ id: "seg-1" });
    queryHarness.__setQueryResultForTests(neverRan());
    await render(<SegmentDetail />, { wrapper });
    expect(screen.queryByText(GONE)).toBeNull();
    expect(screen.getByText(/Reconnect to load this segment/u)).toBeTruthy();
  });
});
