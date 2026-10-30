/**
 * lib/transferCenter.ts — every export, import and share in one list.
 *
 * Desktop's TransferCenter (apps/desktop/src/components/TransferCenter.tsx)
 * sits over a client-side journal that every file operation reports into
 * (lib/file-transfer-history.ts). Mobile has no file system to journal: an
 * export here is either a SERVER job the app already polls — a workspace
 * bundle (GET /api/v1/exports), an audit CSV job (GET /api/v1/audit/export-
 * jobs), a subscriber import (GET /api/v1/subscriber-imports) — or a share
 * sheet hand-off that lives and dies inside one process.
 *
 * So this module does two things and refuses a third:
 *
 *   1. AGGREGATES the server jobs the app is already reading into one row
 *      vocabulary (phase, direction, actions), reusing each domain's own
 *      state rules (lib/exportRows, lib/auditExport, lib/subscriberImportJobs)
 *      so "ready but expired" or "stalled" can never be re-derived wrongly.
 *   2. Keeps a small IN-PROCESS registry for share-sheet hand-offs, scoped to
 *      the signed-in identity, so this session's CSV shares appear beside the
 *      server jobs with a retry.
 *   3. Does NOT persist anything. A share is gone when the process is; the
 *      server rows are the durable history and are read live every time.
 *
 * "Clear history" therefore means: drop this phone's finished shares, and
 * hide server rows that finished before the moment of clearing — for this
 * session. The server's own list is untouched, which is what a phone should
 * do to a workspace-wide history.
 *
 * Pure: no react-native. The share helper that touches `Share` lives in
 * hooks/useTrackedShare.ts and reports here, and the per-family mapping of a
 * SERVER job to a row lives in lib/transferJobRows.ts (split out when this
 * file crossed its 450-line ceiling).
 */
import type { AuditExportJob } from "./auditExport";
import type { TenantExportRow } from "./exportRows";
import type { SubscriberImportJob } from "./subscriberImportJobs";
import {
  auditExportRow,
  subscriberImportRow,
  tenantExportRow,
} from "./transferJobRows";

export type TransferSource =
  | "tenant-export"
  | "audit-export"
  | "subscriber-import"
  | "local";
export type TransferDirection = "export" | "import" | "share";
export type TransferPhase =
  | "active"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "expired"
  | "stalled";
export type TransferAction = "cancel" | "retry" | "open";
export type TransferTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";

export interface TransferRow {
  id: string;
  source: TransferSource;
  direction: TransferDirection;
  label: string;
  detail: string;
  phase: TransferPhase;
  tone: TransferTone;
  startedAt: number | null;
  updatedAt: number;
  actions: readonly TransferAction[];
  /** A live signed URL for a ready bundle; null otherwise. */
  openUrl: string | null;
}

export interface LocalTransfer {
  id: string;
  scope: string;
  direction: TransferDirection;
  label: string;
  phase: "active" | "done" | "failed" | "cancelled";
  detail: string;
  startedAt: number;
  updatedAt: number;
}

const MAX_LOCAL = 40;
const ACTIVE_PHASES = new Set<TransferPhase>(["active", "waiting", "stalled"]);

let locals: LocalTransfer[] = [];
let sequence = 0;
let hiddenBefore = 0;
const retries = new Map<string, () => void | Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTransferCenter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Start a share-sheet hand-off. Returns the id to finish it with. */
export function startLocalTransfer(input: {
  scope: string;
  direction: TransferDirection;
  label: string;
  now?: number;
}): string {
  const now = input.now ?? Date.now();
  sequence += 1;
  const id = `local-${now.toString(36)}-${sequence.toString(36)}`;
  locals = [
    {
      id,
      scope: input.scope,
      direction: input.direction,
      label: input.label,
      phase: "active" as const,
      detail: "Preparing…",
      startedAt: now,
      updatedAt: now,
    },
    ...locals,
  ].slice(0, MAX_LOCAL);
  notify();
  return id;
}

export function finishLocalTransfer(
  id: string,
  phase: LocalTransfer["phase"],
  detail: string,
  now = Date.now(),
): void {
  let changed = false;
  locals = locals.map((record) => {
    if (record.id !== id) return record;
    changed = true;
    return { ...record, phase, detail, updatedAt: now };
  });
  if (changed) notify();
}

/** A retry the row can offer; dropped with the record. */
export function registerLocalTransferRetry(
  id: string,
  retry: () => void | Promise<void>,
): void {
  if (!locals.some((record) => record.id === id)) return;
  retries.set(id, retry);
  notify();
}

