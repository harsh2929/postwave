/**
 * P2.39 (five non-CRM provider families) · P2.40 (per-row run history) · the
 * analytics-destinations console — the three reads the integrations tab was
 * missing, exercised through the tab and the panel.
 *
 * What these pin, and why a rendered label was not enough:
 *
 *   • The five families are MOUNTED on app/(tabs)/integrations.tsx, each under
 *     its own heading, and the analytics one carries the console's roll-up
 *     ("3 destinations · 1 failing · 1 disconnected"). A panel that renders in
 *     isolation but was never added to the screen would pass a panel test.
 *   • A disconnected row offers NO verb: every verb on one answers 409, and
 *     the list returns such rows for every family except marketing's.
 *   • Tapping a row is what fetches its runs. `useConnectionRuns` must not be
 *     called at all while the row is collapsed — a panel of twelve rows must
 *     cost zero run requests — and must be called with THIS row's id once it
 *     is open. A history that fetched eagerly, or fetched the wrong id, would
 *     still render a label.
 *   • The run's four states are named, and the server's error_message is
 *     rendered whole.
 *   • A 422 payload_required on Sync now surfaces the server's own sentence,
 *     not "something went wrong".
 *
 * The family hooks are mocked at the module boundary (as the sibling
 * integrations-panels suite does) so each family can answer differently in one
 * render; the online gate comes from the queryHooks proxy.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React, { type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

jest.mock("@/hooks/useConnectionFamily", () => ({
  useConnectionFamily: jest.fn(),
  useRunConnectionVerb: jest.fn(),
}));
jest.mock("@/hooks/useConnectionRuns", () => ({
  useConnectionRuns: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const familyHooks = require("@/hooks/useConnectionFamily");
const runHooks = require("@/hooks/useConnectionRuns");
const queryHooks = require("./mocks/queryHooks.cjs");
/* eslint-enable @typescript-eslint/no-require-imports */

// eslint-disable-next-line import/first
import Integrations from "../app/(tabs)/integrations";
// eslint-disable-next-line import/first
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import { AnalyticsDestinationsConsole } from "@/components/integrations/AnalyticsDestinationsConsole";
// eslint-disable-next-line import/first
import { ConnectionFamilyPanel } from "@/components/integrations/ConnectionFamilyPanel";
// eslint-disable-next-line import/first
import { RUN_HISTORY_COPY } from "@/components/integrations/ConnectionRunHistory";
// eslint-disable-next-line import/first
import type { ConnectionRow } from "@/lib/connectionLifecycle";
// eslint-disable-next-line import/first
import type { ConnectionRun } from "@/lib/connectionRuns";

/** The real useQuery result shape, settled, so every branch a panel reads exists. */
function settled(data: unknown) {
  return {
    data,
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    refetch: jest.fn(),
  };
}

function failed() {
  return {
    ...settled(undefined),
    error: new Error("500"),
    isError: true,
    isSuccess: false,
  };
}

function loading() {
  return { ...settled(undefined), isLoading: true, isPending: true, isSuccess: false };
}

const idleMutation = () => ({ isPending: false, mutate: jest.fn() });

function connection(over: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "wb1",
    name: "Shopify write-back",
    status: "error",
    lastRunAt: "",
    errorMessage: "Shopify rejected 1 customer",
    ...over,
  };
}

/** integration_writeback/types.go Run, already parsed by lib/connectionRuns. */
const PARTIAL_RUN: ConnectionRun = {
  id: "r1",
  status: "partial",
  runMode: "manual",
  startedAt: "2026-08-30T09:00:00Z",
  completedAt: "2026-08-30T09:00:04Z",
  rowsFailed: 1,
  errorMessage: "Shopify rejected 1 customer: email invalid",
  counts: [
    { key: "members_seen", label: "members seen", value: 12 },
    { key: "matched", label: "matched", value: 10 },
    { key: "tags_written", label: "tags written", value: 4 },
  ],
};

