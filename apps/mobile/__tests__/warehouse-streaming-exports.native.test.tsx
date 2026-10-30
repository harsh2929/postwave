import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import WarehouseRunsRoute from "../app/(tabs)/warehouse-runs";
import { ToastProvider } from "../src/components/Toast";
import { StreamingExportsDock } from "../src/components/warehouse/StreamingExportsDock";
import { STREAMING_ROWS_SHOWN } from "../src/components/warehouse/StreamingConnectionSection";
import {
  STREAMING_ISSUE_HIDDEN,
  normalizeStreamingExportHistory,
} from "../src/lib/streamingExportRuns";
import { normalizeWarehouseRun } from "../src/lib/warehouseRuns";

const queryHooks = require("./mocks/queryHooks.cjs");
const authStore = require("./mocks/authStore.cjs");

jest.mock("@/hooks/useWarehouseRuns", () => require("./mocks/queryHooks.cjs"));
jest.mock("@/hooks/useStreamingExportRuns", () =>
  require("./mocks/queryHooks.cjs"),
);

/**
 * The streaming dock has four places where it could state something false,
 * and each gets a test:
 *
 *   ABSENT — a workspace with no streaming connection must see NO dock, not
 *            a dock saying "0 connections"; and the roster must have ARRIVED
 *            before the dock decides that.
 *   ROLE   — the host screen refuses viewers and api_key sessions; a section
 *            of that screen must not be looser than the screen.
 *   LEAD   — a failed newest window leads the strip, with the denominator.
 *   PER-CONNECTION — one connection's 404 is explained on ITS section and
 *            never hides a sibling's failed window, because each read settles
 *            on its own.
 */

function streamingRunWire(over: Record<string, unknown> = {}) {
  return {
    id: "srun-1",
    connection_id: "conn-s1",
    status: "completed",
    format: "parquet",
    compression: "snappy",
    window_start: "2026-08-30T02:00:00Z",
    window_end: "2026-08-30T03:00:00Z",
    cursor_from: 1204,
    cursor_to: 1999,
    has_more: false,
    rows_shipped: 795,
    bytes_shipped: 2_516_582,
    issue_present: false,
    started_at: "2026-08-30T03:00:01Z",
    completed_at: "2026-08-30T03:00:09Z",
    created_at: "2026-08-30T03:00:01Z",
    ...over,
  };
}

const BATCH_CONNECTIONS = [
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
];

const STREAMING_CONNECTIONS = [
  {
    id: "conn-s1",
    name: "Currents to S3",
    provider: "streaming_export",
    direction: "export",
    status: "active",
    cadence: "hourly",
    error: "",
    lastCursor: "",
  },
  {
    id: "conn-s2",
    name: "Events to GCS",
    provider: "streaming_export",
    direction: "export",
    status: "active",
    cadence: "hourly",
    error: "",
    lastCursor: "",
  },
];

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

function read(
  connectionId: string,
  runs: Record<string, unknown>[] | null,
  lastShippedAt: string | null = null,
  errorStatus: number | null = null,
) {
  return {
    connectionId,
    history:
      runs === null
        ? null
        : normalizeStreamingExportHistory({
            items: runs,
            last_shipped_at: lastShippedAt,
          }),
    errorStatus,
  };
}

function loadRoster(connections: Record<string, unknown>[]) {
  queryHooks.__setHookResultForTests(
    "useWarehouseConnections",
    queryResult({ data: connections }),
  );
  queryHooks.__setHookResultForTests(
    "useWarehouseRuns",
    queryResult({ data: [] }),
  );
}

function loadHistories(reads: unknown[]) {
  queryHooks.__setHookResultForTests(
    "useStreamingExportHistories",
    queryResult({ data: reads }),
  );
}

/** Two streaming connections: the first failed its newest window. */
function loadOneFailingOneHealthy() {
  loadRoster([...BATCH_CONNECTIONS, ...STREAMING_CONNECTIONS]);
  loadHistories([
    read("conn-s1", [
      streamingRunWire({
        id: "f1",
        status: "failed",
        issue_present: true,
        rows_shipped: 0,
        bytes_shipped: 0,
      }),
      streamingRunWire({ id: "f0", window_end: "2026-08-30T02:00:00Z" }),
    ]),
    read(
      "conn-s2",
      [streamingRunWire({ id: "h1", connection_id: "conn-s2" })],
      "2026-08-30T03:00:00Z",
    ),
  ]);
}

