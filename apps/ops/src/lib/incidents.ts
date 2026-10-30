// SPDX-License-Identifier: AGPL-3.0-only

import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedMultilineText,
  isBoundedText,
  isCanonicalUUID,
  isRecord,
  isTimestamp,
  MAX_VIEW_ROWS,
  parseTruncatedEnvelope,
} from "./viewSchema";

export type IncidentSeverity = "sev1" | "sev2" | "sev3";
export type IncidentStatus = "open" | "monitoring" | "resolved";

export interface IncidentRow {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  opened_by: string;
  opened_at: string;
  updated_at: string;
  resolved_at?: string;
}

export interface IncidentUpdate {
  id: string;
  body: string;
  author: string;
  requested_status?: IncidentStatus;
  created_at: string;
}

export interface IncidentDetail extends IncidentRow {
  updates: IncidentUpdate[];
  updates_truncated: boolean;
  next_before?: string;
}

export type IncidentsResult =
  | { ok: true; rows: IncidentRow[]; truncated: boolean }
  | { ok: false; message: string };

export type IncidentDetailResult =
  | { ok: true; incident: IncidentDetail }
  | { ok: false; status?: number; message: string };

function parseIncidentRow(value: unknown): IncidentRow | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(
      value,
      ["id", "title", "severity", "status", "opened_by", "opened_at", "updated_at"],
      ["resolved_at"],
    ) ||
    !isCanonicalUUID(value.id) ||
    !isBoundedText(value.title, 256, 1024) ||
    (value.severity !== "sev1" && value.severity !== "sev2" && value.severity !== "sev3") ||
    (value.status !== "open" && value.status !== "monitoring" && value.status !== "resolved") ||
    !isBoundedText(value.opened_by, 320, 320) ||
    !isTimestamp(value.opened_at) ||
    !isTimestamp(value.updated_at) ||
    (value.resolved_at !== undefined && !isTimestamp(value.resolved_at))
  ) return undefined;
  if ((value.status === "resolved") !== (value.resolved_at !== undefined)) return undefined;
  if (Date.parse(value.updated_at) < Date.parse(value.opened_at)) return undefined;
  if (value.resolved_at !== undefined && Date.parse(value.resolved_at) < Date.parse(value.opened_at)) {
    return undefined;
  }
  if (value.resolved_at !== undefined && Date.parse(value.resolved_at) > Date.parse(value.updated_at)) {
    return undefined;
  }
  return {
    id: value.id,
    title: value.title,
    severity: value.severity,
    status: value.status,
    opened_by: value.opened_by,
    opened_at: value.opened_at,
    updated_at: value.updated_at,
    ...(value.resolved_at === undefined ? {} : { resolved_at: value.resolved_at }),
  };
}

function parseIncidentUpdate(value: unknown): IncidentUpdate | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "body", "author", "created_at"], ["requested_status"]) ||
    !isCanonicalUUID(value.id) ||
    !isBoundedMultilineText(value.body, 4096, 16384) ||
    !isBoundedText(value.author, 320, 320) ||
    !isTimestamp(value.created_at) ||
    (value.requested_status !== undefined &&
      value.requested_status !== "open" &&
      value.requested_status !== "monitoring" &&
      value.requested_status !== "resolved")
  ) return undefined;
  return {
    id: value.id,
    body: value.body,
    author: value.author,
    ...(value.requested_status === undefined
      ? {}
      : { requested_status: value.requested_status }),
    created_at: value.created_at,
  };
}

export function parseIncidents(status: number, body: unknown): IncidentsResult {
  if (status !== 200) return { ok: false, message: `incidents returned ${status}` };
  const envelope = parseTruncatedEnvelope(body, "incidents");
  if (!envelope) return { ok: false, message: "incidents returned an unexpected shape" };
  const rows: IncidentRow[] = [];
  for (const candidate of envelope.rows) {
    const row = parseIncidentRow(candidate);
    if (!row) return { ok: false, message: "incidents returned an unexpected shape" };
    rows.push(row);
  }
  if (hasDuplicateKey(rows, (row) => row.id)) {
    return { ok: false, message: "incidents returned an unexpected shape" };
  }
  return { ok: true, rows, truncated: envelope.truncated };
}