/** One row per family, so each heading on the tab can be told apart. */
const FAMILY_ROWS: Record<string, ConnectionRow[]> = {
  writeback: [],
  marketing: [],
  analytics: [
    connection({ id: "an1", name: "Segment", status: "active", errorMessage: "" }),
    connection({
      id: "an2",
      name: "RudderStack",
      status: "error",
      errorMessage: "401 from RudderStack",
    }),
    connection({ id: "an3", name: "GA4", status: "disconnected", errorMessage: "" }),
  ],
  lead: [connection({ id: "ld1", name: "Typeform", status: "active" })],
  review: [connection({ id: "rv1", name: "Yotpo", status: "paused" })],
  loyalty: [connection({ id: "ly1", name: "Smile.io", status: "active" })],
  subscription: [connection({ id: "sb1", name: "Recharge", status: "active" })],
};

// analytics_integrations/handlers.go:354, verbatim.
const PAYLOAD_REQUIRED =
  "analytics sync/backfill requires canonical profiles or events; no provider puller is wired for this provider";

const WRITEBACK_ROW_LABEL = "Shopify write-back, error";

// `restoreMocks: true` wipes implementations before every test, so every hook
// is re-armed here rather than in the factories above.
beforeEach(() => {
  familyHooks.useConnectionFamily.mockImplementation((family: string) =>
    settled(FAMILY_ROWS[family] ?? []),
  );
  familyHooks.useRunConnectionVerb.mockImplementation(idleMutation);
  runHooks.useConnectionRuns.mockImplementation(() => settled([]));
});

afterEach(() => {
  queryHooks.__resetHookResultsForTests();
  queryHooks.__resetOnlineGateForTests();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </SafeAreaProvider>
  );
}

/** A write-back panel with one failing row, its run history at the given read. */
async function renderWritebackRow(runs: () => unknown) {
  familyHooks.useConnectionFamily.mockImplementation(() => settled([connection()]));
  runHooks.useConnectionRuns.mockImplementation(runs);
  await render(<ConnectionFamilyPanel family="writeback" />, { wrapper });
}

/** Toggle the row's run history; the press is a state update, so it is flushed inside act. */
async function pressRow() {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(WRITEBACK_ROW_LABEL));
  });
}

