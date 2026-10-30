import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { InboundRouteEnabledControl } from "../src/components/inbound-routes/InboundRouteEnabledControl";
import { InboundRoutesScreen } from "../src/components/inbound-routes/InboundRoutesScreen";
import { ToastProvider } from "../src/components/Toast";
import { InboundRouteOfflineError } from "../src/lib/inboundRouteToggle";
import {
  normalizeInboundActionRuns,
  normalizeInboundMatches,
  normalizeInboundRoutes,
} from "../src/lib/inboundRoutes";
import type { InboundRoute } from "../src/lib/inboundRoutes";

const queryHooks = require("./mocks/queryHooks.cjs");
const reactQuery = require("./mocks/reactQuery.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useInboundRoutes", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useInboundRouteEnabled", () =>
  require("./mocks/queryHooks.cjs"),
);
// The transport the REAL hook must inject. Recorded, not exercised: the
// vitest beside src/api/inboundRouteEnabled.ts proves what it sends; this
// file proves the hook reaches THAT function and not its echo-shaped sibling
// in api/inboundRoutes, which the working-tree handler refuses with 409.
jest.mock("@/api/inboundRouteEnabled", () => ({
  patchInboundRouteEnabled: jest.fn(async () => undefined),
}));
const enabledApi = require("@/api/inboundRouteEnabled") as {
  patchInboundRouteEnabled: jest.Mock;
};

// The REAL hook, for the wiring tests at the bottom. Its react-query import
// still resolves to the mock, which records the options it was handed.
const { useSetInboundRouteEnabled: realUseSetInboundRouteEnabled } =
  jest.requireActual<typeof import("../src/hooks/useInboundRouteEnabled")>(
    "../src/hooks/useInboundRouteEnabled",
  );

/**
 * The projected off switch, at the rendered seam.
 *
 * lib/inboundRouteOptimistic.test.ts drives the projection and its rollback
 * through a real QueryClient. What it cannot prove is that the SCREEN mounts
 * a control wired to THAT mutation — a control on a plain `useMutation`
 * would pass every node test and still leave the row disagreeing with the
 * tap for a round trip. So these tests pin, in order:
 *
 *  - the selected rule's section carries exactly one switch (a second mount
 *    of the non-projected sibling would double the verb);
 *  - the verb points the way the rule's current state demands, and pressing
 *    hands the mutation the WHOLE route (the payload's preserve echo needs
 *    its priority and matchers — an id-only signature would reintroduce
 *    desktop's wipe bug);
 *  - a refused PATCH raises the rollback sentence with the server's words;
 *  - the mutation the control actually uses carries onMutate/onError/
 *    onSettled, and those restore the snapshot and refetch the tenant's list.
 */

const GATE_TENANT = "11111111-1111-4111-8111-111111111111";
const RULES_KEY = ["inbound-routes", "rules", GATE_TENANT];

const route: InboundRoute = {
  id: "r1",
  name: "Support replies",
  priority: 100,
  stopOnMatch: true,
  enabled: true,
  matchRecipient: "support@*",
  matchSubjectPrefix: "[case]",
  matchFromDomain: "",
  actions: [],
  rawActions: [],
  lastMatchedAt: "",
  matchCount: 12,
  actionRetryMax: 3,
};

