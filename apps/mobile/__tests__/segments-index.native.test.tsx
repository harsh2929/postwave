/**
 * Segments catalogue — the list states, and the one shape that is not an array.
 *
 * `fetchSegments` normalises the bare-array/`{items}` drift into a real array,
 * so a LIVE response is safe. A RESTORED persisted cache is not: it is handed
 * to the component without ever passing through that queryFn (see the schema
 * buster in lib/secureQueryPersister), and `segments.data ?? []` is a NULLISH
 * guard that lets a truthy `{items: []}` through.
 *
 * What that costs on THIS screen, both of which are asserted below:
 *   - with a search term active, `rows` is `.filter`ed → the screen throws;
 *   - with no search term, the object is handed to FlatList, whose item count
 *     goes NaN — so neither rows NOR the empty state render, and the operator
 *     gets a silently blank catalogue with no way to tell it apart from a
 *     workspace that has no segments.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as ExpoRouter from "expo-router";

import * as Gate from "@/hooks/useOnlineQueryGate";

import Segments from "../app/(tabs)/segments/index";

const routerHarness = ExpoRouter as unknown as {
  __setSearchParamsForTests: (value: Record<string, unknown>) => void;
};

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
  // Module state, not a jest.fn() — `restoreMocks` does not clear it, so a
  // leaked `q` would narrow the next test's catalogue.
  routerHarness.__setSearchParamsForTests({});
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

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function segment(over: Record<string, unknown> = {}) {
  return {
    id: "seg-1",
    name: "Engaged readers",
    description: "Opened in the last 30 days",
    queryAst: null,
    lastCount: 1240,
    lastEvaluatedAt: "2026-08-15T09:00:00Z",
    isTemplate: false,
    createdAt: "2026-06-01T09:00:00Z",
    updatedAt: "2026-08-15T09:00:00Z",
    ...over,
  };
}

describe("segments catalogue", () => {
  it("renders a loaded segment", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ data: [segment()], isSuccess: true }),
    );
    await render(<Segments />, { wrapper });

    expect(screen.getByText("Engaged readers")).toBeTruthy();
  });

  it("says nothing about the workspace when the read FAILED", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ isError: true, error: new Error("boom") }),
    );
    await render(<Segments />, { wrapper });

    expect(screen.queryByText("No segments yet")).toBeNull();
  });

  it("renders the empty state when the read genuinely returned nothing", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ data: [], isSuccess: true }),
    );
    await render(<Segments />, { wrapper });

    expect(screen.getByText("No segments yet")).toBeTruthy();
  });

  it("does not go blank on a restored cache whose payload is not an array", async () => {
    // Truthy non-array: passes `?? []`, reaches FlatList as `data`, and takes
    // the item count to NaN — so the list renders neither rows nor the empty
    // state and the screen is indistinguishable from a hung one.
    queryHarness.__setQueryResultForTests(
      queryResult({ data: { items: [segment()] }, isSuccess: true }),
    );
    await render(<Segments />, { wrapper });

    expect(screen.getByText("No segments yet")).toBeTruthy();
  });

  it("survives the same non-array payload with a search term active", async () => {
    // The `q` param is this screen's DOCUMENTED entry point — a segment hit in
    // global search lands here with the hit's title pre-filled — so the
    // filtered path is the common one, not the exotic one. `?? []` lets the
    // object through to `.filter`, which does not exist on it, and the whole
    // route goes to its error boundary before a single row is drawn.
    routerHarness.__setSearchParamsForTests({ q: "engaged" });
    queryHarness.__setQueryResultForTests(
      queryResult({ data: { items: [segment()] }, isSuccess: true }),
    );
    await render(<Segments />, { wrapper });

    expect(screen.getAllByText("Segments").length).toBeGreaterThan(0);
    // Nothing usable came back, but the screen must not invent rows either.
    expect(screen.queryByText("Engaged readers")).toBeNull();
  });
});