function renderDock(Component: React.ComponentType = StreamingExportsDock) {
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

describe("route mount", () => {
  it("mounts the dock beside the batch screen the router actually loads", async () => {
    loadOneFailingOneHealthy();
    const result = await renderDock(WarehouseRunsRoute);
    expect(result.getByText("Warehouse syncs")).toBeTruthy();
    expect(result.getByText("Streaming exports")).toBeTruthy();
  });
});

describe("when there is nothing to say", () => {
  it("renders NOTHING for a workspace without a streaming connection", async () => {
    loadRoster(BATCH_CONNECTIONS);
    loadHistories([]);
    const result = await renderDock();
    expect(result.queryByText("Streaming exports")).toBeNull();
    expect(result.queryByLabelText(/^Streaming exports\./)).toBeNull();
  });

  it("waits for the roster before deciding there is nothing", async () => {
    queryHooks.__setHookResultForTests(
      "useWarehouseConnections",
      queryResult({ isLoading: true }),
    );
    const result = await renderDock();
    expect(result.queryByLabelText(/^Streaming exports\./)).toBeNull();
  });

  it("renders nothing for a viewer, matching the host screen's gate", async () => {
    authStore.__setAuthStateForTests({ session: { effectiveRole: "viewer" } });
    loadOneFailingOneHealthy();
    const result = await renderDock();
    expect(result.queryByLabelText(/^Streaming exports\./)).toBeNull();
  });

  it("renders nothing for an api_key session", async () => {
    authStore.__setAuthStateForTests({ mode: "api_key" });
    loadOneFailingOneHealthy();
    const result = await renderDock();
    expect(result.queryByLabelText(/^Streaming exports\./)).toBeNull();
  });
});

describe("the strip", () => {
  it("leads with the failed newest window and names the denominator", async () => {
    loadOneFailingOneHealthy();
    const result = await renderDock();
    expect(
      result.getByText(/1 of 2 connections did not land the newest window/),
    ).toBeTruthy();
    expect(result.getByText("1 not landed")).toBeTruthy();
    expect(
      result.getByLabelText(
        /^Streaming exports\. 1 of 2 connections did not land the newest window\. Last caught-up window/,
      ),
    ).toBeTruthy();
  });

  it("says it is reading while the history query is pending", async () => {
    loadRoster(STREAMING_CONNECTIONS);
    const result = await renderDock();
    expect(
      result.getByText("2 connections · reading shipped windows…"),
    ).toBeTruthy();
    expect(result.queryByText(/not landed/)).toBeNull();
  });

  it("says 'reconnect' rather than 'reading' when offline with nothing cached", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false, isOnline: false });
    loadRoster(STREAMING_CONNECTIONS);
    const result = await renderDock();
    expect(
      result.getByText("2 connections · reconnect to read shipped windows"),
    ).toBeTruthy();
  });

  it("states 'nothing has shipped yet' from an empty history, not a zero", async () => {
    loadRoster([STREAMING_CONNECTIONS[0]!]);
    loadHistories([read("conn-s1", [])]);
    const result = await renderDock();
    expect(
      result.getByText("1 connection · nothing has shipped yet"),
    ).toBeTruthy();
  });
});

