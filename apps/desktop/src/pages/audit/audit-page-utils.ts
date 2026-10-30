import type {
  ActionCategory,
  ActorType,
  DayRange,
} from "../../components/audit/AuditFilters";
import {
  assessRisk,
  commonIpPrefix,
} from "../../components/audit/AuditRiskScore";
import {
  decodeAuditListPayload,
  decodeAuditSavedViewFilters,
  decodeAuditSsePayload,
  type AuditRow,
} from "../../lib/api/audit-operations";
import { registerPrivateSessionReset } from "../../lib/private-session-state";
import type {
  AuditExcludeFacet,
  AuditFilterArgs,
  AuditTimeFacet,
  AuditViewMode,
  PersistedAuditFilters,
} from "./audit-page-types";

export const AUDIT_AUTO_REFRESH_MS = 15_000;
export const AUDIT_FILTER_PERSIST_KEY = "postwave.audit.filters.v1";
export const AUDIT_VIEW_MODE_PERSIST_KEY = "postwave.audit.view_mode.v1";
export const AUDIT_EXPORT_MANIFEST_PERSIST_KEY = "audit.exportIncludeManifest";
export const AUDIT_DOW_LABELS = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
];
const AUDIT_STORAGE_SCOPE_RE = /^[a-f0-9]{16}$/u;
const AUDIT_FILTER_RECORD_VERSION = 2;
const MAX_AUDIT_FILTER_RECORD_CHARS = 4 * 1024;
const AUDIT_FILTER_DURABLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUDIT_FILTER_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUDIT_FILTER_SESSION_SCOPE_MAX = 8;
const AUDIT_FILTER_FUTURE_SKEW_MS = 5 * 60 * 1000;
const AUDIT_FILTER_CONTROL_RE = /[\u0000-\u001f\u007f]/u;

interface DurableAuditFilterRecord {
  version: typeof AUDIT_FILTER_RECORD_VERSION;
  savedAt: number;
  filters: PersistedAuditFilters;
}

interface SessionAuditFilterRecord {
  touchedAt: number;
  filters: PersistedAuditFilters;
}

const sessionAuditFilters = new Map<string, SessionAuditFilterRecord>();

function scopedAuditStorageKey(
  base: string,
  scope: string | null,
): string | null {
  return scope && AUDIT_STORAGE_SCOPE_RE.test(scope)
    ? `${base}:${scope}`
    : null;
}

function removeLegacyAuditStorage(): void {
  for (const key of [
    AUDIT_FILTER_PERSIST_KEY,
    AUDIT_VIEW_MODE_PERSIST_KEY,
    AUDIT_EXPORT_MANIFEST_PERSIST_KEY,
  ]) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      return;
    }
  }
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    value.length <= max &&
    !AUDIT_FILTER_CONTROL_RE.test(value)
    ? value
    : undefined;
}

function sanitizePersistedAuditFilters(
  candidate: unknown,
): PersistedAuditFilters {
  if (!candidate || typeof candidate !== "object") return {};
  const value = candidate as Record<string, unknown>;
  // v1 of the renderer persisted the friendly-but-noncanonical value `user`.
  // Migrate it in memory so an existing preference cannot keep issuing a
  // server query that matches no canonical `human` rows.
  const actorType =
    value.actorType === "user"
      ? "human"
      : isAuditActorType(value.actorType)
        ? value.actorType
        : undefined;
  const days =
    value.days === 0 ||
    value.days === 7 ||
    value.days === 30 ||
    value.days === 90
      ? value.days
      : undefined;
  const category = [
    "all",
    "destructive",
    "auth",
    "export",
    "one_click",
    "meta_audit",
  ].includes(String(value.category))
    ? (value.category as ActionCategory)
    : undefined;
  const actorLabel = boundedOptionalText(value.actorLabel, 256);
  const actionQuery = boundedOptionalText(value.actionQuery, 256);
  const resourceType = boundedOptionalText(value.resourceType, 64);
  const resourceId = boundedOptionalText(value.resourceId, 256);
  return {
    ...(actorType ? { actorType } : {}),
    ...(actorLabel !== undefined ? { actorLabel } : {}),
    ...(actionQuery !== undefined ? { actionQuery } : {}),
    ...(resourceType !== undefined ? { resourceType } : {}),
    ...(resourceId !== undefined ? { resourceId } : {}),
    ...(days !== undefined ? { days } : {}),
    ...(category ? { category } : {}),
  };
}

