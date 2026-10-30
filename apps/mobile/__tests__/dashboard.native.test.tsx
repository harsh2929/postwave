/**
 * Dashboard render contract (DASHBOARD#84).
 *
 * The app's most-visited screen had exactly one assertion against it: the
 * all-routes smoke row. Everything below is a claim the screen makes about
 * FACTS — and each one is a way the dashboard can lie rather than merely look
 * wrong:
 *
 *  - A FAILED LOAD IS NOT AN EMPTY WORKSPACE. The error path must show the
 *    taxonomy's copy and a working retry, never "0 subscribers".
 *  - A FAILED REFRESH OVER CACHED FIGURES IS A STALENESS BANNER, not an error
 *    card that destroys readable data over one bad poll.
 *  - ABSENCE IS AN EM-DASH, NOT A ZERO. A workspace with nothing reported and
 *    a workspace measured at zero are different facts.
 *  - A PERMISSION BOUNDARY NAMES ITSELF. A 403 must not render a grid of
 *    em-dashes, which reads as "your workspace is empty" rather than "you are
 *    not allowed to see this".
 *  - AN ANOMALY IS ANNOUNCED, NOT JUST TINTED.
 *
 * Assertions go through ACCESSIBILITY LABELS wherever the screen has one, so
 * the tile-grouping work is locked in alongside the values: a change that
 * splits a tile back into three VoiceOver stops fails here.
 *
 * `@tanstack/react-query` is module-mocked in this environment, so a single
 * override drives every direct useQuery on the screen. The goals and anomaly
 * hooks are stubbed individually below, because they are ALSO direct useQuery
 * callers and would otherwise be handed the stats payload.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

jest.mock("@/hooks/useGoals", () => ({
  useGoalsProgress: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/hooks/useDashboardAnomalies", () => ({
  useDashboardAnomalies: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/hooks/useWidgetMirror", () => ({
  useWidgetMirror: () => undefined,
}));
// The first-run checklist reads the shared onboarding schema, which is stubbed
// in this environment; it is a different surface with its own coverage.
jest.mock("@/components/onboarding/DashboardOnboarding", () => ({
  DashboardOnboarding: () => null,
}));

// eslint-disable-next-line import/first
import Dashboard from "../app/(tabs)/dashboard";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __setQueryResultForTests: (value: unknown) => void;
  __resetQueryResultForTests: () => void;
};
const gateHarness = QueryHooks as unknown as {
  __setOnlineGateForTests: (value: Record<string, unknown>) => void;
  __resetOnlineGateForTests: () => void;
};

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

function loaded(data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    dataUpdatedAt: Date.now(),
    fetchNextPage: jest.fn(async () => undefined),
    hasNextPage: false,
    refetch: jest.fn(async () => ({ data })),
    ...overrides,
  };
}

const STATS = {
  subscribers_total: 12_480,
  subscribers_added_30d: 148,
  subscribers_unsubbed_30d: 28,
  unique_opens_30d: 300,
  unique_delivered_30d: 1000,
  unique_sent_30d: 1010,
  unique_clicks_30d: 40,
  unique_bounces_30d: 10,
  campaigns_sent_30d: 4,
  active_sequences_count: 2,
  recent_audit: [],
};

describe("dashboard failure ladder", () => {
  it("shows the taxonomy's copy and a WORKING retry, never a zero workspace", async () => {
    const refetch = jest.fn(async () => ({ data: undefined }));
    queryHarness.__setQueryResultForTests(
      loaded(undefined, {
        error: Object.assign(new Error("Request failed with status code 500"), {
          status: 500,
        }),
        isError: true,
        isSuccess: false,
        data: undefined,
        refetch,
      }),
    );

    await render(<Dashboard />, { wrapper });

    // The stable copy, not the SDK's transport string.
    expect(
      screen.getByText(
        "Moosewave couldn't build your dashboard just now. This is on our side — try again shortly.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Request failed with status code 500"),
    ).toBeNull();

    fireEvent.press(screen.getByLabelText("Retry"));
    expect(refetch).toHaveBeenCalled();
  });

  it("keeps cached figures behind a staleness banner rather than an error card", async () => {
    queryHarness.__setQueryResultForTests(
      loaded(STATS, {
        error: Object.assign(new Error("boom"), { status: 500 }),
        isError: true,
      }),
    );

    await render(<Dashboard />, { wrapper });

    expect(
      screen.getByLabelText(
        "Showing previously loaded data; latest refresh failed",
      ),
    ).toBeTruthy();
    // The numbers survive the bad poll.
    expect(screen.getByLabelText(/^Subscribers, 12,480/)).toBeTruthy();
  });

  it("names a permission boundary and suppresses the grid entirely", async () => {
    // A grid of em-dashes here reads as "your workspace is empty" rather than
    // "you are not allowed to see this".
    queryHarness.__setQueryResultForTests(
      loaded(undefined, {
        error: Object.assign(new Error("forbidden"), { status: 403 }),
        isError: true,
        isSuccess: false,
        data: undefined,
      }),
    );

    await render(<Dashboard />, { wrapper });

    expect(screen.getByText("Metrics are restricted")).toBeTruthy();
    expect(screen.queryByLabelText(/^Subscribers,/)).toBeNull();
    // Retrying a role boundary is a button that can never work.
    expect(screen.queryByLabelText("Retry")).toBeNull();
  });
});

describe("absence is not zero", () => {
  it("keeps the variable-width freshness receipt in the content lane", async () => {
    queryHarness.__setQueryResultForTests(loaded(STATS));

    await render(<Dashboard />, { wrapper });

    expect(screen.getByTestId("dashboard-freshness")).toBeTruthy();
    expect(
      screen.getByLabelText("Share a workspace snapshot for Last 30 days"),
    ).toBeTruthy();
  });

  it("renders an em-dash for a metric the server did not report", async () => {
    queryHarness.__setQueryResultForTests(
      loaded({ subscribers_total: 12, campaigns_sent_30d: 2 }),
    );

    await render(<Dashboard />, { wrapper });

    // Open rate has no counts behind it in this payload.
    expect(screen.getByLabelText(/^Open rate, not reported/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Open rate, 0.0%/)).toBeNull();
  });

  it("still reports a genuine measured zero", async () => {
    queryHarness.__setQueryResultForTests(
      loaded({ ...STATS, subscribers_total: 0 }),
    );

    await render(<Dashboard />, { wrapper });
    expect(screen.getByLabelText(/^Subscribers, 0[,.]?/)).toBeTruthy();
  });
});

describe("anomalies", () => {
  it("announces a flagged metric instead of only tinting it", async () => {
    queryHarness.__setQueryResultForTests(
      loaded({ ...STATS, anomalies: { bounces: true } }),
    );

    await render(<Dashboard />, { wrapper });

    // Spoken on the tile itself…
    expect(screen.getByLabelText(/^Bounce rate,.*Unusual\./)).toBeTruthy();
    // …and stated once in full beneath the grid, where a 48%-wide cell
    // cannot fit the sentence.
    expect(
      screen.getByText(
        "Bounce rate: Bounce volume is unusually high against the trailing window.",
      ),
    ).toBeTruthy();
  });

  it("does not flag a metric the server never evaluated", async () => {
    queryHarness.__setQueryResultForTests(loaded(STATS));
    await render(<Dashboard />, { wrapper });
    expect(screen.queryByText("Unusual")).toBeNull();
  });
});
