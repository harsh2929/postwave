// SPDX-License-Identifier: AGPL-3.0-only

import type { BadgeProps } from "@/components/ui/badge";
import type {
  PrivacyIncident,
  PrivacyIncidentSeverity,
  PrivacyIncidentState,
} from "@/lib/privacy-incidents-api";

export const STATE_LABEL: Record<PrivacyIncidentState, string> = {
  open: "Open",
  contained: "Contained",
  notifications_pending: "Notifications pending",
  closed: "Closed",
};

export const SEVERITY_LABEL: Record<PrivacyIncidentSeverity, string> = {
  investigating: "Investigating",
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export function stateVariant(
  value: PrivacyIncidentState,
): BadgeProps["variant"] {
  if (value === "closed") return "outline";
  if (value === "contained") return "success";
  if (value === "notifications_pending") return "warning";
  return "info";
}

export function severityVariant(
  value: PrivacyIncidentSeverity,
): BadgeProps["variant"] {
  if (value === "critical") return "destructive";
  if (value === "high") return "warning";
  if (value === "low") return "outline";
  return "secondary";
}

export function incidentHeadline(summary: string): string {
  return summary.split(/\r?\n/u, 1)[0]?.trim() || "Untitled incident";
}

export function incidentDetail(summary: string): string | null {
  const [, ...rest] = summary.split(/\r?\n/u);
  const detail = rest.join("\n").trim();
  return detail || null;
}

export function formatIncidentTime(value?: string): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Invalid stored time";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function responseRank(incident: PrivacyIncident, now: number): number {
  if (incident.status === "closed") return 5;
  const target = incident.gdpr_72h_deadline
    ? Date.parse(incident.gdpr_72h_deadline)
    : Number.NaN;
  if (Number.isFinite(target) && target < now) return 0;
  if (incident.severity === "critical") return 1;
  if (incident.severity === "high") return 2;
  if (
    incident.affected_regions.length === 0 ||
    incident.affected_data_categories.length === 0 ||
    incident.affected_subject_count === undefined ||
    incident.jurisdictions.length === 0
  ) {
    return 3;
  }
  return 4;
}

export function sortIncidentsForResponse(
  incidents: readonly PrivacyIncident[],
  now = Date.now(),
): PrivacyIncident[] {
  return [...incidents].sort((left, right) => {
    const rank = responseRank(left, now) - responseRank(right, now);
    if (rank !== 0) return rank;
    const time = Date.parse(right.detected_at) - Date.parse(left.detected_at);
    return time !== 0 ? time : right.id.localeCompare(left.id);
  });
}

export function parseIncidentList(value: string): string[] {
  const items = new Map<string, string>();
  for (const raw of value.split(/[,\n]/u)) {
    const normalized = raw.trim().replace(/\s+/gu, " ");
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase();
    if (!items.has(key)) items.set(key, normalized);
  }
  return [...items.values()];
}

export function nowDatetimeLocal(): string {
  const now = new Date();
  const adjusted = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

export function datetimeLocalToISO(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
