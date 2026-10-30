import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditExportJob } from "./auditExport";
import type { TenantExportRow } from "./exportRows";
import type { SubscriberImportJob } from "./subscriberImportJobs";
import {
  activeLocalTransferCount,
  aggregateTransfers,
  clearFinishedTransfers,
  finishLocalTransfer,
  isActiveTransferPhase,
  listLocalTransfers,
  registerLocalTransferRetry,
  resetTransferCenterForTests,
  runLocalTransferRetry,
  startLocalTransfer,
  subscribeTransferCenter,
  transferCounts,
  transferHistoryHiddenBefore,
  transferSummary,
} from "./transferCenter";

const NOW = Date.parse("2026-09-02T12:00:00Z");
const SCOPE = "tenant_1:user_1";
const CAN = { cancelImports: true, retryExports: true };

function tenantExport(overrides: Partial<TenantExportRow> = {}): TenantExportRow {
  return {
    id: "e1",
    status: "ready",
    include: ["subscribers"],
    requested_by_email: "a@b.c",
    bytes_total: 10,
    rows_total: 3,
    download_url: "https://files.example/e1.zip",
    expires_at: new Date(NOW + 60_000).toISOString(),
    error: "",
    created_at: new Date(NOW - 120_000).toISOString(),
    ...overrides,
  };
}

function auditJob(overrides: Partial<AuditExportJob> = {}): AuditExportJob {
  return {
    id: "a1",
    status: "completed",
    createdAt: new Date(NOW - 300_000).toISOString(),
    startedAt: new Date(NOW - 200_000).toISOString(),
    completedAt: new Date(NOW - 100_000).toISOString(),
    ...overrides,
  };
}

function importJob(overrides: Partial<SubscriberImportJob> = {}): SubscriberImportJob {
  return {
    id: "i1",
    filename: "list.csv",
    status: "running",
    rowsTotal: 10,
    rowsNew: null,
    rowsExisting: null,
    rowsFileDupes: null,
    rowsImported: 4,
    rowsSkipped: null,
    rowsFailed: null,
    processedRows: 4,
    onExisting: "update",
    errorCode: "",
    errorMessage: "",
    createdAt: new Date(NOW - 50_000).toISOString(),
    cancelRequested: false,
    lastChunkAt: new Date(NOW - 10_000).toISOString(),
    ...overrides,
  };
}

function aggregate(
  input: Partial<Parameters<typeof aggregateTransfers>[0]> = {},
) {
  return aggregateTransfers({
    scope: SCOPE,
    local: [],
    tenantExports: [],
    auditJobs: [],
    importJobs: [],
    now: NOW,
    can: CAN,
    ...input,
  });
}

beforeEach(() => resetTransferCenterForTests());

