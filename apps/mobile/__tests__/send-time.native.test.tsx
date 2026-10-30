/**
 * Send time — the render contract for the heatmap surface.
 *
 * THE CLAIM THIS SCREEN COULD GET DANGEROUSLY WRONG is the one every
 * engagement heatmap gets wrong: painting "we have never sent into this hour"
 * as a 0% open rate. `finalizeBucket` (analysis.go:159) leaves `open_rate` at
 * the Go zero value when nothing was delivered AND nothing was sent, so the
 * wire cannot distinguish a flop from a gap — only the client can, and only by
 * reading the counts. The pure rules are pinned in src/lib/sendTimeAnalysis.test.ts;
 * this file proves they reach the screen instead of being quietly bypassed by a
 * component that formats the raw field.
 *
 * THE SECOND THING IT PINS IS THE AUTHORIZATION FLOOR. The route is behind
 * `RequireScope(ScopeReadReports, ScopeAdmin)`, which on the session path means
 * owner/admin (apikeys/middleware.go:332-458).
 *
 * Every role in this file is stated OUT LOUD. The shared gate fixture
 * (`__tests__/mocks/queryHooks.cjs`) defaults to `effectiveRole: "owner"`, so
 * an un-configured render is the most privileged session there is, not the
 * least. A locked-state test that leans on the default is therefore testing
 * an owner against a "must not see this" expectation, and it can only ever be
 * wrong in the direction that matters: it would go green the day the screen
 * started leaking to owners AND stay red while the gate was correct.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";
import { parseSendTimeAnalysis } from "@/lib/sendTimeAnalysis";

import SendTime from "../app/(tabs)/send-time";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

/** An admin session — the only role the API will answer this route for. */
function asAdmin() {
  gateHarness.__setOnlineGateForTests({ effectiveRole: "admin" });
}

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

function bucket(
  dayOfWeek: number,
  hourUTC: number,
  extra: Record<string, number> = {},
): Record<string, number> {
  return {
    day_of_week: dayOfWeek,
    hour_utc: hourUTC,
    sent: 0,
    delivered: 0,
    opened: 0,
    clicked: 0,
    open_rate: 0,
    click_rate: 0,
    score: 0,
    ...extra,
  };
}

/** The exact shape `useSendTimeAnalysis` resolves to. */
function loaded(buckets: Record<string, number>[]) {
  const data = parseSendTimeAnalysis({
    lookback_days: 90,
    generated_at: "2026-08-02T09:00:00Z",
    top_buckets: buckets,
    heatmap: buckets,
  });
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isRefetching: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data })),
  };
}

describe("the send-time authorization floor", () => {
  it("renders a locked state — and asks for NOTHING — below admin", async () => {
    // No effective role at all — a session whose role the app has not
    // resolved. `canAccessMinimumRole` normalizes that to "no role" and fails
    // closed, and this is the shape it must fail closed on.
    gateHarness.__setOnlineGateForTests({ effectiveRole: undefined });

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("Admin access required")).toBeTruthy();
    // The heatmap's metric switch must not be reachable from the locked state.
    expect(screen.queryByLabelText("Opens")).toBeNull();
  });

  it("renders a locked state for a viewer, not an error", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("Admin access required")).toBeTruthy();
  });

  it("opens for an admin", async () => {
    asAdmin();

    await render(<SendTime />, { wrapper });

    expect(screen.queryByText("Admin access required")).toBeNull();
    expect(screen.getAllByText("Send time").length).toBeGreaterThan(0);
  });
});

