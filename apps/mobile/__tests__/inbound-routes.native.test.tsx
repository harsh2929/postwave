import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import InboundRoutesRoute, {
  ErrorBoundary as InboundRoutesErrorBoundary,
} from "../app/(tabs)/inbound-routes";
import { InboundRoutesScreen } from "../src/components/inbound-routes/InboundRoutesScreen";
import { ToastProvider } from "../src/components/Toast";
import {
  normalizeInboundActionRuns,
  normalizeInboundMatches,
  normalizeInboundRoutes,
} from "../src/lib/inboundRoutes";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useInboundRoutes", () => require("./mocks/queryHooks.cjs"));

/**
 * The inbound-routing monitor has five states a "does it render" test never
 * reaches, and each one is a place where the app could state something false:
 *
 *   ROLE      — all eight /api/v1/inbound-routes routes are behind
 *               RequireScope(ScopeAdmin) (routes.go:80-89), even though the
 *               generated manifest lists both drill-down reads as viewer with
 *               review_status: fail_closed_default.
 *   DISABLED  — MatchRoutes filters enabled = true, so a switched-off rule
 *               matches nothing while keeping every match it ever made. A row
 *               showing "120 matches" without the off state is the most
 *               misleading thing on the screen.
 *   LIFETIME  — match_count lives on the rule and is not the length of the
 *               fetched list; a pruned history is not "never matched".
 *   NULL HTTP — three of the five action kinds make no HTTP request at all, so
 *               http_status is NULL and "0" would be an invented response.
 *   NO RUNS   — an empty run list has two causes and the screen must not pick
 *               one, and must never read as "everything succeeded".
 */

function routeWire(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "Support replies",
    priority: 100,
    stop_on_match: true,
    enabled: true,
    match_recipient: "support@*",
    match_subject_prefix: "",
    match_from_domain: "",
    actions: [{ kind: "webhook", url: "https://example.test/hook" }],
    last_matched_at: "2026-07-25T03:00:00Z",
    match_count: 120,
    action_retry_max: 3,
    ...over,
  };
}

function matchWire(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    route_id: "r1",
    recipient: "support@example.test",
    subject: "Re: invoice question",
    from_email: "buyer@shop.test",
    matched_at: "2026-07-25T03:00:00Z",
    ...over,
  };
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
    refetch: async () => ({ data: undefined }),
    ...over,
  };
}

function load(
  routes: Record<string, unknown>[],
  matches: Record<string, unknown>[],
  runs: Record<string, unknown>[],
) {
  queryHooks.__setHookResultForTests(
    "useInboundRoutes",
    queryResult({ data: normalizeInboundRoutes({ routes }) }),
  );
  queryHooks.__setHookResultForTests(
    "useInboundRouteMatches",
    queryResult({ data: normalizeInboundMatches({ matches }) }),
  );
  queryHooks.__setHookResultForTests(
    "useInboundActionRuns",
    queryResult({ data: normalizeInboundActionRuns({ runs }) }),
  );
}

async function renderScreen(
  Component: React.ComponentType = InboundRoutesScreen,
) {
  return render(
    React.createElement(ToastProvider, null, React.createElement(Component)),
    {
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
    },
  );
}

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
  authStore.__resetAuthStateForTests();
});

describe("inbound-routes route file", () => {
  it("mounts the default export the router actually loads", async () => {
    load([routeWire()], [matchWire()], []);
    const result = await renderScreen(InboundRoutesRoute);
    expect(result.getByText("Inbound routing")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof InboundRoutesErrorBoundary).toBe("function");
  });
});

describe("role gate", () => {
  it("refuses a member session and never says 'no rules'", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "member" } });
    load([], [], []);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No routing rules")).toBeNull();
  });

  it("refuses an editor session — the reads want the admin scope too", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "editor" } });
    load([routeWire()], [matchWire()], []);
    expect(
      (await renderScreen()).getByText("Needs an owner or admin session"),
    ).toBeTruthy();
  });

  it("treats a live 403 as the role state rather than a generic error", async () => {
    queryHooks.__setHookResultForTests(
      "useInboundRoutes",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests(
      "useInboundRouteMatches",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests(
      "useInboundActionRuns",
      queryResult({ data: [] }),
    );
    const result = await renderScreen();
    expect(result.getByText(/refused this read just now/)).toBeTruthy();
  });

  it("admits an admin session", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "admin" } });
    load([routeWire()], [matchWire()], []);
    expect(
      (await renderScreen()).queryByText("Needs an owner or admin session"),
    ).toBeNull();
  });
});

describe("the posture card never overstates what the API can answer", () => {
  it("does not claim mail is routing — it points at the per-rule drill instead", async () => {
    load([routeWire()], [matchWire()], []);
    const result = await renderScreen();
    expect(
      result.getByText("1 live rules have all matched at least once"),
    ).toBeTruthy();
    expect(result.getByText(/Open a rule/)).toBeTruthy();
  });

  it("warns when every rule is switched off", async () => {
    load([routeWire({ enabled: false })], [], []);
    expect(
      (await renderScreen()).getByText("All 1 rules are switched off"),
    ).toBeTruthy();
  });

  it("warns about a live rule that has never fired", async () => {
    load(
      [routeWire({ id: "a", match_count: 4 }), routeWire({ id: "b", match_count: 0 })],
      [matchWire()],
      [],
    );
    expect(
      (await renderScreen()).getByText("1 of 2 live rules have never matched"),
    ).toBeTruthy();
  });
});

