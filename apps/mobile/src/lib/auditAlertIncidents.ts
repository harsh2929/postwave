/**
 * lib/auditAlertIncidents.ts — the WIRE + DESCRIBE layer for the external
 * incidents an audit-alert rule has opened.
 *
 * WHY THIS IS A SEPARATE SURFACE FROM `fires`. A FIRE is "the rule matched and
 * we tried to deliver"; an INCIDENT is "a ticket exists in ServiceNow / Jira /
 * PagerDuty and somebody owns it". They are different tables written by
 * different code paths (`audit_alert_fires` by the worker's delivery loop,
 * `audit_alert_incidents` by `recordOutboundIncident` on ticketing channels and
 * then MUTATED by the inbound webhook as the external system's status changes),
 * and they answer different questions. A rule can have fired a hundred times
 * with every ticket already closed, or fired twice with both still open — and
 * only the second is worth waking up for.
 *
 * FACTS READ OFF THE GO SOURCE, NOT off openapi.json:
 *
 *  1. ENVELOPE. `Deps.Incidents` ends in
 *     `writeJSON(w, 200, {"incidents": out})` and adds `"nextCursor"` ONLY when
 *     another page exists (audit_alerts.go:345-349). The parser also accepts a
 *     bare array, because an envelope change that silently empties a governance
 *     screen is this repo's most-repeated mobile failure mode.
 *  2. THE READ IS KEYSET-PAGINATED on `(updated_at, id)` with a default page
 *     size of 200 (`pagination.ReadParamsWithDefault(q, 200, MaxLimit)`), so
 *     `nextCursor` is a real possibility and "these are all of them" is a claim
 *     this module refuses to make on its own.
 *  3. `external_system` IS CHECK-CONSTRAINED to servicenow|jira|pagerduty
 *     (migration 0268), but `incident_status` IS NOT — it is a nullable text
 *     column whose values arrive from an external SOC system through
 *     `InboundWebhook`. So an unrecognised status is shown verbatim rather than
 *     mapped onto a reassuring default.
 *  4. STATUS CAN BE ABSENT. `COALESCE(incident_status,'')` means "nothing has
 *     been synced back yet" arrives as an empty string. ABSENCE IS NOT ZERO and
 *     it is emphatically not "closed": an unsynced ticket renders as unknown.
 *  5. `incident_url` IS AN EXTERNAL, TENANT-SUPPLIED STRING. The ServiceNow /
 *     Jira / PagerDuty adapters build it, and `InboundWebhook` lets the remote
 *     system OVERRIDE it. It therefore never reaches `Linking.openURL` without
 *     passing `incidentLink`, which admits `https://` and nothing else.
 *
 * Import-free of react-native / expo so it runs in the node vitest environment.
 */
import {
  auditAlertCount,
  auditAlertTimestamp,
} from "@/lib/auditAlertRules";

/** The systems migration 0268's CHECK constraint admits. */
export const AUDIT_ALERT_INCIDENT_SYSTEMS = [
  "servicenow",
  "jira",
  "pagerduty",
] as const;