export function parseIncidentDetail(status: number, body: unknown): IncidentDetailResult {
  if (status !== 200) {
    return { ok: false, status, message: viewStatusMessage(status, "incident timeline") };
  }
  if (!isRecord(body)) {
    return { ok: false, status, message: "incident timeline returned an unexpected shape" };
  }
  const header: Record<string, unknown> = {};
  for (const key of [
    "id", "title", "severity", "status", "opened_by", "opened_at", "updated_at", "resolved_at",
  ]) {
    if (Object.hasOwn(body, key)) header[key] = body[key];
  }
  if (
    !hasOnlyKeys(
      body,
      ["id", "title", "severity", "status", "opened_by", "opened_at", "updated_at", "updates"],
      ["resolved_at", "updates_truncated", "next_before"],
    ) ||
    !Array.isArray(body.updates) ||
    body.updates.length > MAX_VIEW_ROWS ||
    (body.updates_truncated !== undefined && typeof body.updates_truncated !== "boolean") ||
    (body.next_before !== undefined && !isCanonicalUUID(body.next_before))
  ) return { ok: false, status, message: "incident timeline returned an unexpected shape" };

  const incident = parseIncidentRow(header);
  if (!incident) return { ok: false, status, message: "incident timeline returned an unexpected shape" };
  const updates: IncidentUpdate[] = [];
  let previousTime = -Infinity;
  let previousID = "";
  const openedAt = Date.parse(incident.opened_at);
  const updatedAt = Date.parse(incident.updated_at);
  for (const candidate of body.updates) {
    const update = parseIncidentUpdate(candidate);
    const createdAt = update ? Date.parse(update.created_at) : Number.NaN;
    if (
      !update ||
      createdAt < previousTime ||
      (createdAt === previousTime && update.id <= previousID) ||
      createdAt < openedAt ||
      createdAt > updatedAt
    ) {
      return { ok: false, status, message: "incident timeline returned an unexpected shape" };
    }
    previousTime = createdAt;
    previousID = update.id;
    updates.push(update);
  }
  if (hasDuplicateKey(updates, (update) => update.id)) {
    return { ok: false, status, message: "incident timeline returned an unexpected shape" };
  }
  const truncated = body.updates_truncated ?? false;
  if (
    (truncated && (updates.length === 0 || body.next_before !== updates[0]?.id)) ||
    (!truncated && body.next_before !== undefined)
  ) {
    return { ok: false, status, message: "incident timeline returned an unexpected shape" };
  }
  return {
    ok: true,
    incident: {
      ...incident,
      updates,
      updates_truncated: truncated,
      ...(body.next_before === undefined ? {} : { next_before: body.next_before }),
    },
  };
}

export function severityColor(severity: IncidentSeverity): string {
  if (severity === "sev1") return "var(--red)";
  if (severity === "sev2") return "var(--amber)";
  return "var(--blue)";
}

export function statusColor(status: IncidentStatus): string {
  if (status === "resolved") return "var(--green)";
  if (status === "monitoring") return "var(--amber)";
  return "var(--red)";
}

export async function fetchIncidents(includeResolved: boolean): Promise<IncidentsResult> {
  const query = new URLSearchParams({ limit: String(MAX_VIEW_ROWS) });
  if (includeResolved) query.set("resolved", "1");
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/incidents?${query.toString()}`,
  );
  if (!result.ok) return { ok: false, message: viewStatusMessage(result.status, "incidents") };
  return parseIncidents(result.status, result.body);
}

export async function fetchIncidentTimeline(
  id: string,
  before?: string,
): Promise<IncidentDetailResult> {
  if (!isCanonicalUUID(id)) {
    return { ok: false, status: 400, message: "incident id is invalid" };
  }
  if (before !== undefined && !isCanonicalUUID(before)) {
    return { ok: false, status: 400, message: "incident timeline cursor is invalid" };
  }
  const query = before === undefined
    ? ""
    : `?${new URLSearchParams({ before }).toString()}`;
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/incidents/${encodeURIComponent(id)}${query}`,
  );
  if (!result.ok) {
    return { ok: false, status: result.status, message: viewStatusMessage(result.status, "incident timeline") };
  }
  return parseIncidentDetail(result.status, result.body);
}
