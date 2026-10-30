import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import Audit from "../app/(tabs)/audit";
import AuditSinks from "../app/(tabs)/audit-sinks";
import { AuditExportSchedules } from "@/components/audit/AuditExportSchedules";
import { AuditSinkReplaySheet } from "@/components/audit/AuditSinkReplaySheet";
import { parseAuditExportSchedules } from "@/lib/auditExportSchedules";
import { parseSinkReplayJobPage } from "@/lib/auditSinkReplay";

const queryHooks = require("./mocks/queryHooks.cjs");

/**
 * The governance screens had only a does-it-render smoke test. Nothing asserted
 * the behaviours a wrong reading actually depends on:
 *
 *  1. A FAILED FETCH IS NOT AN EMPTY ONE. "No activity in this window" on a
 *     compliance screen whose request 500'd tells an auditor the workspace was
 *     quiet. It must be an error with a retry.
 *  2. A COUNTER THAT NEVER LOADED IS NOT A ZERO. "0 circuits open" is an
 *     all-clear. An unfetched or failed monitoring query must render an
 *     em-dash.
 *  3. THE EXPORT MUST DISCLOSE WHAT IT DROPS. The search box and the
 *     Destructive toggle narrow only what is loaded on this device; the server
 *     has no facet for either. An export launched from a narrowed screen that
 *     silently ignores them produces a CSV that disagrees with the screen —
 *     for an audit artefact, the worst possible outcome.
 *
 * Every mocked payload below is the hook's REAL return shape (an infinite query
 * exposes `data.pages`, not `data`), because a mock with the wrong shape passes
 * on its error path and asserts nothing about the loaded state.
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
    hasNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => ({ data: undefined }),
    dataUpdatedAt: Date.now(),
    ...over,
  };
}

/** `useAuditLog` is an INFINITE query: rows live under `data.pages[].rows`. */
function auditPages(rows: unknown[], over: Record<string, unknown> = {}) {
  return queryResult({
    data: { pages: [{ rows, nextCursor: null }], pageParams: [null] },
    ...over,
  });
}

const ROW = {
  id: 91,
  action: "subscriber.delete",
  resourceType: "subscriber",
  resourceId: "8f2c1d4e-0000-4000-8000-000000000000",
  actorType: "user",
  actorLabel: "ada@example.com",
  ip: "203.0.113.9",
  metadata: {},
  at: new Date().toISOString(),
};

const SINK = {
  id: "sink-1",
  name: "Splunk HEC",
  kind: "splunk",
  circuit_state: "open",
  consecutive_failures: 3,
  auto_disable_after: 5,
  last_error: "connection refused",
  last_failure_at: new Date().toISOString(),
  cooldown_until: new Date(Date.now() + 60_000).toISOString(),
};

function renderScreen(Component: React.ComponentType) {
  return render(React.createElement(Component), {
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

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

describe("audit log", () => {
  it("renders a loaded event with its actor, resource and day divider", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);

    expect(result.getByText("Subscriber deleted")).toBeTruthy();
    expect(result.getByText("ada@example.com")).toBeTruthy();
    // Grouped by calendar day — today's rows sit under a "Today" header, and
    // that header is a VoiceOver rotor stop.
    expect(result.getByText("Today")).toBeTruthy();
  });

  it("keeps a transformed event key selectable in the detail sheet", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);

    await fireEvent.press(result.getByLabelText(/^Subscriber deleted,/));

    expect(result.getByLabelText("Event key: subscriber.delete")).toBeTruthy();
    expect(result.getByText("subscriber.delete").props.selectable).toBe(true);
  });

  it("shows an error with a retry — NOT 'no activity' — when the fetch fails", async () => {
    queryHooks.__setHookResultForTests(
      "useAuditLog",
      auditPages([], { isError: true, error: new Error("boom") }),
    );
    const result = await renderScreen(Audit);

    expect(result.queryByText("No activity in this window")).toBeNull();
    expect(result.getByLabelText("Retry")).toBeTruthy();
  });

  it("says the window is empty only when the fetch actually succeeded", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([]));
    const result = await renderScreen(Audit);

    expect(result.getByText("No activity in this window")).toBeTruthy();
    expect(result.queryByLabelText("Retry")).toBeNull();
  });

  it("re-applies the actor chip client-side, so a chip never keeps a row it excludes", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);

    expect(result.getByText("Subscriber deleted")).toBeTruthy();
    // The chip is ALSO pushed to the server, but a snapshot read offline was
    // captured unfiltered — so the client re-filter is what actually keeps the
    // list honest, and it has to drop a non-matching row.
    await fireEvent.press(result.getByLabelText("Agent"));
    expect(result.queryByText("Subscriber deleted")).toBeNull();
    expect(result.getByText("Nothing matches")).toBeTruthy();
  });

  it("distinguishes 'nothing matches' from 'nothing happened' once narrowed", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);

    await fireEvent.press(result.getByLabelText("Show only destructive actions"));
    // The one loaded row is a delete, so it survives the destructive filter.
    expect(result.getByText("Subscriber deleted")).toBeTruthy();
  });
});