describe("the send-time screen", () => {
  it("offers the lookback windows and the metric switch", async () => {
    asAdmin();

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByText("90d")).toBeTruthy();
    expect(screen.getByText("180d")).toBeTruthy();
    expect(screen.getByLabelText("Overall")).toBeTruthy();
    expect(screen.getByLabelText("Opens")).toBeTruthy();
    expect(screen.getByLabelText("Audience")).toBeTruthy();
  });

  it("says NOTHING MEASURED — never a grid of zeroes — for a fresh workspace", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(loaded([]));

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("Nothing measured yet")).toBeTruthy();
  });

  it("ranks the strongest windows with their local and UTC times", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(2, 14, {
          sent: 1000,
          delivered: 980,
          opened: 400,
          clicked: 40,
          open_rate: 0.408,
          click_rate: 0.041,
          score: 0.49,
        }),
      ]),
    );

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("Tue 14:00 UTC")).toBeTruthy();
    expect(screen.getByText("Strongest windows · Overall")).toBeTruthy();
  });

  it("distinguishes a flop from a gap when a cell is opened", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        // Sent into, and it died. A REAL zero.
        bucket(1, 3, { sent: 800, delivered: 780, opened: 0, open_rate: 0 }),
        // Never sent into, but the audience is modelled to be there. NOT a zero.
        bucket(4, 9, { subscriber_signal: 120, score: 0.12 }),
      ]),
    );

    await render(<SendTime />, { wrapper });

    // Rank the flop by opens so its window row is reachable, then open it.
    await fireEvent.press(screen.getByLabelText("Audience"));
    await fireEvent.press(screen.getByLabelText(/Thu 09:00 UTC/));

    expect(
      screen.getByText(
        /Nothing has been sent into this hour in this window, so there is no/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("120 subscribers are modelled to read at this hour."),
    ).toBeTruthy();
    // The em-dash, not "0.0%": the rate was never measured here.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("reports a real zero as a real zero", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(1, 3, {
          sent: 800,
          delivered: 780,
          opened: 0,
          clicked: 0,
          open_rate: 0,
          click_rate: 0,
          subscriber_signal: 5,
          score: 0.005,
        }),
      ]),
    );

    await render(<SendTime />, { wrapper });

    await fireEvent.press(screen.getByLabelText(/Mon 03:00 UTC/));

    expect(screen.getAllByText("0.0%").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Nothing has been sent into this hour/)).toBeNull();
  });

  it("names the denominator every rate on the screen is a rate of", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(0, 0, {
          sent: 1200,
          delivered: 1100,
          opened: 300,
          clicked: 25,
          open_rate: 0.272,
          click_rate: 0.022,
          score: 0.316,
        }),
      ]),
    );

    await render(<SendTime />, { wrapper });

    expect(screen.getByText("What this is measured over")).toBeTruthy();
    expect(
      screen.getByText(
        /1,200 sent · 1,100 delivered · 300 opened · 25 clicked, across 1 of the week's 168 hours\./,
      ),
    ).toBeTruthy();
  });

  it("warns when a rate rests on too few messages to mean anything", async () => {
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(5, 20, {
          sent: 12,
          delivered: 11,
          opened: 7,
          open_rate: 0.636,
          score: 0.636,
        }),
      ]),
    );

    await render(<SendTime />, { wrapper });

    await fireEvent.press(screen.getByLabelText(/Fri 20:00 UTC/));

    expect(screen.getByText(/Only 11 messages landed in this hour/)).toBeTruthy();
  });

  it("re-reads the open cell after a refetch instead of freezing its counts", async () => {
    // The failure this pins: holding the selected BUCKET OBJECT rather than its
    // coordinates. A refetch replaces the whole grid, and the detail card would
    // go on printing the previous response's counts under a heatmap that had
    // already moved on — two copies of one measurement, free to disagree.
    asAdmin();
    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(1, 3, {
          sent: 800,
          delivered: 780,
          opened: 78,
          open_rate: 0.1,
          score: 0.1,
        }),
      ]),
    );

    const view = await render(<SendTime />, { wrapper });
    await fireEvent.press(screen.getByLabelText(/Mon 03:00 UTC/));
    expect(screen.getByText("780")).toBeTruthy();

    queryHarness.__setQueryResultForTests(
      loaded([
        bucket(1, 3, {
          sent: 1600,
          delivered: 1590,
          opened: 318,
          open_rate: 0.2,
          score: 0.2,
        }),
      ]),
    );
    await view.rerender(<SendTime />);

    expect(screen.getByText("1590")).toBeTruthy();
    expect(screen.queryByText("780")).toBeNull();
  });

  it("says a metric is unplottable rather than drawing an empty week", async () => {
    asAdmin();
    // Audience signal only: nothing has ever been sent, so Opens has no grid.
    queryHarness.__setQueryResultForTests(
      loaded([bucket(3, 11, { subscriber_signal: 60, score: 0.06 })]),
    );

    await render(<SendTime />, { wrapper });

    await fireEvent.press(screen.getByLabelText("Opens"));

    expect(
      screen.getByText(/Nothing was sent in the last 90 days, so there is no/),
    ).toBeTruthy();
  });
});
