/**
 * Sequence DETAIL render contract.
 *
 * This screen had no test at all, while holding the riskiest logic in the
 * automation cluster: the seed-once-per-id canvas effect, the legacy `emails`
 * fallback, the branch-aware header count, and a four-way state ladder
 * (loading → gate notice → endpoint-unavailable → hard error → loaded) whose
 * ORDER is the whole point — an error must never render as "nothing here", and
 * an offline session must never render as "this feature is unavailable".
 *
 * The canvas COMPONENT is stubbed in this environment (see
 * jest.routes.config.cjs); its pure codec is not, so the step counts asserted
 * below are computed by the real wireToCanvas/countCanvasSteps.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as QueryHooks from "@/hooks/useOnlineQueryGate";

import SequenceDetail from "../app/(tabs)/sequences/[id]";

const ROUTE_ID = "11111111-1111-4111-8111-111111111111";

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

function queryState(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: jest.fn(async () => ({ data })),
  };
}

describe("sequence detail state ladder", () => {
  it("reports an unavailable endpoint without ALSO claiming the runtime is off", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({ data: null, error: { status: 404, message: "not found" } }),
    );

    await render(<SequenceDetail />, { wrapper });

    expect(screen.getByText("Sequence not available")).toBeTruthy();
    // One explanation per state: the capability boundary qualifies a journey
    // that loaded, never an empty screen that already explains itself.
    expect(screen.queryByText("Draft preview only")).toBeNull();
  });

  it("renders a real fetch failure as a retryable error, not as an empty sequence", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({
        data: null,
        error: { status: 500, message: "upstream exploded" },
      }),
    );

    await render(<SequenceDetail />, { wrapper });

    expect(screen.getByText("Couldn't load this sequence")).toBeTruthy();
    expect(screen.getByText(/upstream exploded/)).toBeTruthy();
    expect(screen.queryByText("Sequence not available")).toBeNull();
  });

  it("tells a gate-closed session to reconnect instead of showing an empty journey", async () => {
    gateHarness.__setOnlineGateForTests({ enabled: false });
    queryHarness.__setQueryResultForTests({
      data: undefined,
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      refetch: jest.fn(async () => ({ data: undefined })),
    });

    await render(<SequenceDetail />, { wrapper });

    expect(screen.queryByText("Couldn't load this sequence")).toBeNull();
    expect(screen.queryByText("Sequence not available")).toBeNull();
    expect(screen.getByText("Reconnect to load sequence")).toBeTruthy();
  });
});

describe("sequence detail loaded state", () => {
  it("counts nested condition-branch steps in the header, which steps.length omits", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({
        detail: {
          id: ROUTE_ID,
          name: "Branching winback",
          status: "draft",
          version: 4,
          steps: [
            {
              type: "condition",
              position: 1,
              condition: {
                predicate: "opened_previous",
                yes_branch: [
                  {
                    type: "email",
                    position: 1,
                    email: { subject: "Yes", body: "y" },
                  },
                  { type: "exit", position: 2 },
                ],
                no_branch: [
                  {
                    type: "email",
                    position: 1,
                    email: { subject: "No", body: "n" },
                  },
                ],
              },
            },
          ],
        },
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequenceDetail />, { wrapper });

    // 1 condition + 2 yes-arm steps + 1 no-arm step. `steps.length` is 1.
    expect(screen.getByText("Draft · 4 steps")).toBeTruthy();
    expect(screen.getByText("Draft preview only")).toBeTruthy();
  });

  it("seeds the canvas from the legacy emails projection when steps is empty", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({
        detail: {
          id: ROUTE_ID,
          name: "Legacy welcome",
          status: "paused",
          steps: [],
          emails: [
            { position: 1, subject: "One", body: "a" },
            { position: 2, subject: "Two", body: "b" },
          ],
        },
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequenceDetail />, { wrapper });

    expect(screen.getByText("Paused · 2 steps")).toBeTruthy();
  });

  it("says the entry trigger was NOT REPORTED rather than that none is set", async () => {
    // The Voice service does not persist `trigger`; an absent field says
    // nothing about tenant state, so it must not render as "nothing enrolls
    // into this journey".
    queryHarness.__setQueryResultForTests(
      queryState({
        detail: {
          id: ROUTE_ID,
          name: "No trigger",
          status: "draft",
          steps: [],
        },
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequenceDetail />, { wrapper });

    expect(screen.getByText("Entry trigger not reported")).toBeTruthy();
    expect(screen.getByText("Not reported")).toBeTruthy();
    expect(screen.queryByText("No entry trigger")).toBeNull();
    expect(screen.getByText("Stuck detection off")).toBeTruthy();
  });

  it("renders a stored trigger, goal and stuck threshold verbatim", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({
        detail: {
          id: ROUTE_ID,
          name: "Configured",
          status: "draft",
          steps: [],
          trigger: { kind: "list_subscribe", list_id: 7 },
          goal: { kind: "click", exit_on_goal: false },
          stuck_after_days: 3,
        },
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequenceDetail />, { wrapper });

    expect(screen.getByText("When subscriber joins list")).toBeTruthy();
    expect(screen.getByText("List #7")).toBeTruthy();
    expect(screen.getByText("Goal · clicked any link")).toBeTruthy();
    expect(screen.getByText("Stuck after 3 days")).toBeTruthy();
  });
});
