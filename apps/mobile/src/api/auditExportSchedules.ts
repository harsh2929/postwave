/**
 * api/auditExportSchedules.ts — transport for recurring evidence-pack exports
 * (shapes and gates documented in lib/auditExportSchedules; this module is
 * URLs and envelopes over the `{data,error}` seam).
 */
import {
  parseAuditExportSchedules,
  type AuditExportSchedule,
  type ExportScheduleBody,
} from "@/lib/auditExportSchedules";

import { checkedApiResult, rawRequest } from "./request";

export const AUDIT_EXPORT_SCHEDULES_PATH = "/api/v1/audit/export-schedules";

export async function fetchAuditExportSchedules(): Promise<
  AuditExportSchedule[]
> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", AUDIT_EXPORT_SCHEDULES_PATH),
  );
  return parseAuditExportSchedules(res.data);
}

/**
 * Create a schedule. The body comes from `buildExportScheduleBody`, which is
 * null for anything the server's validator would 400 — callers must never
 * send around it.
 */
export async function createAuditExportSchedule(
  body: ExportScheduleBody,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", AUDIT_EXPORT_SCHEDULES_PATH, body),
  );
}

export async function deleteAuditExportSchedule(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "DELETE",
      `${AUDIT_EXPORT_SCHEDULES_PATH}/${encodeURIComponent(id)}`,
    ),
  );
}