describe("local share registry", () => {
  it("records a share from active to finished and scopes it to an identity", () => {
    const listener = vi.fn();
    subscribeTransferCenter(listener);
    const id = startLocalTransfer({ scope: SCOPE, direction: "share", label: "Subscribers CSV", now: NOW });
    expect(activeLocalTransferCount()).toBe(1);
    expect(listLocalTransfers(SCOPE)).toHaveLength(1);
    expect(listLocalTransfers("someone-else")).toHaveLength(0);
    finishLocalTransfer(id, "done", "Shared", NOW + 1_000);
    expect(activeLocalTransferCount()).toBe(0);
    expect(listLocalTransfers(SCOPE)[0]).toMatchObject({ phase: "done", detail: "Shared", updatedAt: NOW + 1_000 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("offers a retry only for a failed share that registered one, and runs it", async () => {
    const id = startLocalTransfer({ scope: SCOPE, direction: "share", label: "CSV", now: NOW });
    finishLocalTransfer(id, "failed", "Share sheet closed", NOW + 1);
    expect(aggregate({ local: listLocalTransfers(SCOPE) })[0]?.actions).toEqual([]);
    const retry = vi.fn(async () => undefined);
    registerLocalTransferRetry(id, retry);
    expect(aggregate({ local: listLocalTransfers(SCOPE) })[0]?.actions).toEqual(["retry"]);
    expect(await runLocalTransferRetry(id)).toBe(true);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(await runLocalTransferRetry("missing")).toBe(false);
    // A retry for an unknown record is never kept.
    registerLocalTransferRetry("ghost", retry);
    expect(await runLocalTransferRetry("ghost")).toBe(false);
  });

  it("caps the registry at 40 records, newest first", () => {
    for (let index = 0; index < 45; index += 1) {
      startLocalTransfer({ scope: SCOPE, direction: "share", label: `s${index}`, now: NOW + index });
    }
    const rows = listLocalTransfers(SCOPE);
    expect(rows).toHaveLength(40);
    expect(rows[0]?.label).toBe("s44");
  });

  it("clears finished shares but never an active one, and stamps the hide mark", () => {
    const active = startLocalTransfer({ scope: SCOPE, direction: "share", label: "A", now: NOW });
    const done = startLocalTransfer({ scope: SCOPE, direction: "share", label: "B", now: NOW });
    finishLocalTransfer(done, "done", "ok", NOW);
    registerLocalTransferRetry(done, () => undefined);
    clearFinishedTransfers(NOW + 5);
    expect(listLocalTransfers(SCOPE).map((row) => row.id)).toEqual([active]);
    expect(transferHistoryHiddenBefore()).toBe(NOW + 5);
  });
});

describe("aggregateTransfers", () => {
  it("maps a workspace export through its own download-state rules", () => {
    const rows = aggregate({
      tenantExports: [
        tenantExport({ id: "pending", status: "queued" }),
        tenantExport({ id: "ready" }),
        tenantExport({ id: "expired", expires_at: new Date(NOW - 1).toISOString() }),
        tenantExport({ id: "failed", status: "failed", error: "disk full" }),
        tenantExport({ id: "bare", download_url: "" }),
      ],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("tenant-export:pending")).toMatchObject({ phase: "active", actions: [], openUrl: null });
    expect(byId.get("tenant-export:ready")).toMatchObject({
      phase: "done",
      actions: ["open"],
      openUrl: "https://files.example/e1.zip",
    });
    expect(byId.get("tenant-export:expired")).toMatchObject({ phase: "expired", actions: ["retry"] });
    expect(byId.get("tenant-export:failed")).toMatchObject({
      phase: "failed",
      detail: "Failed: disk full",
      actions: ["retry"],
    });
    expect(byId.get("tenant-export:bare")).toMatchObject({ phase: "done", actions: [] });
  });

  it("withholds the export retry below admin", () => {
    const rows = aggregate({
      tenantExports: [tenantExport({ status: "failed" })],
      can: { cancelImports: true, retryExports: false },
    });
    expect(rows[0]?.actions).toEqual([]);
  });

  it("maps audit jobs including the derived stalled state", () => {
    const rows = aggregate({
      auditJobs: [
        auditJob({ id: "done" }),
        auditJob({ id: "run", status: "in_progress", completedAt: null, startedAt: new Date(NOW - 1_000).toISOString() }),
        // Stalled is derived for a PENDING job nothing has picked up (lib/auditExport
        // auditExportKind); an in_progress job is running however old it is.
        auditJob({ id: "stalled", status: "pending", completedAt: null, startedAt: null, createdAt: new Date(NOW - 60 * 60_000).toISOString() }),
        auditJob({ id: "queued", status: "pending", startedAt: null, completedAt: null, createdAt: new Date(NOW - 1_000).toISOString() }),
        auditJob({ id: "failed", status: "failed", errorReason: "worker died" }),
      ],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("audit-export:done")?.phase).toBe("done");
    expect(byId.get("audit-export:run")?.phase).toBe("active");
    expect(byId.get("audit-export:stalled")?.phase).toBe("stalled");
    expect(byId.get("audit-export:queued")?.phase).toBe("waiting");
    expect(byId.get("audit-export:failed")).toMatchObject({ phase: "failed", detail: "worker died" });
    for (const row of rows) expect(row.actions).toEqual([]);
  });

  it("offers cancel only on a running import the caller may cancel", () => {
    const rows = aggregate({
      importJobs: [
        importJob({ id: "run" }),
        importJob({ id: "stopping", cancelRequested: true }),
        importJob({ id: "staged", status: "preview" }),
        importJob({ id: "done", status: "ready" }),
        importJob({ id: "gone", status: "cancelled" }),
        importJob({ id: "broke", status: "failed" }),
      ],
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("subscriber-import:run")).toMatchObject({
      phase: "active",
      direction: "import",
      label: "Import list.csv",
      actions: ["cancel"],
    });
    expect(byId.get("subscriber-import:stopping")?.actions).toEqual([]);
    expect(byId.get("subscriber-import:staged")).toMatchObject({ phase: "waiting", actions: [] });
    expect(byId.get("subscriber-import:done")?.phase).toBe("done");
    expect(byId.get("subscriber-import:gone")?.phase).toBe("cancelled");
    expect(byId.get("subscriber-import:broke")?.phase).toBe("failed");
    expect(
      aggregate({ importJobs: [importJob()], can: { cancelImports: false, retryExports: true } })[0]?.actions,
    ).toEqual([]);
  });

  it("pins anything still moving on top, then newest first, and hides cleared finished rows", () => {
    const rows = aggregate({
      tenantExports: [
        tenantExport({ id: "old-done", created_at: new Date(NOW - 900_000).toISOString() }),
        tenantExport({ id: "new-done", created_at: new Date(NOW - 1_000).toISOString() }),
        tenantExport({ id: "building", status: "queued", created_at: new Date(NOW - 800_000).toISOString() }),
      ],
      hiddenBefore: NOW - 500_000,
    });
    expect(rows.map((row) => row.id)).toEqual(["tenant-export:building", "tenant-export:new-done"]);
  });

  it("never mixes another identity's shares into the list", () => {
    startLocalTransfer({ scope: "other", direction: "share", label: "theirs", now: NOW });
    startLocalTransfer({ scope: SCOPE, direction: "share", label: "mine", now: NOW });
    const rows = aggregate({ local: [...listLocalTransfers(SCOPE), ...listLocalTransfers("other")] });
    expect(rows.map((row) => row.label)).toEqual(["mine"]);
  });
});

describe("transferCounts / transferSummary", () => {
  it("buckets phases and never calls an empty list healthy", () => {
    const rows = aggregate({
      tenantExports: [tenantExport({ id: "a", status: "queued" }), tenantExport({ id: "b" }), tenantExport({ id: "c", status: "failed" })],
      auditJobs: [auditJob({ id: "s", status: "pending", completedAt: null, startedAt: null, createdAt: new Date(NOW - 60 * 60_000).toISOString() })],
    });
    const counts = transferCounts(rows);
    expect(counts).toEqual({ active: 2, finished: 1, failed: 1 });
    expect(transferSummary(counts)).toBe("2 in progress · 1 finished · 1 failed");
    expect(transferSummary({ active: 0, finished: 0, failed: 0 })).toBe("Nothing recorded yet");
    expect(isActiveTransferPhase("stalled")).toBe(true);
    expect(isActiveTransferPhase("done")).toBe(false);
  });
});
