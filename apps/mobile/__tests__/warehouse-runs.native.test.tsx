import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import WarehouseRunsRoute, {
  ErrorBoundary as WarehouseErrorBoundary,
} from "../app/(tabs)/warehouse-runs";
import { ToastProvider } from "../src/components/Toast";
import { WarehouseRunsScreen } from "../src/components/warehouse/WarehouseRunsScreen";
import { normalizeWarehouseRun } from "../src/lib/warehouseRuns";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useWarehouseRuns", () => require("./mocks/queryHooks.cjs"));

/**
 * The warehouse monitor has four states a "does it render" test never reaches,
 * and each one is a place where the app could state something false:
 *
 *   ROLE  — every /api/v1/warehouse/* route is owner/admin-only once
 *           routeauth.Middleware evaluates the generated manifest, even though
 *           the per-route guard is RequireScope(ScopeReadReports). Rendering
 *           "no runs" for a viewer would be a claim about the WORKSPACE when
 *           the true statement is about the SESSION.
 *   0 vs — — the five row counters are only ever written by completeRunTx,
 *           which also sets status='completed'. On a failed run they are the
 *           column default 0, i.e. NEVER MEASURED. An em-dash is the honest
 *           render; a "0" would be a measurement nobody took.
 *   EMPTY  — a failed run's per-row ledger is rolled back with the transaction
 *           that failed, so "no errors" there means the opposite of what it
 *           reads as.
 *   PAUSE  — admin-tier, destructive-ish, and never queued offline.
 */

function runWire(over: Record<string, unknown> = {}) {
  return {
    id: "run-1",
    connection_id: "conn-1",
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: ["profiles"],
    input_uri: "",
    output_uri: "s3://bucket/warehouse/run-1.jsonl",
    cursor_from: "",
    cursor_to: "",
    rows_scanned: 12_000,
    rows_exported: 11_940,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 0,
    error: "",
    started_at: "2026-07-25T03:00:00Z",
    completed_at: "2026-07-25T03:04:30Z",
    created_at: "2026-07-25T03:00:00Z",
    ...over,
  };
}

const CONNECTIONS = [
  {
    id: "conn-1",
    name: "Nightly Redshift",
    provider: "redshift",
    direction: "export",
    status: "active",
    cadence: "daily",
    error: "",
    lastCursor: "",
  },
  {
    id: "conn-2",
    name: "Hourly S3 import",
    provider: "s3",
    direction: "import",
    status: "active",
    cadence: "hourly",
    error: "",
    lastCursor: "",
  },
];

const HEALTH = {
  connectionId: "conn-1",
  provider: "redshift",
  status: "active",
  health: "error",
  lastRunStatus: "failed",
  lastRunAt: "2026-07-25T03:00:00Z",
  error: "redshift: dial tcp: i/o timeout",
  missingRequiredSettings: [],
  warnings: [],
  providerRuntimeStatus: "supported",
  providerDriverAttachment: "inline",
};

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

/** The loaded happy path every test starts from, minus what it overrides. */
function loadRuns(wires: Record<string, unknown>[]) {
  queryHooks.__setHookResultForTests(
    "useWarehouseRuns",
    queryResult({ data: wires.map(normalizeWarehouseRun) }),
  );
  queryHooks.__setHookResultForTests(
    "useWarehouseConnections",
    queryResult({ data: CONNECTIONS }),
  );
}