function queryResult(over: Record<string, unknown>) {
  return {
    data: undefined,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function mutationResult() {
  return {
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(async () => undefined),
    reset: jest.fn(),
  };
}

type MutateCall = [
  { route: InboundRoute; enabled: boolean },
  { onSuccess: () => void; onError: (error: unknown) => void },
];

async function renderWithin(element: React.ReactElement) {
  return render(React.createElement(ToastProvider, null, element), {
    wrapper: ({ children }) => (
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

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  reactQuery.__resetQueryResultForTests();
  authStore.__resetAuthStateForTests();
});

describe("the screen mounts the projected control on the selected rule", () => {
  it("renders exactly one switch, pointing the way the rule's state demands", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "admin" } });
    queryHooks.__setHookResultForTests(
      "useInboundRoutes",
      queryResult({
        data: normalizeInboundRoutes({
          routes: [
            {
              id: "r1",
              name: "Support replies",
              priority: 100,
              enabled: true,
              match_count: 12,
              actions: [],
            },
          ],
        }),
      }),
    );
    queryHooks.__setHookResultForTests(
      "useInboundRouteMatches",
      queryResult({ data: normalizeInboundMatches({ matches: [] }) }),
    );
    queryHooks.__setHookResultForTests(
      "useInboundActionRuns",
      queryResult({ data: normalizeInboundActionRuns({ runs: [] }) }),
    );
    const setEnabled = mutationResult();
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", setEnabled);

    const result = await renderWithin(React.createElement(InboundRoutesScreen));
    // getByText throws on more than one match, so this also pins that the
    // non-projected sibling is NOT mounted alongside.
    expect(result.getByText("Switch off this rule")).toBeTruthy();
    expect(result.queryByText("Switch this rule on")).toBeNull();

    // The screen hands the control the SELECTED rule, and the control hands
    // the mutation that whole row.
    fireEvent.press(result.getByText("Switch off this rule"));
    await waitFor(() => expect(setEnabled.mutate).toHaveBeenCalledTimes(1));
    const [variables] = (setEnabled.mutate as jest.Mock).mock
      .calls[0] as MutateCall;
    expect(variables.route.id).toBe("r1");
    expect(variables.enabled).toBe(false);
  });
});

describe("InboundRouteEnabledControl", () => {
  it("switches a live rule OFF, handing the mutation the whole route", async () => {
    const setEnabled = mutationResult();
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", setEnabled);
    const result = await renderWithin(
      React.createElement(InboundRouteEnabledControl, { route }),
    );
    // Outside a ConfirmSheet provider the confirm resolves true, so the press
    // exercises the real action path (the provider is exercised app-wide).
    fireEvent.press(result.getByText("Switch off this rule"));
    await waitFor(() => expect(setEnabled.mutate).toHaveBeenCalledTimes(1));
    const [variables] = (setEnabled.mutate as jest.Mock).mock
      .calls[0] as MutateCall;
    expect(variables.enabled).toBe(false);
    // The whole route, not an id: the preserve echo needs its fields.
    expect(variables.route.priority).toBe(100);
    expect(variables.route.matchSubjectPrefix).toBe("[case]");
  });

  it("switches an off rule back ON in one tap", async () => {
    const setEnabled = mutationResult();
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", setEnabled);
    const result = await renderWithin(
      React.createElement(InboundRouteEnabledControl, {
        route: { ...route, enabled: false },
      }),
    );
    expect(
      result.getByLabelText("Switch this routing rule on").props
        .accessibilityHint,
    ).toMatch(/off/);
    fireEvent.press(result.getByText("Switch this rule on"));
    await waitFor(() => expect(setEnabled.mutate).toHaveBeenCalledTimes(1));
    const [variables] = (setEnabled.mutate as jest.Mock).mock
      .calls[0] as MutateCall;
    expect(variables.enabled).toBe(true);
  });

  it("disables the control while the write is in flight", async () => {
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", {
      ...mutationResult(),
      isPending: true,
    });
    const result = await renderWithin(
      React.createElement(InboundRouteEnabledControl, { route }),
    );
    expect(result.getByText("Switching…")).toBeTruthy();
    expect(
      result.getByLabelText("Switch this routing rule off").props
        .accessibilityState,
    ).toEqual({ disabled: true, busy: true });
  });

  it("raises the rollback sentence, with the server's words, when the PATCH is refused", async () => {
    const setEnabled = mutationResult();
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", setEnabled);
    const result = await renderWithin(
      React.createElement(InboundRouteEnabledControl, { route }),
    );
    fireEvent.press(result.getByText("Switch off this rule"));
    await waitFor(() => expect(setEnabled.mutate).toHaveBeenCalledTimes(1));
    const [, callbacks] = (setEnabled.mutate as jest.Mock).mock
      .calls[0] as MutateCall;
    // AWAITED, async: `act` is promise-shaped under this renderer, and a
    // bare synchronous call leaves its scope open — the toast's state update
    // never flushes, and the leaked scope starves every render after it.
    await act(async () => {
      callbacks.onError(new Error("route not found"));
    });
    expect(
      await result.findByText("Couldn't switch the rule off — route not found"),
    ).toBeTruthy();
  });

  it("shows an offline refusal verbatim", async () => {
    const setEnabled = mutationResult();
    queryHooks.__setHookResultForTests("useSetInboundRouteEnabled", setEnabled);
    const result = await renderWithin(
      React.createElement(InboundRouteEnabledControl, { route }),
    );
    fireEvent.press(result.getByText("Switch off this rule"));
    await waitFor(() => expect(setEnabled.mutate).toHaveBeenCalledTimes(1));
    const [, callbacks] = (setEnabled.mutate as jest.Mock).mock
      .calls[0] as MutateCall;
    const refusal = new InboundRouteOfflineError();
    await act(async () => {
      callbacks.onError(refusal);
    });
    expect(await result.findByText(refusal.message)).toBeTruthy();
  });
});

