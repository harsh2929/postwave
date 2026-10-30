/**
 * TransfersSection — the unified transfer center on the phone (parity
 * register, shell-crosscutting "one panel listing every in-flight/finished
 * export, download and upload with cancel / retry / clear-history").
 *
 * The AGGREGATION half — which server job becomes which phase, tone and set of
 * actions, and what "clear history" hides — is node-tested in
 * src/lib/transferCenter.test.ts against the real domain state rules. This
 * file pins the half only a render can reach:
 *
 *  1. EVERY ROW SPEAKS ONE SENTENCE (label, phase, detail) and offers exactly
 *     the verbs the model granted it — a viewer's row must not sprout a Stop.
 *  2. STOPPING AN IMPORT GOES THROUGH A CONFIRM and hands back the bare job
 *     id, not the prefixed row id — cancelling the wrong thing is the failure
 *     mode a `subscriber-import:` prefix leaking into the URL would cause.
 *  3. AN EMPTY LIST IS NEVER CALLED HEALTHY, a failed read is stated with a
 *     retry, and being offline is said out loud rather than shown as an
 *     empty panel.
 *  4. CLEAR HISTORY APPEARS ONLY WHEN THERE IS HISTORY to clear.
 *
 * The model is injected by mocking `useTransferCenter`, and the stub is TYPED
 * as `TransferCenterModel` so a shape change in the hook fails `tsc` here
 * rather than passing vacuously.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type { TransferCenterModel } from "@/hooks/useTransferCenter";
import type { TransferRow } from "@/lib/transferCenter";

const mockCalls = {
  cancelled: [] as string[],
  retriedLocal: [] as string[],
  retriedExport: 0,
  opened: [] as string[],
  cleared: 0,
  refreshed: 0,
};
let mockOpenResult = true;
let mockRetryExportResult = true;
let mockRetryLocalResult = true;

function rowOf(over: Partial<TransferRow> = {}): TransferRow {
  return {
    id: "tenant-export:e1",
    source: "tenant-export",
    direction: "export",
    label: "Workspace data export",
    detail: "Ready to download",
    phase: "done",
    tone: "success",
    startedAt: Date.parse("2026-09-01T09:00:00Z"),
    updatedAt: Date.parse("2026-09-01T09:00:00Z"),
    actions: ["open"],
    openUrl: "https://files.postwave.test/e1.zip",
    ...over,
  };
}

function modelOf(over: Partial<TransferCenterModel> = {}): TransferCenterModel {
  return {
    rows: [],
    counts: { active: 0, finished: 0, failed: 0 },
    summary: "Nothing recorded yet",
    loading: false,
    error: null,
    online: true,
    access: { exports: true, imports: true, audit: true },
    notice: null,
    cancelImport: (id: string) => {
      mockCalls.cancelled.push(id);
    },
    retryExport: async () => {
      mockCalls.retriedExport += 1;
      return mockRetryExportResult;
    },
    retryLocal: async (id: string) => {
      mockCalls.retriedLocal.push(id);
      return mockRetryLocalResult;
    },
    open: async (url: string) => {
      mockCalls.opened.push(url);
      return mockOpenResult;
    },
    clearHistory: () => {
      mockCalls.cleared += 1;
    },
    refresh: async () => {
      mockCalls.refreshed += 1;
    },
    busy: false,
    ...over,
  };
}

let mockModel: TransferCenterModel = modelOf();

jest.mock("@/hooks/useTransferCenter", () => ({
  __esModule: true,
  TRANSFERS_ADMIN_NOTICE:
    "Workspace exports and subscriber imports are admin-only, so only audit exports and this phone's shares are listed.",
  useTransferCenter: () => mockModel,
}));

import { ConfirmProvider } from "@/components/ConfirmSheet";
import { ToastProvider } from "@/components/Toast";
import {
  TransfersSection,
  TRANSFERS_EMPTY_NOTE,
} from "@/components/diagnostics/TransfersSection";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>
        <ToastProvider>{children}</ToastProvider>
      </ConfirmProvider>
    </SafeAreaProvider>
  );
}

const renderSection = () => render(<TransfersSection />, { wrapper });

beforeEach(() => {
  mockModel = modelOf();
  mockOpenResult = true;
  mockRetryExportResult = true;
  mockRetryLocalResult = true;
});

afterEach(() => {
  mockCalls.cancelled.length = 0;
  mockCalls.retriedLocal.length = 0;
  mockCalls.opened.length = 0;
  mockCalls.retriedExport = 0;
  mockCalls.cleared = 0;
  mockCalls.refreshed = 0;
});

describe("TransfersSection", () => {
  it("lists every source in one panel, each row speaking its own phase", async () => {
    mockModel = modelOf({
      summary: "1 in progress · 1 finished · 1 failed",
      counts: { active: 1, finished: 1, failed: 1 },
      rows: [
        rowOf({
          id: "subscriber-import:job-7",
          source: "subscriber-import",
          direction: "import",
          label: "Import members.csv",
          detail: "Importing rows",
          phase: "active",
          tone: "info",
          actions: ["cancel"],
          openUrl: null,
        }),
        rowOf(),
        rowOf({
          id: "audit-export:a3",
          source: "audit-export",
          label: "Audit log export",
          detail: "Export failed",
          phase: "failed",
          tone: "danger",
          actions: [],
          openUrl: null,
        }),
      ],
    });
    await renderSection();

    expect(screen.getByText("Transfers")).toBeTruthy();
    expect(screen.getByText("1 in progress · 1 finished · 1 failed")).toBeTruthy();
    expect(
      screen.getByLabelText("Import members.csv. In progress. Importing rows"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Workspace data export. Finished. Ready to download"),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Audit log export. Failed. Export failed"),
    ).toBeTruthy();
    // Verbs are the model's, not the row type's: the failed audit job offers
    // none, because a phone cannot re-run someone else's audit export.
    expect(screen.getByLabelText("Stop Import members.csv")).toBeTruthy();
    expect(screen.getByLabelText("Open Workspace data export")).toBeTruthy();
    expect(screen.queryByLabelText("Retry Audit log export")).toBeNull();
  });

  it("confirms a stop and cancels the bare job id, never the prefixed row id", async () => {
    mockModel = modelOf({
      counts: { active: 1, finished: 0, failed: 0 },
      rows: [
        rowOf({
          id: "subscriber-import:job-7",
          source: "subscriber-import",
          direction: "import",
          label: "Import members.csv",
          detail: "Importing rows",
          phase: "active",
          tone: "info",
          actions: ["cancel"],
          openUrl: null,
        }),
      ],
    });
    await renderSection();

    await fireEvent.press(screen.getByLabelText("Stop Import members.csv"));
    expect(
      screen.getByText(
        "Import members.csv stops after the current chunk. Rows already imported stay.",
      ),
    ).toBeTruthy();
    // Cancelling the confirm cancels nothing.
    await fireEvent.press(screen.getByLabelText("Cancel"));
    expect(mockCalls.cancelled).toEqual([]);

    await fireEvent.press(screen.getByLabelText("Stop Import members.csv"));
    await fireEvent.press(screen.getByLabelText("Stop import"));
    expect(mockCalls.cancelled).toEqual(["job-7"]);
  });

  it("opens a ready bundle's own URL and says so when the phone cannot", async () => {
    mockModel = modelOf({
      counts: { active: 0, finished: 1, failed: 0 },
      rows: [rowOf()],
    });
    await renderSection();
    await fireEvent.press(screen.getByLabelText("Open Workspace data export"));
    expect(mockCalls.opened).toEqual(["https://files.postwave.test/e1.zip"]);

    mockOpenResult = false;
    await fireEvent.press(screen.getByLabelText("Open Workspace data export"));
    expect(
      await screen.findByText(
        "Couldn't open the download for Workspace data export.",
      ),
    ).toBeTruthy();
  });

  it("retries this session's share through the local registry, not the export endpoint", async () => {
    mockModel = modelOf({
      counts: { active: 0, finished: 0, failed: 1 },
      rows: [
        rowOf({
          id: "local-abc",
          source: "local",
          direction: "share",
          label: "Diagnostics report",
          detail: "The share sheet could not open",
          phase: "failed",
          tone: "danger",
          actions: ["retry"],
          openUrl: null,
        }),
      ],
    });
    await renderSection();
    await fireEvent.press(screen.getByLabelText("Retry Diagnostics report"));
    expect(mockCalls.retriedLocal).toEqual(["local-abc"]);
    expect(mockCalls.retriedExport).toBe(0);
  });

  it("never calls an empty list healthy, and states a failed read with a retry", async () => {
    await renderSection();
    expect(screen.getByText("Nothing recorded yet")).toBeTruthy();
    expect(screen.getByText(TRANSFERS_EMPTY_NOTE)).toBeTruthy();
    // Nothing finished, so nothing to clear.
    expect(screen.queryByLabelText("Clear history")).toBeNull();

    mockModel = modelOf({ error: "upstream unavailable" });
    await renderSection();
    expect(screen.getByText("upstream unavailable")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry reading"));
    expect(mockCalls.refreshed).toBe(1);
  });

  it("says the lists may be stale while offline, and repeats the role notice", async () => {
    mockModel = modelOf({
      online: false,
      notice:
        "Workspace exports and subscriber imports are admin-only, so only audit exports and this phone's shares are listed.",
    });
    await renderSection();
    expect(
      screen.getByText(
        "You're offline — server lists may be stale, and cancel or retry need a connection.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Workspace exports and subscriber imports are admin-only, so only audit exports and this phone's shares are listed.",
      ),
    ).toBeTruthy();
  });

  it("offers Clear history exactly when there is finished or failed history", async () => {
    mockModel = modelOf({
      counts: { active: 2, finished: 0, failed: 0 },
      rows: [rowOf({ phase: "active", actions: [], openUrl: null })],
    });
    await renderSection();
    expect(screen.queryByLabelText("Clear history")).toBeNull();

    mockModel = modelOf({
      counts: { active: 0, finished: 1, failed: 0 },
      rows: [rowOf()],
    });
    await renderSection();
    await fireEvent.press(screen.getByLabelText("Clear history"));
    expect(mockCalls.cleared).toBe(1);
  });
});