describe("P2.39 — the five non-CRM families are mounted on the integrations tab", () => {
  it("renders each family under its own heading with its rows", async () => {
    await render(<Integrations />, { wrapper });
    for (const label of [
      "Analytics destinations",
      "Lead sources",
      "Review providers",
      "Loyalty providers",
      "Subscription providers",
    ]) {
      // Exactly once: the console must not mount the analytics family twice.
      expect(screen.getAllByText(label)).toHaveLength(1);
    }
    for (const name of [
      "Segment",
      "RudderStack",
      "GA4",
      "Typeform",
      "Yotpo",
      "Smile.io",
      "Recharge",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("offers the family's real verbs to an admin — and never a Resume it has no route for", async () => {
    await render(<Integrations />, { wrapper });
    expect(screen.getByLabelText("Sync now RudderStack")).toBeTruthy();
    expect(screen.getByLabelText("Pause RudderStack")).toBeTruthy();
    // Paused review provider: sync/backfill stay, pause goes, resume is never invented.
    expect(screen.getByLabelText("Sync now Yotpo")).toBeTruthy();
    expect(screen.queryByLabelText("Pause Yotpo")).toBeNull();
    expect(screen.queryByLabelText("Resume Yotpo")).toBeNull();
  });

  it("offers nothing on a disconnected row, and says why", async () => {
    await render(<Integrations />, { wrapper });
    expect(
      screen.getByText(
        "Disconnected. Reconnect it from the web admin before it can run again.",
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Sync now GA4")).toBeNull();
    expect(screen.queryByLabelText("Pause GA4")).toBeNull();
    expect(screen.queryByLabelText("Disconnect GA4")).toBeNull();
  });

  it("shows a viewer the rows and the run disclosure, but no verbs", async () => {
    queryHooks.__setOnlineGateForTests({ effectiveRole: "viewer" });
    await render(<ConnectionFamilyPanel family="analytics" />, { wrapper });
    expect(screen.getByLabelText("RudderStack, error")).toBeTruthy();
    expect(screen.getAllByText("Runs")).toHaveLength(3);
    expect(screen.queryByLabelText("Sync now RudderStack")).toBeNull();
    expect(screen.queryByLabelText("Disconnect RudderStack")).toBeNull();
  });
});

describe("analytics-destinations console", () => {
  it("rolls the family's rows up under the heading", async () => {
    await render(<Integrations />, { wrapper });
    expect(
      screen.getByText("3 destinations · 1 failing · 1 disconnected"),
    ).toBeTruthy();
  });

  it("names a failed read and shows no numbers for it", async () => {
    familyHooks.useConnectionFamily.mockImplementation((family: string) =>
      family === "analytics" ? failed() : settled([]),
    );
    await render(<AnalyticsDestinationsConsole />, { wrapper });
    expect(
      screen.getByText(
        "Couldn't load analytics destinations. Pull to refresh — this is not the same as having none.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/destinations? ·/)).toBeNull();
  });

  it("surfaces the server's own 422 sentence when Sync now is refused", async () => {
    const mutate = jest.fn(
      (_vars: unknown, opts?: { onError?: (err: unknown) => void }) =>
        opts?.onError?.({ status: 422, message: PAYLOAD_REQUIRED }),
    );
    familyHooks.useRunConnectionVerb.mockImplementation(() => ({
      isPending: false,
      mutate,
    }));
    await render(<AnalyticsDestinationsConsole />, { wrapper });
    // The press runs an async handler that ends in a toast state update.
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Sync now Segment"));
    });
    expect(mutate).toHaveBeenCalledWith(
      { family: "analytics", id: "an1", verb: "sync" },
      expect.anything(),
    );
    expect(await screen.findByText(PAYLOAD_REQUIRED)).toBeTruthy();
  });
});

describe("P2.40 — tapping a row opens its run history", () => {
  it("fetches nothing while collapsed, then this row's runs once opened", async () => {
    await renderWritebackRow(() => settled([PARTIAL_RUN]));

    expect(runHooks.useConnectionRuns).not.toHaveBeenCalled();
    expect(screen.queryByText(PARTIAL_RUN.errorMessage)).toBeNull();
    expect(screen.getByText("Runs")).toBeTruthy();

    await pressRow();

    expect(runHooks.useConnectionRuns).toHaveBeenCalledWith("writeback", "wb1");
    expect(screen.getByText("Hide runs")).toBeTruthy();
    // The counters in the server's order and words, then the failed count.
    expect(
      screen.getByText("12 members seen · 10 matched · 4 tags written · 1 failed"),
    ).toBeTruthy();
    // The server's error sentence, whole.
    expect(screen.getByText(PARTIAL_RUN.errorMessage)).toBeTruthy();

    await pressRow();
    expect(screen.queryByText(PARTIAL_RUN.errorMessage)).toBeNull();
    expect(screen.getByText("Runs")).toBeTruthy();
  });

  it("names a failed run read — it is not 'no runs'", async () => {
    await renderWritebackRow(failed);
    await pressRow();
    expect(screen.getByText(RUN_HISTORY_COPY.failed)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText(RUN_HISTORY_COPY.empty)).toBeNull();
  });

  it("says 'no runs yet' only on a successful empty read", async () => {
    await renderWritebackRow(() => settled([]));
    await pressRow();
    expect(screen.getByText(RUN_HISTORY_COPY.empty)).toBeTruthy();
    expect(screen.queryByText(RUN_HISTORY_COPY.failed)).toBeNull();
  });

  it("says 'loading' before the read has answered", async () => {
    await renderWritebackRow(loading);
    await pressRow();
    expect(screen.getByText(RUN_HISTORY_COPY.loading)).toBeTruthy();
    expect(screen.queryByText(RUN_HISTORY_COPY.empty)).toBeNull();
  });

  it("offline, says so rather than showing a stale copy as current", async () => {
    queryHooks.__setOnlineGateForTests({ enabled: false });
    await renderWritebackRow(() => settled([PARTIAL_RUN]));
    await pressRow();
    expect(screen.getByText(RUN_HISTORY_COPY.offline)).toBeTruthy();
    expect(screen.queryByText(PARTIAL_RUN.errorMessage)).toBeNull();
  });
});