describe("the sheet", () => {
  it("opens per-connection history and closes on Done", async () => {
    loadOneFailingOneHealthy();
    const result = await renderDock();
    expect(result.queryByLabelText("Done")).toBeNull();

    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));

    // Both roster names, each with its own verdict.
    expect(result.getByText("Currents to S3")).toBeTruthy();
    expect(result.getByText("Events to GCS")).toBeTruthy();
    expect(result.getByText(/^The newest window did not land\./)).toBeTruthy();
    expect(
      result.getByText(/^Caught up — the newest window landed\./),
    ).toBeTruthy();

    // The failed row hides the cursor behind the server's own admission and
    // never prints "0 rows" for a window on which nothing shipped.
    expect(result.getAllByText(STREAMING_ISSUE_HIDDEN)).toHaveLength(1);
    expect(result.getByText(/^nothing shipped/)).toBeTruthy();
    expect(result.queryByText(/0 rows/)).toBeNull();
    // The healthy row prints real figures.
    expect(result.getAllByText(/^795 rows · 2\.4 MB/)).toHaveLength(2);
    // The desktop's failed-window sentence, plus the phone's honest asymmetry.
    expect(
      result.getByText(/^Failed windows retain their bounded cursor\./),
    ).toBeTruthy();
    expect(result.getByText(/this app deliberately does not offer it/)).toBeTruthy();

    await fireEvent.press(result.getByLabelText("Done"));
    expect(result.queryByLabelText("Done")).toBeNull();
  });

  it("explains one connection's 404 on its own section without hiding the sibling", async () => {
    loadRoster(STREAMING_CONNECTIONS);
    loadHistories([
      read("conn-s1", null, null, 404),
      read("conn-s2", [
        streamingRunWire({
          id: "f1",
          connection_id: "conn-s2",
          status: "failed",
          issue_present: true,
        }),
      ]),
    ]);
    const result = await renderDock();
    // The strip still leads with the failure it COULD read.
    expect(
      result.getByText(/1 of 2 connections did not land the newest window/),
    ).toBeTruthy();

    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));
    expect(
      result.getByText(
        "Streaming export isn't enabled on this Moosewave server, or this connection was deleted.",
      ),
    ).toBeTruthy();
    expect(result.getByText(STREAMING_ISSUE_HIDDEN)).toBeTruthy();
  });

  it("never folds an unreadable history into 'caught up'", async () => {
    loadRoster(STREAMING_CONNECTIONS);
    loadHistories([
      read("conn-s1", [streamingRunWire()]),
      read("conn-s2", null, null, 0),
    ]);
    const result = await renderDock();
    expect(
      result.getByText(
        "1 connection landed the newest window · 1 unreadable",
      ),
    ).toBeTruthy();
    expect(result.getByText("1 unreadable")).toBeTruthy();
  });

  it("shows a skeleton per connection while the history is pending", async () => {
    loadRoster([STREAMING_CONNECTIONS[0]!]);
    const result = await renderDock();
    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));
    expect(
      result.getByLabelText("Loading shipped windows for Currents to S3"),
    ).toBeTruthy();
  });

  it("says 'no records were returned', never 'nothing is wrong', for an empty history", async () => {
    loadRoster([STREAMING_CONNECTIONS[0]!]);
    loadHistories([read("conn-s1", [])]);
    const result = await renderDock();
    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));
    // Once as the section's verdict, once as the body's note.
    expect(
      result.getAllByText(/^No shipment records were returned\./),
    ).toHaveLength(2);
    expect(
      result.getByText(/shipping one now is a web-admin action\.$/),
    ).toBeTruthy();
  });

  it("caps the rows shown and says how many the response held", async () => {
    const runs = Array.from({ length: STREAMING_ROWS_SHOWN + 1 }, (_, i) =>
      streamingRunWire({ id: `r${i}` }),
    );
    loadRoster([STREAMING_CONNECTIONS[0]!]);
    loadHistories([read("conn-s1", runs)]);
    const result = await renderDock();
    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));
    expect(result.getAllByText(/^795 rows · 2\.4 MB/)).toHaveLength(
      STREAMING_ROWS_SHOWN,
    );
    expect(
      result.getByText(
        `Showing the newest ${STREAMING_ROWS_SHOWN} of ${STREAMING_ROWS_SHOWN + 1} windows in this response — not every window ever.`,
      ),
    ).toBeTruthy();
  });

  it("never prints a figure for a window still shipping", async () => {
    loadRoster([STREAMING_CONNECTIONS[0]!]);
    loadHistories([
      read("conn-s1", [
        streamingRunWire({
          id: "run",
          status: "running",
          rows_shipped: 0,
          bytes_shipped: 0,
          completed_at: undefined,
        }),
      ]),
    ]);
    const result = await renderDock();
    expect(result.getByText(/1 connection landed the newest window/)).toBeTruthy();
    await fireEvent.press(result.getByLabelText(/^Streaming exports\./));
    expect(result.getByText(/^A window is shipping now\./)).toBeTruthy();
    expect(result.getByText(/not yet measured/)).toBeTruthy();
    expect(result.queryByText(/0 rows/)).toBeNull();
  });
});

describe("the batch screen is untouched", () => {
  it("still renders the batch monitor with a streaming roster present", async () => {
    loadOneFailingOneHealthy();
    queryHooks.__setHookResultForTests(
      "useWarehouseRuns",
      queryResult({
        data: [
          normalizeWarehouseRun({
            id: "run-1",
            connection_id: "conn-1",
            direction: "export",
            run_mode: "scheduled",
            status: "completed",
            rows_scanned: 12_000,
            rows_exported: 11_940,
            created_at: "2026-07-25T03:00:00Z",
            started_at: "2026-07-25T03:00:00Z",
            completed_at: "2026-07-25T03:04:30Z",
          }),
        ],
      }),
    );
    const result = await renderDock(WarehouseRunsRoute);
    expect(result.getByLabelText("12,000 Scanned")).toBeTruthy();
    expect(result.getByText("Streaming exports")).toBeTruthy();
  });
});