describe("audit activity summary", () => {
  it("answers 'is today normal?' before the feed answers 'what happened'", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    queryHooks.__setHookResultForTests(
      "useAuditStats",
      queryResult({
        data: {
          totalEvents: 64,
          byActorType: [],
          topActions: [],
          daily: [
            { date: "2026-07-22", count: 10 },
            { date: "2026-07-23", count: 10 },
            { date: "2026-07-24", count: 10 },
            { date: "2026-07-25", count: 34 },
          ],
        },
      }),
    );
    const result = await renderScreen(Audit);

    // The state is a WORD, not just a border colour — and the multiplier is
    // stated so "34 events" has a baseline to mean anything against.
    expect(result.getByText(/Elevated/)).toBeTruthy();
    expect(result.getByText(/3\.4×/)).toBeTruthy();
  });

  it("renders no scare card when the stats endpoint declined", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    queryHooks.__setHookResultForTests(
      "useAuditStats",
      queryResult({ data: null }),
    );
    const result = await renderScreen(Audit);

    // A 403/404/501 on an enrichment must be silence, not "Activity
    // unavailable" shouted above an audit log that loaded perfectly well.
    expect(result.queryByText(/Activity unavailable/)).toBeNull();
    expect(result.getByText("Subscriber deleted")).toBeTruthy();
  });
});

describe("audit export", () => {
  it("discloses that the on-device narrowing will NOT reach the file", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);

    await fireEvent.press(result.getByLabelText("Show only destructive actions"));
    await fireEvent.press(result.getByLabelText("Export the audit log"));

    // The applied scope is stated…
    await waitFor(() =>
      expect(result.getByText(/Everything in the last 7 days/)).toBeTruthy(),
    );
    // …and so is the part the server cannot honour.
    expect(
      result.getByText(/the Destructive-only toggle[\s\S]*will NOT narrow the file/),
    ).toBeTruthy();
  });

  it("never offers a download or an email — neither is reachable from a phone", async () => {
    queryHooks.__setHookResultForTests("useAuditLog", auditPages([ROW]));
    const result = await renderScreen(Audit);
    await fireEvent.press(result.getByLabelText("Export the audit log"));

    await waitFor(() =>
      expect(result.getByText(/Collect the CSV from the web admin/)).toBeTruthy(),
    );
    expect(result.queryByLabelText("Download")).toBeNull();
    expect(result.queryByText(/Email it to me/i)).toBeNull();
  });
});

