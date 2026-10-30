/**
 * Frequency caps — the header sentence is the whole screen's claim.
 *
 * The list body already goes through `QueryStates`, so a failed GET renders an
 * error there. But the LINE ABOVE THE LIST is computed straight off
 * `caps.data ?? []` and is an `accessibilityLiveRegion` — so on a 500, on a
 * closed gate, and on a role whose read never ran, it announced
 * "No frequency caps are configured." That is the app telling an operator the
 * workspace has nothing throttling its sends, on the strength of a request
 * that failed. It is also the sentence they would act on: the reason to open
 * this screen at all is "the send went to fewer people than expected".
 *
 * Second thing pinned here: `caps.data` is `FrequencyCap[]` only because the
 * queryFn normalises it. A RESTORED persisted cache is handed to the component
 * without passing through that queryFn (see lib/secureQueryPersister's schema
 * buster note), and `?? []` is a NULLISH guard that lets `{}` or `{items: []}`
 * through to `capsSummaryLine`, whose `.filter` then throws.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as Gate from "@/hooks/useOnlineQueryGate";

import FrequencyCapsRoute from "../app/(tabs)/frequency-caps";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = Gate as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** The exact sentence that must never be said on a failed/absent read. */
const ALL_CLEAR = "No frequency caps are configured.";

afterEach(() => {
  queryHarness.__resetQueryResultForTests();
  gateHarness.__resetOnlineGateForTests();
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

function cap(over: Record<string, unknown> = {}) {
  return {
    id: "cap-1",
    label: "Marketing email",
    channel: "email",
    messageType: "marketing",
    maxCount: 3,
    windowSeconds: 86_400,
    appliesTo: "all",
    active: true,
    ...over,
  };
}

describe("frequency caps — the header may not out-run the read", () => {
  it("does not claim 'none configured' when the list request FAILED", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ isError: true, error: new Error("boom") }),
    );
    await render(<FrequencyCapsRoute />, { wrapper });

    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
  });

  it("does not claim 'none configured' when the gate never ran the read", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(queryResult({}));
    await render(<FrequencyCapsRoute />, { wrapper });

    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
  });

  it("says it plainly when the read genuinely returned nothing", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({ data: [], isSuccess: true }),
    );
    await render(<FrequencyCapsRoute />, { wrapper });

    expect(screen.getByText(ALL_CLEAR)).toBeTruthy();
  });

  it("counts only the caps that are actually enforcing", async () => {
    queryHarness.__setQueryResultForTests(
      queryResult({
        data: [cap(), cap({ id: "cap-2", label: "SMS", active: false })],
        isSuccess: true,
      }),
    );
    await render(<FrequencyCapsRoute />, { wrapper });

    expect(screen.getByText("1 of 2 caps enforcing right now.")).toBeTruthy();
  });

  it("survives a restored cache whose payload is not an array", async () => {
    // `{items: []}` passes `?? []` and reaches `.filter`. A truthy non-array is
    // the shape a previous build's envelope would have persisted.
    queryHarness.__setQueryResultForTests(
      queryResult({ data: { items: [] }, isSuccess: true }),
    );

    await expect(render(<FrequencyCapsRoute />, { wrapper })).resolves.toBeDefined();
    expect(screen.queryByText(ALL_CLEAR)).toBeNull();
    // The headline says the read is unusable rather than inventing a count.
    expect(screen.getByText(/Caps couldn.t be read just now/)).toBeTruthy();
    // ...and the BODY must still resolve to one of the states. Surviving the
    // render is not enough: with `?? []` the object reaches QueryStates, whose
    // `isEmpty` is `undefined === 0` → false, so it renders its children and
    // the screen is a blank list with no rows, no empty state and no error —
    // indistinguishable from a hang. Only the shape guard produces a state.
    expect(screen.getByText("No frequency caps configured")).toBeTruthy();
  });
});
