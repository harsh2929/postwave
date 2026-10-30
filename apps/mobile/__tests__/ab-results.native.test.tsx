/**
 * A/B results render contract.
 *
 * This screen reads a payload nobody on the mobile side controls, and its
 * ladder has SIX rungs (no id → loading → endpoint absent → offline → load
 * failure → no variants → results) whose ORDER is the entire design. Three of
 * those rungs were untested and each one, if it fires in the wrong order, tells
 * the operator something false:
 *
 *   - a 404 from a deployment that never enabled the engagement reader must
 *     read as a capability boundary, NOT as "this test failed to load";
 *   - a malformed 200 (a proxy's HTML error page, `{}` from an older gateway)
 *     must fall through `isValidResult` to a stated failure, never into a
 *     render that indexes `result.variants` and crashes the route;
 *   - a test with zero variants for this metric is empty, not broken.
 *
 * `getABResults` returns the mobile result envelope, so the query's `data` is
 * `{ data, error }` — the tests below drive that shape directly, which is
 * exactly what the route destructures.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

import { ConfirmProvider } from "../src/components/ConfirmSheet";

import ABResults from "../app/(tabs)/campaigns/[id]/ab-results";

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

function settled(envelope: unknown) {
  return {
    data: envelope,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(async () => ({ data: envelope })),
  };
}

function resultsPayload(
  variants: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    campaign_id: "c1",
    metric: "open_rate",
    variants,
    frequentist: {},
    bayesian: {},
    bonferroni: {
      num_comparisons: 0,
      family_alpha: 0.05,
      corrected_alpha: 0.05,
      applied_to_frequentist: true,
    },
  };
}

describe("A/B results state ladder", () => {
  it("reads a missing endpoint as a capability boundary, not as a failed load", async () => {
    queryHarness.__setQueryResultForTests(
      settled({ data: null, error: { status: 404, message: "not found" } }),
    );

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("A/B results unavailable")).toBeTruthy();
    expect(screen.queryByText("Couldn't load A/B results")).toBeNull();
    expect(screen.queryByText("No variants yet")).toBeNull();
  });

  it("falls through the payload guard instead of crashing on a malformed 200", async () => {
    // A proxy's HTML error page, or `{}` from a gateway that predates the
    // reader. Either would index `result.variants` and tear down the route.
    queryHarness.__setQueryResultForTests(settled({ data: {}, error: null }));

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("Couldn't load A/B results")).toBeTruthy();
    expect(screen.queryByText("A/B results unavailable")).toBeNull();
  });

  it("rejects a payload whose variants are not a list", async () => {
    queryHarness.__setQueryResultForTests(
      settled({
        data: { ...resultsPayload([]), variants: "nope" },
        error: null,
      }),
    );

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("Couldn't load A/B results")).toBeTruthy();
  });

  it("calls a test with no variants empty rather than broken", async () => {
    queryHarness.__setQueryResultForTests(
      settled({ data: resultsPayload([]), error: null }),
    );

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("No variants yet")).toBeTruthy();
    expect(screen.queryByText("Couldn't load A/B results")).toBeNull();
  });

  it("asks a gate-closed session to reconnect instead of reporting a load failure", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests(settled(undefined));

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("Reconnect to load A/B results")).toBeTruthy();
    expect(screen.queryByText("Couldn't load A/B results")).toBeNull();
  });

  it("renders one card per variant once the payload validates", async () => {
    queryHarness.__setQueryResultForTests(
      settled({
        data: resultsPayload([
          {
            id: "v1",
            variant_index: 0,
            variant_label: "A",
            subject: "Original subject",
            sent: 1000,
            hits: 210,
            rate: 0.21,
            is_control: true,
          },
          {
            id: "v2",
            variant_index: 1,
            variant_label: "B",
            subject: "Challenger subject",
            sent: 1000,
            hits: 260,
            rate: 0.26,
            is_control: false,
          },
        ]),
        error: null,
      }),
    );

    await render(<ABResults />, { wrapper });

    expect(screen.getByText("Original subject")).toBeTruthy();
    expect(screen.getByText("Challenger subject")).toBeTruthy();
    expect(screen.queryByText("No variants yet")).toBeNull();
  });
});

describe("A/B results mutating affordances", () => {
  it("hides Evaluate now while there is nothing to evaluate", async () => {
    queryHarness.__setQueryResultForTests(
      settled({ data: null, error: { status: 404, message: "not found" } }),
    );

    await render(<ABResults />, { wrapper });

    expect(screen.queryByLabelText("Evaluate now")).toBeNull();
  });

  it("disables Evaluate now for a read-only viewer rather than 403-ing after the tap", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(
      settled({
        data: resultsPayload([
          {
            id: "v1",
            variant_index: 0,
            variant_label: "A",
            sent: 10,
            hits: 1,
            rate: 0.1,
            is_control: true,
          },
        ]),
        error: null,
      }),
    );

    await render(<ABResults />, { wrapper });

    const button = screen.getByLabelText("Evaluate now");
    expect(
      (button.props as { accessibilityState?: { disabled?: boolean } })
        .accessibilityState?.disabled,
    ).toBe(true);
  });

  /**
   * Evaluating is irreversible in TWO ways and the button said neither.
   *
   * `POST /ab/evaluate` persists a look against a fixed alpha-spending budget
   * (`Repo.RecordWinnerLook`; the Go comment names the abuse it guards —
   * "anyone unhappy with 'no winner yet' could re-POST until noise cleared the
   * bar"), and a decided pass calls `MarkWinner`, which fixes which subject
   * line the remaining audience receives. Neither can be undone, so a single
   * mis-tap on a phone must not be enough.
   */
  it("confirms before spending a significance look", async () => {
    queryHarness.__setQueryResultForTests(
      settled({
        data: resultsPayload([
          {
            id: "v1",
            variant_index: 0,
            variant_label: "A",
            sent: 1000,
            hits: 210,
            rate: 0.21,
            is_control: true,
          },
        ]),
        error: null,
      }),
    );

    await render(
      <ConfirmProvider>
        <ABResults />
      </ConfirmProvider>,
      { wrapper },
    );

    // Nothing is said about the cost until the tap.
    expect(screen.queryByText("Run an evaluation now?")).toBeNull();

    await fireEvent.press(screen.getByLabelText("Evaluate now"));

    expect(screen.getByText("Run an evaluation now?")).toBeTruthy();
    // The consequence, not just the verb: both halves of what cannot be undone.
    expect(
      screen.getByText(
        "It spends one of this test's fixed significance looks, which cannot be given back — and if a winner is decided, the remaining audience receives that variant.",
      ),
    ).toBeTruthy();
  });
});
