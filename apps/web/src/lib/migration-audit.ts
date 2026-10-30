// SPDX-License-Identifier: AGPL-3.0-only
//
// Human-readable labels for migration audit event codes. The API returns
// machine strings like `migration.dry_run_started`; the detail page rendered
// them verbatim in monospace (MIGR-029). This maps the known codes to plain
// English and falls back to a deterministic humanisation for anything new, so
// an unmapped code degrades gracefully rather than looking broken.

const KNOWN_EVENT_LABELS: Record<string, string> = {
  "migration.created": "Migration created",
  "migration.connected": "Source connected",
  "migration.source_session_refreshed": "Source session refreshed",
  "migration.discovered": "Account inspected",
  "migration.discovery_started": "Discovery started",
  "migration.dry_run_started": "Dry-run started",
  "migration.dry_run_completed": "Dry-run completed",
  "migration.committed": "Import committed",
  "migration.import_started": "Import started",
  "migration.segment_compiled": "Segments compiled",
  "migration.automation_persisted": "Automation evidence saved",
  "migration.archive_persisted": "Archive saved",
  "migration.completed": "Migration completed",
  "migration.failed": "Migration failed",
  "migration.cancelled": "Import cancelled",
  "migration.resumed": "Migration resumed",
  "migration.delta_import_started": "Delta import started",
  "migration.rollback_started": "Rollback started",
  "migration.rollback_completed": "Rollback completed",
  "migration.rolled_back": "Migration rolled back",
  "migration.cutover_evidence_recorded": "Cutover review recorded",
  "migration.shadow_monitor_enabled": "Shadow monitor enabled",
  "migration.shadow_monitor_disabled": "Shadow monitor disabled",
  "migration.source_events_enabled": "Source-event replay enabled",
  "migration.source_events_disabled": "Source-event replay disabled",
};

/** Friendly label for an audit event code (mapped, else humanised fallback). */
export function migrationAuditEventLabel(event: string): string {
  const mapped = KNOWN_EVENT_LABELS[event];
  if (mapped) return mapped;
  const tail = event.includes(".") ? event.slice(event.indexOf(".") + 1) : event;
  const words = tail.replace(/[._]+/g, " ").trim();
  if (words === "") return event;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