describe("audit sinks", () => {
  it("renders an em-dash, never a reassuring zero, when the health query failed", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({ isError: true, error: new Error("boom"), data: undefined }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ isError: true, error: new Error("boom"), data: undefined }),
    );
    const result = await renderScreen(AuditSinks);

    expect(result.getByLabelText("Circuit open unavailable")).toBeTruthy();
    expect(result.getByLabelText("Failing unavailable")).toBeTruthy();
    expect(result.getByLabelText("DLQ unavailable")).toBeTruthy();
    // And the list itself is an error, not "No audit sinks".
    expect(result.queryByText("No audit sinks")).toBeNull();
  });

  it("offers Reset while a breaker is open", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({ data: [SINK] }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ data: { entries: [], count: 0 } }),
    );
    const result = await renderScreen(AuditSinks);

    expect(result.getByText("Splunk HEC")).toBeTruthy();
    expect(result.getByLabelText("Reset circuit")).toBeTruthy();
  });

  it("withholds Reset on a healthy sink — a no-op control teaches the wrong lesson", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({
        data: [{ ...SINK, circuit_state: "closed", consecutive_failures: 0 }],
      }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ data: { entries: [], count: 0 } }),
    );
    const result = await renderScreen(AuditSinks);

    expect(result.queryByLabelText("Reset circuit")).toBeNull();
    expect(result.getByLabelText("Send test event")).toBeTruthy();
  });

  it("offers the lifecycle verbs on a loaded sink — disable, delete, range replay", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({ data: [{ ...SINK, enabled: true }] }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ data: { entries: [], count: 0 } }),
    );
    const result = await renderScreen(AuditSinks);

    expect(result.getByLabelText("Disable")).toBeTruthy();
    expect(result.getByLabelText("Delete")).toBeTruthy();
    expect(result.getByLabelText("Replay a range")).toBeTruthy();
  });

  it("a disabled sink offers Enable, not Disable — the verb states the direction", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({ data: [{ ...SINK, enabled: false }] }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ data: { entries: [], count: 0 } }),
    );
    const result = await renderScreen(AuditSinks);

    expect(result.getByLabelText("Enable")).toBeTruthy();
    expect(result.queryByLabelText("Disable")).toBeNull();
  });

  it("states how current the health reading is", async () => {
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinks",
      queryResult({ data: [SINK], dataUpdatedAt: Date.now() - 3 * 60_000 }),
    );
    queryHooks.__setHookResultForTests(
      "useMobileAuditSinkDlq",
      queryResult({ data: { entries: [], count: 0 }, dataUpdatedAt: Date.now() }),
    );
    const result = await renderScreen(AuditSinks);

    // The age shown is the OLDER of the two queries — a screen is only as
    // fresh as its stalest source.
    expect(result.getByText(/Sink health as of/)).toBeTruthy();
  });
});

describe("the sink replay sheet", () => {
  const SHEET_SINK = { ...SINK, id: "sink-1", name: "Splunk HEC" };

  it("refuses a nonsense range in the server's own words, and starts nothing", async () => {
    queryHooks.__setHookResultForTests(
      "useSinkReplayJobs",
      queryResult({ data: { jobs: [], truncated: false } }),
    );
    const result = await renderScreen(() => (
      <AuditSinkReplaySheet sink={SHEET_SINK as never} onClose={() => undefined} />
    ));

    // By placeholder: the field LABEL Text above each input carries the same
    // implicit accessibility label as the input itself, and a changeText that
    // lands on the Text is a silent no-op.
    await fireEvent.changeText(result.getByPlaceholderText("100000"), "250");
    await fireEvent.changeText(result.getByPlaceholderText("120000"), "100");
    await fireEvent.press(result.getByLabelText("Start replay"));

    expect(result.getByText(/from_id must not exceed to_id/)).toBeTruthy();
  });

  it("renders each job as a sentence and offers Cancel exactly where it bites", async () => {
    queryHooks.__setHookResultForTests(
      "useSinkReplayJobs",
      queryResult({
        data: parseSinkReplayJobPage({
          jobs: [
            {
              id: "j1",
              from_audit_id: 100,
              to_audit_id: 200,
              status: "in_progress",
              rows_sent: 50,
              rows_failed: 0,
            },
            {
              id: "j2",
              from_audit_id: 1,
              to_audit_id: 99,
              status: "completed",
              rows_sent: 99,
              rows_failed: 0,
            },
          ],
        }),
      }),
    );
    const result = await renderScreen(() => (
      <AuditSinkReplaySheet sink={SHEET_SINK as never} onClose={() => undefined} />
    ));

    expect(result.getByText(/Replaying rows 100–200/)).toBeTruthy();
    expect(result.getByText(/Completed · rows 1–99/)).toBeTruthy();
    // One cancel — for the in_progress job only. A cancel on a completed job
    // is a control that can only teach "this does nothing".
    expect(result.getAllByLabelText("Cancel")).toHaveLength(1);
  });

  it("admits when the server withheld older jobs", async () => {
    queryHooks.__setHookResultForTests(
      "useSinkReplayJobs",
      queryResult({
        data: { jobs: [], truncated: true },
      }),
    );
    const result = await renderScreen(() => (
      <AuditSinkReplaySheet sink={SHEET_SINK as never} onClose={() => undefined} />
    ));

    expect(result.getByText(/Older jobs exist beyond this page/)).toBeTruthy();
  });
});