export async function runLocalTransferRetry(id: string): Promise<boolean> {
  const retry = retries.get(id);
  if (!retry) return false;
  await retry();
  return true;
}

export function listLocalTransfers(scope: string): readonly LocalTransfer[] {
  return locals.filter((record) => record.scope === scope);
}

/** Shares still in the share sheet — the restart scan counts these. */
export function activeLocalTransferCount(): number {
  return locals.filter((record) => record.phase === "active").length;
}

/**
 * Drop this phone's finished shares and hide server rows finished before now.
 * Active rows are never touched — a transfer cannot be "cleared" out of
 * existence while it is still moving.
 */
export function clearFinishedTransfers(now = Date.now()): void {
  locals = locals.filter((record) => record.phase === "active");
  for (const id of [...retries.keys()]) {
    if (!locals.some((record) => record.id === id)) retries.delete(id);
  }
  hiddenBefore = now;
  notify();
}

export function transferHistoryHiddenBefore(): number {
  return hiddenBefore;
}

/** Identity boundary: another person's shares must not outlive their sign-in. */
export function purgeLocalTransfers(): void {
  locals = [];
  retries.clear();
  hiddenBefore = 0;
  notify();
}

/** Test seam. */
export function resetTransferCenterForTests(): void {
  purgeLocalTransfers();
  sequence = 0;
  listeners.clear();
}

export interface AggregateTransfersInput {
  scope: string;
  local: readonly LocalTransfer[];
  tenantExports: readonly TenantExportRow[];
  auditJobs: readonly AuditExportJob[];
  importJobs: readonly SubscriberImportJob[];
  now?: number;
  /** Finished server rows updated before this instant are hidden. */
  hiddenBefore?: number;
  can: {
    /** POST /subscriber-imports/{id}/cancel is editor+. */
    cancelImports: boolean;
    /** POST /api/v1/exports is admin. */
    retryExports: boolean;
  };
}

/** One list, newest activity first, anything still moving pinned on top. */
export function aggregateTransfers(input: AggregateTransfersInput): TransferRow[] {
  const now = input.now ?? Date.now();
  const hidden = input.hiddenBefore ?? 0;
  const rows: TransferRow[] = [
    ...input.local
      .filter((record) => record.scope === input.scope)
      .map(localRow),
    ...input.tenantExports.map((row) =>
      tenantExportRow(row, now, input.can.retryExports),
    ),
    ...input.auditJobs.map((job) => auditExportRow(job, now)),
    ...input.importJobs.map((job) =>
      subscriberImportRow(job, input.can.cancelImports),
    ),
  ];
  return rows
    .filter((row) => ACTIVE_PHASES.has(row.phase) || row.updatedAt >= hidden)
    .sort((left, right) => {
      const leftActive = ACTIVE_PHASES.has(left.phase) ? 1 : 0;
      const rightActive = ACTIVE_PHASES.has(right.phase) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return right.updatedAt - left.updatedAt;
    });
}

export interface TransferCounts {
  active: number;
  finished: number;
  failed: number;
}

export function transferCounts(rows: readonly TransferRow[]): TransferCounts {
  const counts: TransferCounts = { active: 0, finished: 0, failed: 0 };
  for (const row of rows) {
    if (ACTIVE_PHASES.has(row.phase)) counts.active += 1;
    else if (row.phase === "failed" || row.phase === "expired") counts.failed += 1;
    else counts.finished += 1;
  }
  return counts;
}

/** The section subtitle. Never says "healthy": an empty list proves only that nothing was recorded. */
export function transferSummary(counts: TransferCounts): string {
  const total = counts.active + counts.finished + counts.failed;
  if (total === 0) return "Nothing recorded yet";
  const parts = [
    `${counts.active} in progress`,
    `${counts.finished} finished`,
    `${counts.failed} failed`,
  ];
  return parts.join(" · ");
}

export function isActiveTransferPhase(phase: TransferPhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

function localRow(record: LocalTransfer): TransferRow {
  const tone: TransferTone =
    record.phase === "active"
      ? "info"
      : record.phase === "done"
        ? "success"
        : record.phase === "failed"
          ? "danger"
          : "neutral";
  return {
    id: record.id,
    source: "local",
    direction: record.direction,
    label: record.label,
    detail: record.detail,
    phase: record.phase,
    tone,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    actions: record.phase === "failed" && retries.has(record.id) ? ["retry"] : [],
    openUrl: null,
  };
}
