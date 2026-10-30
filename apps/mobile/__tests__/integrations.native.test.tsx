import { afterEach, describe, expect, it } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Integrations from "../app/(tabs)/integrations";

const queryHooks = require("./mocks/queryHooks.cjs");

/**
 * The integrations tab is the "is anything broken right now" screen, and its
 * two most dangerous states are the ones a naive test never reaches:
 *
 *  1. LOADED-BUT-COLLAPSED. The list renders counters that read as FACTS. A
 *     failed or never-run fetch must show em-dashes, never "0 failing".
 *  2. EXPANDED. Round 5 added a per-connection health read behind the card's
 *     disclosure. Its loaded branch is only reachable if the mocked hook
 *     returns the hook's REAL shape — a TanStack query result whose `data` is
 *     the normalised `IntegrationHealth`, not a bare payload. A mock that gets
 *     that wrong passes on its error path and silently asserts nothing about
 *     the panel, which is exactly the failure mode round 4 shipped three times.
 */

const ROWS = [
  {
    id: "slack",
    slug: "slack",
    name: "Slack",
    status: "failing" as const,
    category: "Messaging",
    last_delivery_at: "2026-07-25T09:00:00Z",
    last_error: "429 Too Many Requests",
    health_message: "Two deliveries failed in the last hour.",
    manage_path: "/app/integrations/slack",
  },
  {
    id: "hubspot",
    slug: "hubspot",
    name: "HubSpot",
    status: "healthy" as const,
  },
];

/** The real `useQuery` result shape, so every branch the screen reads exists. */
function queryResult<T>(over: Partial<Record<string, unknown>> & { data?: T }) {
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

function renderScreen() {
  return render(React.createElement(Integrations), {
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
});

describe("integrations tab", () => {
  it("renders connection rows and real counters once the feed loads", async () => {
    queryHooks.__setHookResultForTests(
      "useIntegrations",
      queryResult({ data: ROWS }),
    );
    const result = await renderScreen();

    expect(result.getByText("Slack")).toBeTruthy();
    expect(result.getByText("HubSpot")).toBeTruthy();
    // Counters are grouped facts, spoken as a quantity — never a loose numeral.
    expect(result.getByLabelText("Failing: 1 integration")).toBeTruthy();
    expect(result.getByLabelText("Healthy: 1 integration")).toBeTruthy();
  });

  it("refuses to claim zero when the feed never loaded", async () => {
    queryHooks.__setHookResultForTests(
      "useIntegrations",
      queryResult({ isError: true, error: new Error("boom") }),
    );
    const result = await renderScreen();
    // "0 failing" would be a claim; "not available" is the truth.
    expect(result.getByLabelText("Failing: not available")).toBeTruthy();
    expect(result.getByLabelText("Healthy: not available")).toBeTruthy();
  });

  it("shows checks, attempt counts and the retry policy when a card is expanded", async () => {
    queryHooks.__setHookResultForTests(
      "useIntegrations",
      queryResult({ data: ROWS }),
    );
    queryHooks.__setHookResultForTests(
      "useIntegrationHealth",
      queryResult({
        data: {
          state: "action_required",
          severity: "error" as const,
          message: "Deliveries are failing.",
          monitoringSurface: "Outbound webhooks",
          docsUrl: null,
          checks: [
            {
              key: "delivery",
              label: "Delivery",
              state: "error" as const,
              message: "Rate limited by Slack.",
            },
          ],
          retryPolicy: {
            mode: "automatic",
            maxAttempts: 5,
            backoff: "exponential",
            deadLetter: "dlq",
            idempotency: "delivery_id",
          },
          syncHistory: [
            {
              at: "2026-07-25T10:00:00Z",
              action: "sync",
              status: "failed",
              attempts: 3,
              message: "",
              error: "429 Too Many Requests",
            },
          ],
        },
      }),
    );
    const result = await renderScreen();

    // Collapsed: the panel is not mounted, so the health read never fires.
    expect(result.queryByText("Rate limited by Slack.")).toBeNull();

    await fireEvent.press(result.getByLabelText(/^Slack integration, failing/));

    expect(result.getByText("Delivery")).toBeTruthy();
    expect(result.getByText("Rate limited by Slack.")).toBeTruthy();
    // The retry story is the reason to open this at all.
    expect(
      result.getByText("automatic · 5 attempts · exponential backoff"),
    ).toBeTruthy();
    // The attempt count is a compacted glyph on screen, so the spoken form
    // must carry the whole fact including the absolute timestamp.
    expect(result.getByText("×3")).toBeTruthy();
    expect(
      result.getByLabelText(/sync, failed\..*3 attempts\. 429 Too Many Requests\./),
    ).toBeTruthy();
  });

  it("says the health report could not be loaded rather than 'no checks'", async () => {
    queryHooks.__setHookResultForTests(
      "useIntegrations",
      queryResult({ data: ROWS }),
    );
    queryHooks.__setHookResultForTests(
      "useIntegrationHealth",
      queryResult({ isError: true, error: new Error("500") }),
    );
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Slack integration, failing/));

    expect(
      result.getByText("Couldn't load the health report. Pull to refresh."),
    ).toBeTruthy();
    expect(
      result.queryByText(
        "This connection reports no health checks or sync history.",
      ),
    ).toBeNull();
  });

  it("distinguishes offline from 'nothing to report' inside an expanded card", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    queryHooks.__setHookResultForTests(
      "useIntegrations",
      queryResult({ data: ROWS }),
    );
    queryHooks.__setHookResultForTests(
      "useIntegrationHealth",
      queryResult({}),
    );
    const result = await renderScreen();
    await fireEvent.press(result.getByLabelText(/^Slack integration, failing/));

    expect(
      result.getByText(
        "Health checks need a connection. Reconnect and pull to refresh.",
      ),
    ).toBeTruthy();
  });
});