describe("the mutation the control uses carries the projection and its undo", () => {
  type Options = {
    mutationFn: (vars: unknown) => Promise<void>;
    onMutate: (vars: unknown) => Promise<unknown>;
    onError: (error: unknown, vars: unknown, context: unknown) => void;
    onSettled: () => void;
  };

  async function mountRealHook(): Promise<Options> {
    function Harness() {
      realUseSetInboundRouteEnabled();
      return null;
    }
    // AWAITED: React's concurrent root does not commit inside a synchronous
    // render() here, so reading the captured options without awaiting reads
    // them before the hook has ever run.
    await render(React.createElement(Harness));
    const options = reactQuery.__getLastMutationOptionsForTests();
    // Fail loudly rather than vacuously if the hook stopped reaching
    // useMutation.
    expect(options).toBeTruthy();
    return options as Options;
  }

  it("registers onMutate, onError and onSettled on the mutation itself", async () => {
    // Mutation-level, not per-call: per-call callbacks are dropped when the
    // component unmounts mid-flight, and a rollback must land regardless.
    const options = await mountRealHook();
    expect(typeof options.onMutate).toBe("function");
    expect(typeof options.onError).toBe("function");
    expect(typeof options.onSettled).toBe("function");
  });

  it("restores every snapshotted entry on error", async () => {
    const options = await mountRealHook();
    const client = reactQuery.__getQueryClientForTests();
    const before = [{ ...route }];
    options.onError(new Error("route not found"), { route, enabled: false }, {
      previous: [[RULES_KEY, before]],
    });
    expect(client.setQueryData).toHaveBeenCalledWith(RULES_KEY, before);
  });

  it("refetches the TENANT's rules list once the write settles", async () => {
    const options = await mountRealHook();
    const client = reactQuery.__getQueryClientForTests();
    options.onSettled();
    // Scoped to the tenant: a bare prefix would also drop the previous
    // workspace's list on a switch.
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: RULES_KEY,
    });
  });

  it("hands the whole route to api/inboundRouteEnabled — the both-revisions-safe transport", async () => {
    // Not the echo-shaped sibling in api/inboundRoutes: against the handler as
    // it stands in the working tree, that one is refused with 409 for any
    // rule that has actions. Swapping the injection back would pass every
    // other test in this file and ship a toggle that always rolls back.
    const options = await mountRealHook();
    await options.mutationFn({ route, enabled: false });
    expect(enabledApi.patchInboundRouteEnabled).toHaveBeenCalledTimes(1);
    expect(enabledApi.patchInboundRouteEnabled).toHaveBeenCalledWith(route, false);
  });
});
