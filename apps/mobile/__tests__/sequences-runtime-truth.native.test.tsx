import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import SequencesIndex from "../app/(tabs)/sequences/index";
import * as QueryHooks from "@/hooks/useOnlineQueryGate";

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

describe("mobile sequence runtime truth", () => {
  it("shows historical active rows as warnings, and offers no create action to a role that can't write", async () => {
    // The role is now SET rather than inferred. The default gate used to carry
    // no effectiveRole, so "no create button" fell out of `canAccessMinimumRole`
    // failing closed; the shared mock's OPEN_GATE has since become an owner, and
    // an owner is SUPPOSED to see the button. Naming the viewer keeps the
    // assertion in this test's title falsifiable instead of riding a default.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(
      queryState({
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Historical welcome",
            status: "active",
            active_runs: 42,
            steps: 3,
          },
        ],
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByText("Legacy active label")).toBeTruthy();
    expect(
      screen.getByText("Draft designer · live runtime unavailable"),
    ).toBeTruthy();
    expect(screen.queryByText(/42 active/i)).toBeNull();
    // A viewer cannot POST, so neither create verb is offered. Asserted by the
    // button's REAL accessibility label — the original assertion looked for
    // "create new sequence", a string this screen has never rendered, so it
    // would have passed no matter what shipped.
    expect(screen.queryByLabelText("New sequence")).toBeNull();
  });

  /* ---------------------------------------------------------------- *
   * The TWO create verbs (AUTOMATION#5 + AUTOMATION#15). "New" names an
   * empty draft and is offline-queued; "AI draft" spends a metered model
   * request and is not. Same role and endpoint gates, one extra network
   * gate on the second — and both are HIDDEN rather than disabled when
   * they cannot succeed, because a button that can only ever 403 is
   * worse than none.
   * ---------------------------------------------------------------- */

  it("offers both create verbs to an editor once the endpoint answered", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "editor" });
    queryHarness.__setQueryResultForTests(
      queryState({ items: [], error: null, fromSnapshot: false }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByLabelText("New sequence")).toBeTruthy();
    expect(screen.getByLabelText("Draft a sequence with AI")).toBeTruthy();
    // The empty state names what is ACTUALLY on this header. It used to say
    // "its steps are authored in the desktop or web app" unconditionally,
    // which stopped being true of the screen the moment AI drafting could
    // write emails from the phone — and teaching a false ceiling is the same
    // class of manufactured claim as inventing a capability.
    expect(
      screen.getByText(/tap AI draft to have a model write the emails/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/steps are authored in the desktop or web app/i),
    ).toBeNull();
  });

  it("hides both create verbs from a viewer instead of showing buttons that 403", async () => {
    gateHarness.__setOnlineGateForTests({ effectiveRole: "viewer" });
    queryHarness.__setQueryResultForTests(
      queryState({ items: [], error: null, fromSnapshot: false }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.queryByLabelText("New sequence")).toBeNull();
    expect(screen.queryByLabelText("Draft a sequence with AI")).toBeNull();
  });

  it("hides both create verbs when the deployment does not expose the endpoint", async () => {
    // POST cannot succeed where GET answered 404 — offering it would send a
    // request guaranteed to fail and blame the operator for the result.
    gateHarness.__setOnlineGateForTests({ effectiveRole: "owner" });
    queryHarness.__setQueryResultForTests(
      queryState({ data: null, error: { status: 404, message: "not found" } }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByText("Sequences not available")).toBeTruthy();
    expect(screen.queryByLabelText("New sequence")).toBeNull();
    expect(screen.queryByLabelText("Draft a sequence with AI")).toBeNull();
  });

  it("keeps the offline-queued create but drops AI drafting when the gate closes", async () => {
    // THE ONE PLACE THE TWO RULES DIVERGE, and the reason each has its own
    // policy function. `canCreateSequence` takes no `online` term: the blank
    // create pauses in the offline mutation queue, persists to the encrypted
    // vault and replays on reconnect, so hiding it here would suppress the one
    // write on this screen built to survive being offline. A generation cannot
    // be replayed into a screen nobody is on, and it spends a metered unit
    // when it lands — so `canDraftSequenceWithAI` does take that term.
    gateHarness.__setOnlineGateForTests({
      effectiveRole: "editor",
      enabled: false,
    });
    queryHarness.__setQueryResultForTests(
      queryState({ items: [], error: null, fromSnapshot: true }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByLabelText("New sequence")).toBeTruthy();
    expect(screen.queryByLabelText("Draft a sequence with AI")).toBeNull();
  });

  it("gives an empty 404 screen exactly ONE explanation", async () => {
    // The runtime-boundary block used to render unconditionally, so a 404
    // stacked "the runtime is off" on top of "this deployment hasn't enabled
    // the endpoint". Two competing explanations for one empty screen is worse
    // than either alone; the boundary only qualifies a real journey list.
    queryHarness.__setQueryResultForTests(
      queryState({
        data: null,
        error: { status: 404, message: "not found" },
      }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByText("Sequences not available")).toBeTruthy();
    expect(
      screen.queryByText("Draft designer · live runtime unavailable"),
    ).toBeNull();
  });

  it("reports a paused sequence as paused, not as a data-integrity warning", async () => {
    queryHarness.__setQueryResultForTests(
      queryState({
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Paused winback",
            status: "paused",
            steps: 4,
          },
        ],
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByText("Unverified · read-only")).toBeNull();
  });

  it("counts branch steps from the server total instead of the array length", async () => {
    // A 1-condition / 12-branch-step sequence used to render "1 step" because
    // the array branch won over the server's own numeric total.
    queryHarness.__setQueryResultForTests(
      queryState({
        items: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Branching journey",
            status: "draft",
            steps: 13,
          },
        ],
        error: null,
        fromSnapshot: false,
      }),
    );

    await render(<SequencesIndex />, { wrapper });

    expect(screen.getByText("13 steps")).toBeTruthy();
  });

  it("survives a sequence payload whose items are not an array", async () => {
    // `result?.items ?? []` is a NULLISH guard, and `deriveSequenceListView`
    // runs `for (const item of items)` — a truthy non-array is not iterable and
    // takes the screen down. This is not hypothetical: `useSequenceList`'s
    // snapshot arm reads the SecureStore blob and wraps it on a bare
    // truthiness check (`cached ? { items: cached }`), with `vaultGetJSON`
    // doing an unchecked cast, so any older projection shape lands here.
    queryHarness.__setQueryResultForTests(
      queryState({ items: {}, error: null, fromSnapshot: false }),
    );
    await expect(
      render(<SequencesIndex />, { wrapper }),
    ).resolves.toBeDefined();
  });
});