function safeDurableAuditFilters(
  candidate: PersistedAuditFilters,
): PersistedAuditFilters {
  return {
    ...(candidate.actorType ? { actorType: candidate.actorType } : {}),
    ...(candidate.days !== undefined ? { days: candidate.days } : {}),
    ...(candidate.category ? { category: candidate.category } : {}),
  };
}

function auditFilterTimestampIsCurrent(
  at: number,
  ttl: number,
  now: number,
): boolean {
  return (
    Number.isFinite(at) &&
    at <= now + AUDIT_FILTER_FUTURE_SKEW_MS &&
    at >= now - ttl
  );
}

function removeAuditFilterKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Process-memory state remains available for the current operator.
  }
}

function pruneSessionAuditFilters(now: number): void {
  for (const [scope, record] of sessionAuditFilters) {
    if (
      !auditFilterTimestampIsCurrent(
        record.touchedAt,
        AUDIT_FILTER_SESSION_TTL_MS,
        now,
      )
    ) {
      sessionAuditFilters.delete(scope);
    }
  }
  if (sessionAuditFilters.size <= AUDIT_FILTER_SESSION_SCOPE_MAX) return;
  const oldest = [...sessionAuditFilters.entries()].sort(
    ([, left], [, right]) => left.touchedAt - right.touchedAt,
  );
  for (const [scope] of oldest.slice(
    0,
    sessionAuditFilters.size - AUDIT_FILTER_SESSION_SCOPE_MAX,
  )) {
    sessionAuditFilters.delete(scope);
  }
}

function readDurableAuditFilters(
  key: string,
  now: number,
): PersistedAuditFilters {
  const raw = window.localStorage.getItem(key);
  if (!raw) return {};
  if (raw.length > MAX_AUDIT_FILTER_RECORD_CHARS) {
    window.localStorage.removeItem(key);
    return {};
  }
  const decoded = JSON.parse(raw) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    window.localStorage.removeItem(key);
    return {};
  }
  const record = decoded as Partial<DurableAuditFilterRecord>;
  if (
    record.version !== AUDIT_FILTER_RECORD_VERSION ||
    !auditFilterTimestampIsCurrent(
      record.savedAt ?? Number.NaN,
      AUDIT_FILTER_DURABLE_TTL_MS,
      now,
    ) ||
    !record.filters ||
    typeof record.filters !== "object" ||
    Array.isArray(record.filters)
  ) {
    // Pre-v2 records may contain actor labels, action searches, resource
    // types, and raw IDs. Purge without adopting even their safe-looking bits.
    window.localStorage.removeItem(key);
    return {};
  }
  const safe = safeDurableAuditFilters(
    sanitizePersistedAuditFilters(record.filters),
  );
  const canonical: DurableAuditFilterRecord = {
    version: AUDIT_FILTER_RECORD_VERSION,
    savedAt: record.savedAt!,
    filters: safe,
  };
  if (JSON.stringify(canonical) !== raw) {
    window.localStorage.setItem(key, JSON.stringify(canonical));
  }
  return safe;
}

export function readPersistedAuditFilters(
  scope: string | null,
): PersistedAuditFilters {
  try {
    removeLegacyAuditStorage();
    const key = scopedAuditStorageKey(AUDIT_FILTER_PERSIST_KEY, scope);
    if (!key) return {};
    const now = Date.now();
    pruneSessionAuditFilters(now);
    const durable = readDurableAuditFilters(key, now);
    const session = sessionAuditFilters.get(scope!);
    if (!session) return durable;
    session.touchedAt = now;
    return { ...durable, ...session.filters };
  } catch {
    const key = scopedAuditStorageKey(AUDIT_FILTER_PERSIST_KEY, scope);
    if (key) removeAuditFilterKey(key);
    return {};
  }
}

