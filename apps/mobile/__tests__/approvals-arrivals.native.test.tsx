import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Approvals from "../app/(tabs)/approvals";

const queryHooks = require("./mocks/queryHooks.cjs");

/**
 * GOVERNANCE#29 — the queue polls every 60s (useApprovals.ts:135) and renders
 * newest-first, so a request submitted while you are reading used to PREPEND
 * itself: the row under your thumb slid down one position and was replaced by
 * something you have never read. Approvals is the one screen where a mis-tap is
 * unrecoverable — the decision is irreversible and audit-logged, and
 * swipe-approve deliberately skips the confirm.
 *
 * These render the poll rather than trusting the pure module: the hazard is a
 * SCREEN behaviour, and `approvalArrivals.test.ts` can only prove the set
 * arithmetic. Changing the mocked hook result and re-rendering is exactly what
 * a poll tick does to this component.
 */

function queryResult(over: Record<string, unknown> = {}) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => ({ data: undefined }),
    dataUpdatedAt: Date.now(),
    ...over,
  };
}

const approval = (id: string, requester: string) => ({
  id,
  resourceType: "campaign",
  resourceId: `c-${id}`,
  status: "pending",
  requestedAt: new Date().toISOString(),
  requestedByActorLabel: requester,
  requestedByActorType: "user",
  notes: "",
});

function renderScreen() {
  return render(<Approvals />, {
    wrapper: ({ children }: { children?: React.ReactNode }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

/** GET /api/v1/approvals is owner/admin-only; without a role the screen 403s. */
function asOwner() {
  queryHooks.__setOnlineGateForTests({ effectiveRole: "owner" });
}

function setPending(rows: unknown[]) {
  queryHooks.__setHookResultForTests(
    "usePendingApprovals",
    queryResult({ data: rows }),
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("approvals arrivals", () => {
  it("announces no pill on a first load — the whole page is what you asked for", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);

    const result = await renderScreen();

    expect(result.getByText(/Requested by ada@example.com/)).toBeTruthy();
    expect(result.queryByText(/tap to load/)).toBeNull();
  });

  it("counts a polled arrival instead of sliding it under the thumb", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);
    const result = await renderScreen();

    // The 60s poll ticks and returns a NEW request, newest-first.
    setPending([
      approval("new", "mallory@example.com"),
      approval("a", "ada@example.com"),
    ]);
    await result.rerender(<Approvals />);

    expect(result.getByText("1 new request — tap to load")).toBeTruthy();
    // The critical negative: the arriving row is NOT on screen, so it cannot
    // have taken the position of the row being read.
    expect(result.queryByText(/Requested by mallory@example.com/)).toBeNull();
    expect(result.getByText(/Requested by ada@example.com/)).toBeTruthy();
  });

  it("loads the held rows only when the reader asks", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);
    const result = await renderScreen();

    setPending([
      approval("n1", "mallory@example.com"),
      approval("n2", "peggy@example.com"),
      approval("a", "ada@example.com"),
    ]);
    await result.rerender(<Approvals />);

    expect(result.getByText("2 new requests — tap to load")).toBeTruthy();
    await fireEvent.press(
      result.getByLabelText(
        "2 new approval requests arrived. Double tap to load them.",
      ),
    );

    expect(result.getByText(/Requested by mallory@example.com/)).toBeTruthy();
    expect(result.getByText(/Requested by peggy@example.com/)).toBeTruthy();
    expect(result.queryByText(/tap to load/)).toBeNull();
  });

  it("lets a DECISION made elsewhere leave the queue — a phantom row would 409", async () => {
    asOwner();
    setPending([
      approval("a", "ada@example.com"),
      approval("b", "bob@example.com"),
    ]);
    const result = await renderScreen();

    // A teammate approved b.
    setPending([approval("a", "ada@example.com")]);
    await result.rerender(<Approvals />);

    expect(result.queryByText(/Requested by bob@example.com/)).toBeNull();
    expect(result.queryByText(/tap to load/)).toBeNull();
  });

  it("never renders 'You're caught up' while requests are held", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);
    const result = await renderScreen();

    // The teammate cleared the whole queue and a fresh request arrived: every
    // held id is gone. Holding here would show an empty-state lie.
    setPending([approval("new", "mallory@example.com")]);
    await result.rerender(<Approvals />);

    expect(result.queryByText("You're caught up")).toBeNull();
    expect(result.getByText(/Requested by mallory@example.com/)).toBeTruthy();
  });

  it("resumes holding after an auto-adopt rather than staying off", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);
    const result = await renderScreen();

    setPending([approval("new", "mallory@example.com")]);
    await result.rerender(<Approvals />);
    expect(result.getByText(/Requested by mallory@example.com/)).toBeTruthy();

    // Another poll, another arrival. If the auto-adopt had left the hold set
    // stale, this second arrival would appear unannounced.
    setPending([
      approval("newer", "peggy@example.com"),
      approval("new", "mallory@example.com"),
    ]);
    await result.rerender(<Approvals />);

    expect(result.getByText("1 new request — tap to load")).toBeTruthy();
    expect(result.queryByText(/Requested by peggy@example.com/)).toBeNull();
  });

  it("switching filters does not withhold the other query's whole result set", async () => {
    asOwner();
    setPending([approval("a", "ada@example.com")]);
    queryHooks.__setHookResultForTests(
      "useAllApprovals",
      queryResult({
        data: [
          approval("a", "ada@example.com"),
          { ...approval("z", "zoe@example.com"), status: "approved" },
        ],
      }),
    );
    const result = await renderScreen();

    await fireEvent.press(result.getByText("All"));

    // The hold set captured from Pending is meaningless against All; applying
    // it would hide the entire history behind a "1 new" pill.
    expect(result.getByText(/Requested by zoe@example.com/)).toBeTruthy();
    expect(result.queryByText(/tap to load/)).toBeNull();
  });
});
