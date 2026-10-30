/**
 * lib/transferJobRows.ts — the SERVER half of the transfer center.
 *
 * Split out of lib/transferCenter.ts, which crossed its 450-line ceiling once
 * the three server job families landed. The boundary is a real one rather
 * than a byte count: this file knows how a workspace export, an audit export
 * job and a subscriber import each describe themselves, and turns exactly one
 * of them into the shared row vocabulary. It owns no state and subscribes to
 * nothing.
 *
 * lib/transferCenter keeps the other half: the in-process share registry, the
 * aggregation order and "clear history" — the parts with module state and
 * listeners.
 *
 * Every phase, tone and detail string is derived from the domain's OWN state
 * rules (lib/exportRows.exportDownloadState, lib/auditExport.auditExportKind,
 * lib/subscriberImportJobs.importStatusPresentation) rather than re-read off
 * a raw status, so "ready but expired" or "stalled" cannot be decided one way
 * here and another way on the screen that owns the job.
 *
 * Pure: no react-native. The type import from ./transferCenter is type-only,
 * so there is no runtime cycle.
 */
import { auditExportKind, type AuditExportJob } from "./auditExport";
import { exportDownloadState, type TenantExportRow } from "./exportRows";
import {
  importStatusPresentation,
  isActiveImport,
  type SubscriberImportJob,
} from "./subscriberImportJobs";
import type {
  TransferAction,
  TransferPhase,
  TransferRow,
} from "./transferCenter";

/** A workspace data export (GET /api/v1/exports), as one row. */
export function tenantExportRow(
  row: TenantExportRow,
  now: number,
  canRetry: boolean,
): TransferRow {
  const state = exportDownloadState(row, new Date(now));
  const created = parseTransferTime(row.created_at);
  const label = "Workspace data export";
  const base = {
    id: `tenant-export:${row.id}`,
    source: "tenant-export" as const,
    direction: "export" as const,
    label,
    startedAt: created,
    updatedAt: created ?? now,
    openUrl: null,
  };
  switch (state.kind) {
    case "pending":
      return {
        ...base,
        phase: "active",
        tone: "info",
        detail: "Still building on the server",
        actions: [],
      };
    case "ready":
      return {
        ...base,
        phase: "done",
        tone: "success",
        detail: "Ready to download",
        actions: ["open"],
        openUrl: state.url,
      };
    case "expired":
      return {
        ...base,
        phase: "expired",
        tone: "warning",
        detail: "Download link expired",
        actions: canRetry ? ["retry"] : [],
      };
    case "unavailable":
      return {
        ...base,
        phase: "done",
        tone: "neutral",
        detail: "No download link on this deployment",
        actions: [],
      };
    case "failed":
      return {
        ...base,
        phase: "failed",
        tone: "danger",
        detail: state.reason ? `Failed: ${state.reason}` : "Export failed",
        actions: canRetry ? ["retry"] : [],
      };
  }
}

/** An audit-log export job (GET /api/v1/audit/export-jobs), as one row. */
export function auditExportRow(job: AuditExportJob, now: number): TransferRow {
  const kind = auditExportKind(job, now);
  const started = parseTransferTime(job.startedAt) ?? parseTransferTime(job.createdAt);
  const updated =
    parseTransferTime(job.completedAt) ??
    parseTransferTime(job.startedAt) ??
    parseTransferTime(job.createdAt) ??
    now;
  const base = {
    id: `audit-export:${job.id}`,
    source: "audit-export" as const,
    direction: "export" as const,
    label: "Audit log export",
    startedAt: started,
    updatedAt: updated,
    actions: [] as const,
    openUrl: null,
  };
  switch (kind) {
    case "queued":
      return { ...base, phase: "waiting", tone: "neutral", detail: "Queued on the server" };
    case "running":
      return { ...base, phase: "active", tone: "info", detail: "Exporting rows" };
    case "stalled":
      return {
        ...base,
        phase: "stalled",
        tone: "warning",
        detail: "No progress reported for a while",
      };
    case "done":
      return { ...base, phase: "done", tone: "success", detail: "Finished — download from the Audit screen" };
    case "failed":
      return {
        ...base,
        phase: "failed",
        tone: "danger",
        detail: job.errorReason?.trim() ? job.errorReason : "Export failed",
      };
  }
}

/** A subscriber import (GET /api/v1/subscriber-imports), as one row. */
export function subscriberImportRow(
  job: SubscriberImportJob,
  canCancel: boolean,
): TransferRow {
  const presentation = importStatusPresentation(job.status, job.cancelRequested);
  const status = job.status.trim().toLowerCase();
  const created = parseTransferTime(job.createdAt);
  const updated = parseTransferTime(job.lastChunkAt) ?? created ?? 0;
  const phase: TransferPhase =
    status === "preview"
      ? "waiting"
      : isActiveImport(status)
        ? "active"
        : status === "ready"
          ? "done"
          : status === "failed"
            ? "failed"
            : status === "cancelled"
              ? "cancelled"
              : "waiting";
  const actions: TransferAction[] =
    canCancel && isActiveImport(status) && !job.cancelRequested ? ["cancel"] : [];
  return {
    id: `subscriber-import:${job.id}`,
    source: "subscriber-import",
    direction: "import",
    label: job.filename.trim() ? `Import ${job.filename.trim()}` : "Subscriber import",
    detail: presentation.description,
    phase,
    tone: presentation.tone,
    startedAt: created,
    updatedAt: updated,
    actions,
    openUrl: null,
  };
}

/** An RFC-3339 stamp as epoch ms, or null when the server sent nothing usable. */
export function parseTransferTime(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