export function writePersistedAuditFilters(
  filters: PersistedAuditFilters,
  scope: string | null,
): void {
  const key = scopedAuditStorageKey(AUDIT_FILTER_PERSIST_KEY, scope);
  if (!key) return;
  const now = Date.now();
  const sanitized = sanitizePersistedAuditFilters(filters);
  sessionAuditFilters.set(scope!, { filters: sanitized, touchedAt: now });
  pruneSessionAuditFilters(now);
  try {
    const record: DurableAuditFilterRecord = {
      version: AUDIT_FILTER_RECORD_VERSION,
      savedAt: now,
      filters: safeDurableAuditFilters(sanitized),
    };
    window.localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Low-risk preferences are best-effort; private filters remain in memory.
  }
}

export function clearAuditFilterSessionState(): void {
  sessionAuditFilters.clear();
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key &&
        (key === AUDIT_FILTER_PERSIST_KEY ||
          key.startsWith(`${AUDIT_FILTER_PERSIST_KEY}:`))
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) window.localStorage.removeItem(key);
    window.localStorage.removeItem(AUDIT_FILTER_PERSIST_KEY);
  } catch {
    // Process-memory customer data was still erased above.
  }
}

export function readAuditViewMode(scope: string | null): AuditViewMode {
  try {
    removeLegacyAuditStorage();
    const key = scopedAuditStorageKey(AUDIT_VIEW_MODE_PERSIST_KEY, scope);
    const raw = key ? window.localStorage.getItem(key) : null;
    if (
      raw === "list" ||
      raw === "timeline" ||
      raw === "heatmap" ||
      raw === "calendar"
    ) {
      return raw;
    }
  } catch {
    // Private mode falls back to the list.
  }
  return "list";
}

export function writeAuditViewMode(
  mode: AuditViewMode,
  scope: string | null,
): void {
  const key = scopedAuditStorageKey(AUDIT_VIEW_MODE_PERSIST_KEY, scope);
  if (!key) return;
  try {
    window.localStorage.setItem(key, mode);
  } catch {
    // Private mode is best-effort only.
  }
}

export function readIncludeManifest(scope: string | null): boolean {
  try {
    removeLegacyAuditStorage();
    const key = scopedAuditStorageKey(AUDIT_EXPORT_MANIFEST_PERSIST_KEY, scope);
    return key ? localStorage.getItem(key) === "1" : false;
  } catch {
    return false;
  }
}

export function writeIncludeManifest(
  includeManifest: boolean,
  scope: string | null,
): void {
  const key = scopedAuditStorageKey(AUDIT_EXPORT_MANIFEST_PERSIST_KEY, scope);
  if (!key) return;
  try {
    localStorage.setItem(key, includeManifest ? "1" : "0");
  } catch {
    // localStorage may be disabled.
  }
}