export interface AuditAlertIncident {
  id: number;
  ruleId: string;
  /** The audit row that triggered the ticket; null when the column was NULL. */
  auditId: number | null;
  externalSystem: string;
  externalIncidentId: string;
  /** "" means nothing has ever been synced back — NOT that it is closed. */
  incidentStatus: string;
  incidentUrl: string;
  lastSyncedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AuditAlertIncidentPage {
  incidents: AuditAlertIncident[];
  /** Non-null means the server withheld older incidents. */
  nextCursor: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseAuditAlertIncident(
  value: unknown,
): AuditAlertIncident | null {
  const row = record(value);
  const id = auditAlertCount(row["id"]);
  const externalIncidentId = str(row["external_incident_id"]);
  // A row with no id cannot be keyed, and one with no external id names no
  // ticket — neither is renderable, and inventing a placeholder would put a
  // fictional incident on a governance screen.
  if (id === null || !externalIncidentId) return null;
  return {
    id,
    ruleId: str(row["rule_id"]),
    auditId: auditAlertCount(row["audit_id"]),
    externalSystem: str(row["external_system"]),
    externalIncidentId,
    incidentStatus: str(row["incident_status"]),
    incidentUrl: str(row["incident_url"]),
    lastSyncedAt: auditAlertTimestamp(row["last_synced_at"]),
    createdAt: auditAlertTimestamp(row["created_at"]),
    updatedAt: auditAlertTimestamp(row["updated_at"]),
  };
}

export function parseAuditAlertIncidentPage(
  payload: unknown,
): AuditAlertIncidentPage {
  const envelope = record(payload);
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(envelope["incidents"])
      ? (envelope["incidents"] as unknown[])
      : [];
  const next = str(envelope["nextCursor"]);
  return {
    incidents: source
      .map(parseAuditAlertIncident)
      .filter((row): row is AuditAlertIncident => row !== null),
    nextCursor: next || null,
  };
}

const SYSTEM_LABELS: Readonly<Record<string, string>> = {
  servicenow: "ServiceNow",
  jira: "Jira",
  pagerduty: "PagerDuty",
};

/** An unknown system is shown verbatim rather than as a reassuring default. */
export function incidentSystemLabel(system: string): string {
  const key = system.trim().toLowerCase();
  return SYSTEM_LABELS[key] ?? (system.trim() || "External system");
}

/**
 * The four states `InboundWebhook` documents, plus the two the wire can
 * genuinely produce and the doc comment does not: nothing synced yet, and a
 * value the external system invented. `incident_status` has no CHECK
 * constraint, so both are reachable.
 */
export type AuditAlertIncidentState =
  | "open"
  | "in_progress"
  | "resolved"
  | "closed"
  | "unsynced"
  | "other";

export function incidentState(status: string): AuditAlertIncidentState {
  switch (status.trim().toLowerCase()) {
    case "":
      return "unsynced";
    case "open":
      return "open";
    case "in_progress":
    case "in progress":
      return "in_progress";
    case "resolved":
      return "resolved";
    case "closed":
      return "closed";
    default:
      return "other";
  }
}

export interface AuditAlertIncidentPresentation {
  /** The visible word. State is never colour-alone. */
  label: string;
  tone: "danger" | "warning" | "success" | "neutral";
  /** The full sentence a screen reader gets instead of the compacted pill. */
  spoken: string;
  /** True while somebody still owns this ticket. */
  outstanding: boolean;
}

export function incidentPresentation(
  incident: AuditAlertIncident,
): AuditAlertIncidentPresentation {
  const system = incidentSystemLabel(incident.externalSystem);
  switch (incidentState(incident.incidentStatus)) {
    case "open":
      return {
        label: "Open",
        tone: "danger",
        spoken: `Open in ${system}. Nobody has resolved it yet.`,
        outstanding: true,
      };
    case "in_progress":
      return {
        label: "In progress",
        tone: "warning",
        spoken: `In progress in ${system}.`,
        outstanding: true,
      };
    case "resolved":
      return {
        label: "Resolved",
        tone: "success",
        spoken: `Resolved in ${system}.`,
        outstanding: false,
      };
    case "closed":
      return {
        label: "Closed",
        tone: "neutral",
        spoken: `Closed in ${system}.`,
        outstanding: false,
      };
    case "unsynced":
      // The ticket was created; no status has ever come back. Reading that as
      // "closed" would be the single most dangerous default on this screen.
      return {
        label: "Status not synced",
        tone: "warning",
        spoken: `A ticket exists in ${system} but no status has been synced back, so whether anyone is working on it is unknown.`,
        outstanding: true,
      };
    default:
      return {
        label: incident.incidentStatus,
        tone: "neutral",
        spoken: `${system} reports the status "${incident.incidentStatus}", which this app does not recognise.`,
        outstanding: true,
      };
  }
}

/**
 * The only URL this app will hand to `Linking.openURL`.
 *
 * `incident_url` is written by the outbound adapters and then OVERRIDABLE by
 * whatever POSTs the inbound webhook, so it is external input. Anything that is
 * not an `https://` URL returns null and the row renders the ticket id alone —
 * a missing link is a smaller harm than opening an attacker-chosen scheme.
 */
export function incidentLink(incident: AuditAlertIncident): string | null {
  return /^https:\/\/[^\s]+$/iu.test(incident.incidentUrl)
    ? incident.incidentUrl
    : null;
}

/** How many tickets nobody has finished with. Drives the sheet's summary. */
export function outstandingIncidentCount(
  incidents: readonly AuditAlertIncident[],
): number {
  return incidents.filter((row) => incidentPresentation(row).outstanding).length;
}