describe("a disabled rule is never allowed to look live", () => {
  it("says the history predates the switch-off", async () => {
    load([routeWire({ enabled: false, match_count: 900 })], [matchWire()], []);
    const result = await renderScreen();
    expect(result.getByText("off")).toBeTruthy();
    expect(result.getByText(/none of it is current behaviour/)).toBeTruthy();
  });
});

describe("lifetime count versus the fetched window", () => {
  it("calls a pruned history exactly that, not 'never matched'", async () => {
    load([routeWire({ match_count: 120 })], [], []);
    const result = await renderScreen();
    expect(result.getByText("No match rows remain")).toBeTruthy();
    expect(result.getAllByText(/pruned on a retention schedule/).length).toBeGreaterThan(0);
  });

  it("says 'never matched' only when the lifetime counter agrees", async () => {
    load([routeWire({ match_count: 0, last_matched_at: null })], [], []);
    const result = await renderScreen();
    expect(result.getByText("This rule has never matched")).toBeTruthy();
    expect(result.queryByText(/pruned on a retention schedule/)).toBeNull();
  });
});

describe("action runs", () => {
  it("renders an em-dash HTTP status for an action kind that makes no request", async () => {
    load(
      [routeWire()],
      [matchWire()],
      [
        {
          id: 1,
          route_id: "r1",
          action_index: 0,
          action_kind: "tag",
          status: "succeeded",
          attempts: 1,
          duration_ms: 3,
          executed_at: "2026-07-25T03:00:01Z",
        },
      ],
    );
    const result = await renderScreen();
    expect(
      result.getByLabelText(/makes no HTTP request, so it has no response status/),
    ).toBeTruthy();
    expect(
      result.getByText("HTTP —", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(
      result.queryByText("HTTP 0", { includeHiddenElements: true }),
    ).toBeNull();
  });

  it("surfaces a retried-but-succeeded run rather than hiding it behind green", async () => {
    load(
      [routeWire()],
      [matchWire()],
      [
        {
          id: 2,
          route_id: "r1",
          action_index: 1,
          action_kind: "webhook",
          status: "succeeded",
          attempts: 3,
          http_status: 200,
          duration_ms: 4200,
          executed_at: "2026-07-25T03:00:02Z",
        },
      ],
    );
    const result = await renderScreen();
    // Spoken first — that is the surface a VoiceOver user receives, and the
    // visible pill is hidden from the a11y tree so the row is announced once.
    expect(
      result.getByLabelText(/Took 3 attempts — it was retried/),
    ).toBeTruthy();
    expect(
      result.getByText("3 attempts", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(result.getByText(/1 action needed a retry/)).toBeTruthy();
  });

  it("shows the upstream's error rather than a generic failure", async () => {
    load(
      [routeWire()],
      [matchWire()],
      [
        {
          id: 3,
          route_id: "r1",
          action_index: 0,
          action_kind: "webhook",
          status: "failed",
          attempts: 4,
          http_status: 503,
          error_message: "upstream refused: 503",
          response_snippet: "service unavailable",
          duration_ms: 9000,
          executed_at: "2026-07-25T03:00:03Z",
        },
      ],
    );
    const result = await renderScreen();
    expect(
      result.getByText("upstream refused: 503", { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(result.getByText(/1 failed action/)).toBeTruthy();
  });

  it("refuses to read an empty run list as success", async () => {
    load([routeWire()], [matchWire()], []);
    const result = await renderScreen();
    expect(result.getByText("No action runs recorded")).toBeTruthy();
    expect(result.getByText(/cannot tell the two apart/)).toBeTruthy();
  });

  it("explains an action-less rule instead of implying a failure", async () => {
    load([routeWire({ actions: [] })], [matchWire()], []);
    expect(
      (await renderScreen()).getByText(/nothing to have failed/),
    ).toBeTruthy();
  });
});

describe("selection", () => {
  it("drops the match selection when the rule changes", async () => {
    load(
      [routeWire({ id: "a", name: "Rule A" }), routeWire({ id: "b", name: "Rule B" })],
      [matchWire({ id: 501, subject: "First" }), matchWire({ id: 502, subject: "Second" })],
      [],
    );
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/Second\./));
    await fireEvent.press(result.getByLabelText(/Rule B\./));
    // Back to the newest match of the newly-selected rule, never the id that
    // belonged to the previous one.
    expect(result.getByLabelText(/First\. .*Showing what its actions did/)).toBeTruthy();
  });
});

describe("offline", () => {
  it("says the reading is unavailable rather than that there are no rules", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    queryHooks.__setHookResultForTests("useInboundRoutes", queryResult({ data: undefined }));
    queryHooks.__setHookResultForTests(
      "useInboundRouteMatches",
      queryResult({ data: [] }),
    );
    queryHooks.__setHookResultForTests("useInboundActionRuns", queryResult({ data: [] }));
    const result = await renderScreen();
    expect(result.getByText(/Routing rules need a connection/)).toBeTruthy();
  });
});

describe("monitor scoping", () => {
  it("says out loud that authoring and reorder stay on the web admin", async () => {
    load([routeWire()], [matchWire()], []);
    expect(
      (await renderScreen()).getByText(/reordering and the dry-run matcher/),
    ).toBeTruthy();
  });
});