describe("scheduled evidence exports", () => {
  const ROWS = parseAuditExportSchedules({
    schedules: [
      {
        id: "s1",
        cadence: "weekly",
        recipients: ["soc@example.com"],
        enabled: true,
      },
    ],
  });

  function controller(over: Record<string, unknown> = {}) {
    return {
      rows: ROWS,
      loading: false,
      failed: false,
      canManage: true,
      creating: false,
      create: jest.fn(async () => true),
      removing: false,
      remove: jest.fn(async () => true),
      ...over,
    };
  }

  it("renders each schedule as a sentence, and says scheduled runs are MAILED", async () => {
    const result = await renderScreen(() => (
      <AuditExportSchedules controller={controller() as never} />
    ));

    expect(result.getByText("Weekly → soc@example.com · has not run yet")).toBeTruthy();
    expect(result.getByText(/emailed to its recipients/)).toBeTruthy();
  });

  it("withholds the create form and the delete verb from a non-admin", async () => {
    const result = await renderScreen(() => (
      <AuditExportSchedules controller={controller({ canManage: false }) as never} />
    ));

    expect(result.queryByLabelText("Create schedule")).toBeNull();
    expect(result.queryByLabelText("Delete")).toBeNull();
    // The roster itself still renders — knowing a recurring evidence export
    // exists is the compliance answer.
    expect(result.getByText(/Weekly → soc@example.com/)).toBeTruthy();
  });

  it("refuses bad input with the server's own rules, and creates nothing", async () => {
    const ctl = controller();
    const result = await renderScreen(() => (
      <AuditExportSchedules controller={ctl as never} />
    ));

    await fireEvent.press(result.getByLabelText("Create schedule"));
    expect(
      result.getByText("At least one recipient email is required."),
    ).toBeTruthy();
    expect(ctl.create).not.toHaveBeenCalled();
  });

  it("creates with the normalised recipient list", async () => {
    const ctl = controller();
    const result = await renderScreen(() => (
      <AuditExportSchedules controller={ctl as never} />
    ));

    await fireEvent.changeText(
      result.getByPlaceholderText("soc@example.com, auditor@example.com"),
      "a@b.co, a@B.CO",
    );
    await fireEvent.press(result.getByLabelText("Create schedule"));

    expect(ctl.create).toHaveBeenCalledWith({
      cadence: "weekly",
      recipients: ["a@b.co"],
    });
  });

  it("a failed fetch is an error, never an empty roster", async () => {
    const result = await renderScreen(() => (
      <AuditExportSchedules
        controller={controller({ rows: undefined, failed: true }) as never}
      />
    ));

    expect(result.getByText(/Couldn't load the schedules/)).toBeTruthy();
    expect(result.queryByText(/No recurring exports are set up/)).toBeNull();
  });
});
