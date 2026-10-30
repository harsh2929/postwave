// SPDX-License-Identifier: AGPL-3.0-only
//
// Export builders for the verification report and the full audit log
// (MIGR-026). Operators need the data-loss / field-mapping / warnings evidence
// and the complete activity trail as a file for records and sign-off. Reuses
// the shared RFC-4180 CSV helpers so escaping matches the rest of the app.

import { toCsv } from "./analytics-format";
import { migrationAuditEventLabel } from "./migration-audit";
import { absoluteTime } from "./relative-time";
import type { AuditEntry, VerificationReport } from "./types";

/** Verification report → CSV (summary metrics, field mapping, warnings). */
export function buildVerificationReportCsv(
  report: VerificationReport,
  sourceLabel: string,
  kind: "preview" | "imported" = "imported",
): string {
  const rows: Array<Array<string | number | null | undefined>> = [];
  rows.push(["section", "key", "value", "detail"]);

  const fidelity = (100 - report.data_loss_estimate_pct).toFixed(1);
  rows.push(["summary", "source", sourceLabel, ""]);
  rows.push([
    "summary",
    "report_kind",
    kind,
    kind === "preview"
      ? "Planned counts; no completed import is confirmed"
      : "Recorded import findings",
  ]);
  rows.push(["summary", "fidelity_pct", fidelity, ""]);
  rows.push([
    "summary",
    "data_loss_estimate_pct",
    report.data_loss_estimate_pct,
    "",
  ]);
  rows.push([
    "summary",
    "subscribers_imported",
    report.subscribers_imported,
    "",
  ]);
  rows.push(["summary", "segments_translated", report.segments_translated, ""]);
  rows.push([
    "summary",
    "automations_translated",
    report.automations_translated,
    "",
  ]);
  rows.push(["summary", "archive_imported", report.archive_imported, ""]);
  rows.push(["summary", "paid_subs_imported", report.paid_subs_imported, ""]);
  rows.push([
    "summary",
    "suppression_list_size",
    report.suppression_list_size,
    "",
  ]);
  rows.push([
    "summary",
    "duplicate_subscribers_merged",
    report.duplicate_subscribers_merged ?? 0,
    "",
  ]);

  // These four are typed non-optional but the Go handler marshals an empty
  // slice as `null`, and a truthy non-array (an SPA fallback body, a paged
  // envelope) would sail past `??`. An unguarded for-of throws inside the
  // Export button's own onClick, which React does not route to an error
  // boundary — the operator gets no file and no message.
  for (const m of Array.isArray(report.custom_fields_mapped)
    ? report.custom_fields_mapped
    : []) {
    rows.push(["custom_field_mapped", m.source, m.canonical, m.type]);
  }
  for (const u of Array.isArray(report.custom_fields_unmapped)
    ? report.custom_fields_unmapped
    : []) {
    rows.push([
      "custom_field_unmapped",
      u,
      "preserved as subscriber attribute",
      "",
    ]);
  }
  for (const row of report.resource_completeness ?? []) {
    rows.push([
      "resource_completeness",
      row.resource,
      `${row.imported}/${row.source_total}`,
      row.status,
    ]);
  }
  for (const w of report.discovery_warnings ?? []) {
    rows.push(["discovery_warning", "", w, ""]);
  }
  for (const s of Array.isArray(report.segments_with_warnings)
    ? report.segments_with_warnings
    : []) {
    rows.push(["segment_warning", s.name, s.warning, ""]);
  }
  for (const a of Array.isArray(report.automations_unsupported)
    ? report.automations_unsupported
    : []) {
    rows.push(["automation_unsupported", a.name, a.reason, ""]);
  }
  for (const w of report.campaign_archive_warnings ?? []) {
    rows.push([
      "campaign_archive_warning",
      w.name ?? w.source_id ?? w.resource,
      w.warning,
      "",
    ]);
  }
  for (const w of report.template_warnings ?? []) {
    rows.push([
      "template_warning",
      w.name ?? w.source_id ?? w.resource,
      w.warning,
      "",
    ]);
  }
  for (const w of report.source_archive_warnings ?? []) {
    rows.push([
      "source_archive_warning",
      w.name ?? w.source_id ?? w.resource,
      w.warning,
      "",
    ]);
  }

  return toCsv(rows);
}

/** Full audit log → CSV (human label, raw code, actor, absolute timestamp). */
export function buildAuditLogCsv(entries: AuditEntry[]): string {
  const rows: Array<Array<string | number | null | undefined>> = [
    ["timestamp", "event", "event_code", "actor", "fields"],
  ];
  for (const e of entries) {
    rows.push([
      absoluteTime(e.timestamp) || e.timestamp,
      migrationAuditEventLabel(e.event),
      e.event,
      e.actor,
      serializeFields(e.fields),
    ]);
  }
  return toCsv(rows);
}

function serializeFields(fields: AuditEntry["fields"]): string {
  const parts = Object.entries(fields ?? {}).map(
    ([k, v]) => `${k}=${v === null ? "" : String(v)}`,
  );
  return parts.join("; ");
}