export function sinceISO(days: DayRange, now = Date.now()): string | undefined {
  if (!days) return undefined;
  const date = new Date(now - days * 86_400 * 1000);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function categoryToActionParam(
  category: ActionCategory,
): string | undefined {
  switch (category) {
    case "destructive":
      return "delete";
    case "auth":
      return "login";
    case "export":
      return "export";
    case "one_click":
      return "one_click";
    case "meta_audit":
      return "audit.read";
    default:
      return undefined;
  }
}

export function createAuditFilterArgs(filters: {
  actorType: ActorType;
  actorLabel: string;
  actionQuery: string;
  resourceType: string;
  resourceId: string;
  days: DayRange;
  category: ActionCategory;
}): AuditFilterArgs {
  const explicitAction = filters.actionQuery.trim();
  return {
    actorType: filters.actorType === "any" ? undefined : filters.actorType,
    actorLabel: filters.actorLabel.trim() || undefined,
    action: explicitAction || categoryToActionParam(filters.category),
    resourceType: filters.resourceType || undefined,
    resourceId: filters.resourceId.trim() || undefined,
    since: sinceISO(filters.days),
  };
}

export function auditRowMatchesFilters(
  row: AuditRow,
  args: AuditFilterArgs,
): boolean {
  const action = (args.action ?? "").trim();
  const rowAction = (row.action ?? "").toLowerCase();
  if (action) {
    if (!rowAction.includes(action.toLowerCase())) return false;
  } else if (rowAction.startsWith("audit.read.")) {
    return false;
  }
  if (args.actorType && row.actorType !== args.actorType) return false;
  if (args.actorLabel && (row.actorLabel ?? "") !== args.actorLabel) {
    return false;
  }
  if (args.resourceType && (row.resourceType ?? "") !== args.resourceType) {
    return false;
  }
  const resourceId = (args.resourceId ?? "").trim();
  if (
    resourceId &&
    !(row.resourceId ?? "").toLowerCase().includes(resourceId.toLowerCase())
  ) {
    return false;
  }
  if (args.since) {
    const since = Date.parse(args.since);
    const at = Date.parse(row.at ?? "");
    if (!Number.isNaN(since) && (Number.isNaN(at) || at < since)) return false;
  }
  return true;
}

export function pickAuditRows(payload: unknown): {
  rows: AuditRow[];
  nextCursor: string | undefined;
} {
  const decoded = decodeAuditListPayload(payload);
  if (!decoded) return { rows: [], nextCursor: undefined };
  return {
    rows: decoded.rows,
    nextCursor: decoded.nextCursor,
  };
}

/** Pure boundary helpers consumed by saved-view and EventSource controllers. */
export { decodeAuditSavedViewFilters, decodeAuditSsePayload };

export function formatAuditRefreshAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function filterAuditRows(
  rows: AuditRow[] | null,
  excludeFacets: AuditExcludeFacet[],
  timeFacet: AuditTimeFacet | null,
): AuditRow[] | null {
  if (!rows || (excludeFacets.length === 0 && !timeFacet)) return rows;
  return rows.filter((row) => {
    if (
      excludeFacets.some(
        (facet) =>
          (facet.field === "actor" && row.actorLabel === facet.value) ||
          (facet.field === "resource" && row.resourceId === facet.value) ||
          (facet.field === "ip" && row.ip === facet.value),
      )
    ) {
      return false;
    }
    if (!timeFacet) return true;
    const date = new Date(row.at);
    if (Number.isNaN(date.getTime())) return false;
    if (timeFacet.kind === "day") {
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
      return key === timeFacet.dateIso;
    }
    return (
      date.getUTCDay() === timeFacet.dow &&
      date.getUTCHours() === timeFacet.hour
    );
  });
}

export function mergeUniqueAuditRows(
  incoming: AuditRow[],
  existing: AuditRow[] | null,
): { rows: AuditRow[]; added: number } {
  const base = existing ?? [];
  const seen = new Set(base.map((row) => String(row.id)));
  const fresh = incoming.filter((row) => !seen.has(String(row.id)));
  return { rows: [...fresh, ...base], added: fresh.length };
}

export function buildAuditRiskMap(
  rows: AuditRow[] | null,
): Map<string, ReturnType<typeof assessRisk>> {
  const result = new Map<string, ReturnType<typeof assessRisk>>();
  if (!rows) return result;
  const baseline = commonIpPrefix(rows);
  for (const row of rows) {
    result.set(String(row.id), assessRisk(row, { commonIpPrefix16: baseline }));
  }
  return result;
}

export function isAuditActorType(value: unknown): value is ActorType {
  return (
    value === "human" ||
    value === "agent" ||
    value === "system" ||
    value === "platform_operator"
  );
}

registerPrivateSessionReset("audit-filters", () => {
  clearAuditFilterSessionState();
});
