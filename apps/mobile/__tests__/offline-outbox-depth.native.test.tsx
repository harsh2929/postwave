/**
 * OfflineQueueSection's outbox DEPTH (parity register, shell-crosscutting
 * "edit a queued/failed mutation body before retry, undo a discard (restore),
 * and retry/edit dead-letter items"; desktop anchor QueueTray.tsx with its
 * Edit → QueuedMutationEditor and its restoreOutboxItem undo toast).
 *
 * The editor itself is pinned in queued-write-sheet.native.test.tsx. What only
 * this composition can prove:
 *
 *  1. EVERY ROW CARRIES ITS VERBS — Details always, Edit when the write is
 *     editable and not on the wire, Resolve only when the failure is a real
 *     conflict. A row on the wire offers no Edit at all.
 *  2. A DISCARD IS UNDOABLE. It confirms, then the toast carries an Undo that
 *     RESTORES THE SAME WRITE — a mis-tap was previously unrecoverable, which
 *     is the whole point of the register row.
 *  3. THE FAILURE JOURNAL ROWS get the verbs too, so a write that already
 *     failed is reachable without hunting for its queue row.
 *  4. A WRITE THIS BUILD CANNOT READ BACK still discards — through the plain
 *     removal path — rather than losing the verb entirely.
 *
 * `useQueuedWriteDetails` is stubbed (it binds the singleton QueryClient and a
 * live identity), TYPED as `QueuedWriteDetails` so a signature change fails
 * `tsc` here instead of passing vacuously. Everything it feeds —
 * QueuedWriteTools' verb rules, the confirm, the undo toast — is real.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import type {
  QueuedWriteDetails,
  QueuedWriteReissue,
} from "@/hooks/useQueuedWriteDetails";
import type { QueuedWriteDetail } from "@/lib/queuedWriteDetail";

const mockRestored: string[] = [];
const mockDiscarded: string[] = [];
let mockDetails: QueuedWriteDetail[] = [];
let mockDiscardable = true;

const mockOk = (): QueuedWriteReissue => ({
  ok: true,
  reissued: { mutationId: 99, settled: Promise.resolve("sent") },
});

const mockHook = (): QueuedWriteDetails => ({
  details: mockDetails,
  detailFor: (operationId: string) =>
    mockDetails.find((detail) => detail.operationId === operationId) ?? null,
  reissue: () => mockOk(),
  retry: () => mockOk(),
  restore: (detail: QueuedWriteDetail) => {
    mockRestored.push(detail.operationId);
    return mockOk();
  },
  discard: (detail: QueuedWriteDetail) => {
    if (!mockDiscardable) return false;
    mockDiscarded.push(detail.operationId);
    return true;
  },
  refresh: () => undefined,
});

jest.mock("@/hooks/useQueuedWriteDetails", () => ({
  __esModule: true,
  useQueuedWriteDetails: () => mockHook(),
}));

import { ConfirmProvider } from "@/components/ConfirmSheet";
import {
  OfflineQueueSection,
  type OfflineQueueModel,
} from "@/components/diagnostics/OfflineQueueSection";
import { DISCARDED_TOAST } from "@/components/diagnostics/QueuedWriteTools";
import { ToastProvider } from "@/components/Toast";
import type { OfflineMutationQueueItem } from "@/lib/offlineMutationQueue";

function detailOf(over: Partial<QueuedWriteDetail> = {}): QueuedWriteDetail {
  return {
    mutationId: 1,
    operationId: "operation-00000001",
    kind: "entity_write",
    label: "Rename tag",
    status: "queued",
    method: "PATCH",
    path: "/api/v1/tags/12",
    body: { name: "VIP" },
    failure: null,
    editable: true,
    variables: {},
    ...over,
  };
}

function itemOf(over: Partial<OfflineMutationQueueItem> = {}): OfflineMutationQueueItem {
  return {
    mutationId: 1,
    operationId: "operation-00000001",
    label: "Rename tag",
    status: "queued",
    queuedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    cancellable: true,
    retrySafe: true,
    ...over,
  };
}

function modelOf(over: Partial<OfflineQueueModel> = {}): OfflineQueueModel {
  const items = over.items ?? [itemOf()];
  return {
    items,
    failures: [],
    counts: { queued: items.length, syncing: 0, failed: 0, sent: 0 },
    refresh: async () => undefined,
    scope: null,
    ...over,
  };
}

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

const renderQueue = (model: OfflineQueueModel, resolveOperationId?: string) =>
  render(
    <OfflineQueueSection
      model={model}
      {...(resolveOperationId ? { resolveOperationId } : {})}
    />,
    { wrapper },
  );

beforeEach(() => {
  mockDetails = [detailOf()];
  mockDiscardable = true;
});

afterEach(() => {
  mockRestored.length = 0;
  mockDiscarded.length = 0;
});

describe("offline outbox depth", () => {
  it("gives an editable queued write Details and Edit, and withholds Resolve", async () => {
    await renderQueue(modelOf());
    expect(screen.getByLabelText("Details of Rename tag")).toBeTruthy();
    expect(screen.getByLabelText("Edit Rename tag")).toBeTruthy();
    expect(screen.queryByLabelText("Resolve conflict for Rename tag")).toBeNull();
  });

  it("offers no Edit for a write that is already on the wire", async () => {
    mockDetails = [detailOf({ status: "syncing" })];
    await renderQueue(modelOf({ items: [itemOf({ status: "syncing", cancellable: false })] }));
    expect(screen.getByLabelText("Details of Rename tag")).toBeTruthy();
    expect(screen.queryByLabelText("Edit Rename tag")).toBeNull();
  });

  it("offers Resolve only when the failure is a real precondition conflict", async () => {
    mockDetails = [
      detailOf({
        status: "failed",
        failure: { status: 500, code: null, message: "boom" },
      }),
    ];
    await renderQueue(modelOf({ items: [itemOf({ status: "failed" })] }));
    expect(screen.queryByLabelText("Resolve conflict for Rename tag")).toBeNull();

    mockDetails = [
      detailOf({
        status: "failed",
        failure: { status: 409, code: null, message: "conflict" },
      }),
    ];
    await renderQueue(modelOf({ items: [itemOf({ status: "failed" })] }));
    expect(screen.getByLabelText("Resolve conflict for Rename tag")).toBeTruthy();
  });

  it("makes a discard undoable: the confirm says so and the toast restores it", async () => {
    await renderQueue(modelOf());
    await fireEvent.press(screen.getByLabelText("Discard Rename tag"));
    // The confirm no longer claims the change is gone permanently.
    expect(
      screen.getByText(
        '"Rename tag" has not reached the server. Discarding drops it from this phone — Undo on the confirmation puts it back.',
      ),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Discard"));
    expect(mockDiscarded).toEqual(["operation-00000001"]);

    expect(await screen.findByText(DISCARDED_TOAST)).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Undo"));
    expect(mockRestored).toEqual(["operation-00000001"]);
    expect(await screen.findByText("Change restored to the queue.")).toBeTruthy();
  });

  it("refuses to pretend a write on the wire was discarded", async () => {
    mockDiscardable = false;
    await renderQueue(modelOf());
    await fireEvent.press(screen.getByLabelText("Discard Rename tag"));
    await fireEvent.press(screen.getByLabelText("Discard"));
    expect(
      await screen.findByText("That change is being sent right now."),
    ).toBeTruthy();
    expect(mockRestored).toEqual([]);
  });

  it("opens the resolver on arrival when the banner deep-linked one operation", async () => {
    // The tag route has no single-record GET, so the sheet opens WITHOUT a
    // wire read — which is also what proves the auto-open is the thing under
    // test rather than a fetch.
    mockDetails = [
      detailOf({
        status: "failed",
        failure: { status: 409, code: null, message: "conflict" },
      }),
    ];
    await renderQueue(
      modelOf({ items: [itemOf({ status: "failed" })] }),
      "operation-00000001",
    );
    expect(await screen.findByText("The server copy changed first")).toBeTruthy();
    expect(
      screen.getByLabelText("Resolve conflict: Rename tag"),
    ).toBeTruthy();
  });

  it("carries the same verbs on a journalled failure row", async () => {
    mockDetails = [
      detailOf({
        status: "failed",
        failure: { status: 412, code: null, message: "conflict" },
      }),
    ];
    await renderQueue(
      modelOf({
        items: [],
        failures: [
          {
            id: "failure-1",
            operationId: "operation-00000001",
            tenantId: "t1",
            baseUrl: "https://api.postwave.test",
            principalId: "u1",
            role: "admin",
            kind: "entity_write",
            label: "Rename tag",
            message: "A newer server version conflicts with this queued change.",
            failedAt: "2026-09-03T09:00:00Z",
          },
        ],
        counts: { queued: 0, syncing: 0, failed: 1, sent: 0 },
      }),
    );
    expect(screen.getByLabelText("Resolve conflict for Rename tag")).toBeTruthy();
    expect(screen.getByLabelText("Details of Rename tag")).toBeTruthy();
  });
});