function renderScreen(Component: React.ComponentType = WarehouseRunsScreen) {
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

describe("warehouse-runs route file", () => {
  it("mounts the default export the router actually loads", async () => {
    loadRuns([runWire()]);
    const result = await renderScreen(WarehouseRunsRoute);
    expect(result.getByText("Warehouse syncs")).toBeTruthy();
  });

  it("exports a route-scoped ErrorBoundary", () => {
    expect(typeof WarehouseErrorBoundary).toBe("function");
  });
});

describe("role gate", () => {
  it("explains the role instead of claiming the workspace has no runs", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    loadRuns([]);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
    expect(result.queryByText("No warehouse runs yet")).toBeNull();
  });

  it("denies an api_key session, which never carries the admin scope", async () => {
    authStore.__setAuthStateForTests({ mode: "api_key" });
    loadRuns([runWire()]);
    const result = await renderScreen();
    expect(result.getByText("Needs an owner or admin session")).toBeTruthy();
  });

  it("adds the 'your role changed' line only for a LIVE 403", async () => {
    queryHooks.__setHookResultForTests(
      "useWarehouseRuns",
      queryResult({ isError: true, error: { status: 403 } }),
    );
    queryHooks.__setHookResultForTests(
      "useWarehouseConnections",
      queryResult({ data: CONNECTIONS }),
    );
    const result = await renderScreen();
    expect(
      result.getByText(/The server refused this read just now/),
    ).toBeTruthy();
  });

  it("still shows the ordinary error state for a NON-403 failure", async () => {
    queryHooks.__setHookResultForTests(
      "useWarehouseRuns",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    queryHooks.__setHookResultForTests(
      "useWarehouseConnections",
      queryResult({ data: CONNECTIONS }),
    );
    const result = await renderScreen();
    expect(result.queryByText("Needs an owner or admin session")).toBeNull();
    expect(result.queryByText("No warehouse runs yet")).toBeNull();
  });
});

describe("run counters are a measurement, or they are an em-dash", () => {
  it("renders exact figures for a completed run", async () => {
    loadRuns([runWire()]);
    const result = await renderScreen();
    // completeRunTx wrote these, so they are real counts.
    expect(result.getByLabelText("12,000 Scanned")).toBeTruthy();
    expect(result.getByLabelText("11,940 Exported")).toBeTruthy();
  });

  it("refuses to print 0 for a FAILED run's never-written counters", async () => {
    loadRuns([
      runWire({
        status: "failed",
        error: "redshift: dial tcp: i/o timeout",
        rows_scanned: 0,
        rows_exported: 0,
      }),
    ]);
    const result = await renderScreen();
    expect(result.queryByLabelText("0 Scanned")).toBeNull();
    expect(
      result.getByLabelText(
        "Scanned: not measured — row counts are only written when a run completes",
      ),
    ).toBeTruthy();
  });
});

describe("failure evidence", () => {
  it("shows a failed run's own error message as the record", async () => {
    loadRuns([
      runWire({ status: "failed", error: "redshift: dial tcp: i/o timeout" }),
    ]);
    queryHooks.__setHookResultForTests(
      "useWarehouseRunErrors",
      queryResult({ data: [] }),
    );
    const result = await renderScreen();
    expect(result.getByText("redshift: dial tcp: i/o timeout")).toBeTruthy();
    // An empty ledger for a failed run must never read as "nothing went wrong".
    expect(result.getByText("No per-row reasons for this run")).toBeTruthy();
    expect(
      result.getByText(
        "This run failed outright, so no per-row reasons survived. What the server recorded about the failure is above.",
      ),
    ).toBeTruthy();
    // The empty state must not repeat the detail card's own sentence, which
    // appears exactly once.
    expect(
      result.getAllByText(/rolled back with the transaction/),
    ).toHaveLength(1);
  });

  it("says so when a failure was recorded with no message at all", async () => {
    loadRuns([runWire({ status: "failed", error: "" })]);
    const result = await renderScreen();
    expect(
      result.getByText("The server recorded a failure with no message."),
    ).toBeTruthy();
  });

  it("groups row errors by code and always carries the denominator", async () => {
    loadRuns([
      runWire({
        direction: "import",
        connection_id: "conn-2",
        rows_failed: 40,
        rows_imported: 60,
      }),
    ]);
    queryHooks.__setHookResultForTests(
      "useWarehouseRunErrors",
      queryResult({
        data: [
          {
            id: "1",
            runId: "run-1",
            sourceObject: "orders.jsonl",
            rowNumber: 4,
            code: "subscriber_not_found",
            message: "subscriber_id or known email is required",
            createdAt: "2026-07-25T03:00:30Z",
          },
          {
            id: "2",
            runId: "run-1",
            sourceObject: "orders.jsonl",
            rowNumber: 9,
            code: "subscriber_not_found",
            message: "subscriber_id or known email is required",
            createdAt: "2026-07-25T03:00:31Z",
          },
          {
            id: "3",
            runId: "run-1",
            sourceObject: "carts.jsonl",
            rowNumber: 2,
            code: "missing_event_name",
            message: "event_name or active mapping target_event_name is required",
            createdAt: "2026-07-25T03:00:32Z",
          },
        ],
      }),
    );
    const result = await renderScreen();
    expect(result.getByText("40 rows failed.")).toBeTruthy();
    // 3 recorded reasons for 40 failed rows — the sample is never a total.
    expect(
      result.getByText("3 of those 40 rows recorded a reason."),
    ).toBeTruthy();
    expect(
      result.getByLabelText(/^2 rows failed with subscriber_not_found\./),
    ).toBeTruthy();
  });

  it("flags failed rows that carry no recorded reason", async () => {
    loadRuns([runWire({ rows_failed: 7 })]);
    queryHooks.__setHookResultForTests(
      "useWarehouseRunErrors",
      queryResult({ data: [] }),
    );
    const result = await renderScreen();
    expect(
      result.getByText("7 rows failed, and no per-row reason was recorded."),
    ).toBeTruthy();
  });
});

describe("the nightly verdict", () => {
  it("names the denominator and never says 'never ran'", async () => {
    // conn-2 is scheduled but has no run in this window.
    loadRuns([runWire({ status: "failed", error: "boom" })]);
    const result = await renderScreen();
    expect(
      result.getByText(
        "The newest run failed for 1 of 2 scheduled connections.",
      ),
    ).toBeTruthy();
    expect(
      result.getByText("Read from the newest 1 run across every connection."),
    ).toBeTruthy();
    expect(result.getByLabelText(/Hourly S3 import, hourly schedule: no run here\./)).toBeTruthy();
  });

  it("withholds the verdict entirely when the connection roster failed", async () => {
    // Without the roster `expected` is 0, and the card would announce "no
    // connection is on a schedule" — a claim about the workspace derived from
    // a failed request. The runs themselves still render.
    queryHooks.__setHookResultForTests(
      "useWarehouseRuns",
      queryResult({ data: [normalizeWarehouseRun(runWire())] }),
    );
    queryHooks.__setHookResultForTests(
      "useWarehouseConnections",
      queryResult({ isError: true, error: { status: 500 } }),
    );
    const result = await renderScreen();
    expect(result.queryByText(/scheduled connection/)).toBeNull();
    // …and the run row degrades to an id stub rather than a blank name.
    expect(result.getAllByText("Connection conn-1").length).toBeGreaterThan(0);
  });

  it("states the healthy case positively rather than as a zero", async () => {
    loadRuns([runWire(), runWire({ id: "run-2", connection_id: "conn-2" })]);
    const result = await renderScreen();
    expect(
      result.getByText(
        "Every one of the 2 scheduled connections landed its newest run.",
      ),
    ).toBeTruthy();
  });
});

describe("the pause write", () => {
  function loadHealth() {
    loadRuns([runWire({ status: "failed", error: "boom" })]);
    queryHooks.__setHookResultForTests(
      "useWarehouseConnectionHealth",
      queryResult({ data: HEALTH }),
    );
  }

  it("pauses through the mutation and states it as done", async () => {
    const mutateAsync = jest.fn(async () => ({ id: "conn-1" }));
    loadHealth();
    queryHooks.__setHookResultForTests("usePauseWarehouseConnection", {
      mutate: jest.fn(),
      mutateAsync,
      isPending: false,
      reset: () => undefined,
    });
    const result = await renderScreen();

    await fireEvent.press(result.getByLabelText("Pause Nightly Redshift"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith("conn-1"));
    // 200 with the updated connection — so "is paused" is a fact, not a hope.
    await waitFor(() =>
      expect(result.getByText("Nightly Redshift is paused.")).toBeTruthy(),
    );
  });

  it("reports a refused pause without claiming anything changed", async () => {
    loadHealth();
    queryHooks.__setHookResultForTests("usePauseWarehouseConnection", {
      mutate: jest.fn(),
      mutateAsync: jest.fn(async () => {
        throw { status: 403 };
      }),
      isPending: false,
      reset: () => undefined,
    });
    const result = await renderScreen();

    await fireEvent.press(result.getByLabelText("Pause Nightly Redshift"));
    await waitFor(() =>
      expect(
        result.getByText(
          "Pausing a warehouse connection needs an owner or admin session.",
        ),
      ).toBeTruthy(),
    );
  });

  it("hides the pause entirely while offline instead of queueing it", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    loadHealth();
    const result = await renderScreen();
    expect(result.queryByLabelText("Pause Nightly Redshift")).toBeNull();
  });

  it("offers no pause for an already-paused connection", async () => {
    loadRuns([runWire({ status: "failed", error: "boom" })]);
    queryHooks.__setHookResultForTests(
      "useWarehouseConnectionHealth",
      queryResult({ data: { ...HEALTH, status: "paused", health: "paused" } }),
    );
    const result = await renderScreen();
    expect(result.queryByLabelText("Pause Nightly Redshift")).toBeNull();
    expect(result.getByText(/Already paused/)).toBeTruthy();
  });
});

describe("an orphaned run", () => {
  it("says the connection was deleted rather than rendering a blank", async () => {
    loadRuns([runWire({ connection_id: "" })]);
    const result = await renderScreen();
    // The row title, and the section label above the detail.
    expect(result.getAllByText("Deleted connection").length).toBe(2);
    expect(
      result.getByText(/This run's connection has been deleted/),
    ).toBeTruthy();
  });
});
