/**
 * lib/consent-evidence-api.ts — the consent event ledger and privacy
 * incidents.
 *
 * Three paths desktop reached and no web file did.
 *
 * EVERY EVENT CARRIES TWO TIMESTAMPS AND THEY ARE NOT THE SAME QUESTION.
 * `created_at` is when the subject gave consent; `recorded_at` is when this
 * ledger learned about it. In this workspace all 12 events were given on
 * 2026-08-01 and recorded on 2026-08-21 — a twenty-day gap. A ledger that
 * shows one date shows the wrong one for whichever question is being asked,
 * and for a record whose purpose is to evidence consent at a point in time,
 * quietly substituting "when we found out" for "when they agreed" is the
 * failure that matters.
 *
 * `policy_version` scopes the consent. Consent granted against
 * privacy-2026-01 is not consent against a later policy, so the version is
 * shown with the event rather than dropped.
 *
 * `source_planes`, `snapshot_at` and `has_more` qualify the WHOLE response:
 * which stores it was drawn from, when it was taken, and whether it is
 * complete. A ledger presented without them reads as the entire record as of
 * now, which is three separate claims none of the data supports on its own.
 *
 * Older pages follow the signed `next_cursor`, and are appended only when they
 * belong to the same page family (see `olderEventPageFailure`).
 */
import { api } from "@/lib/api";
import { ConsentCursorError, isConsentCursor } from "@/lib/consent-receipts-api";

export interface ConsentEvent {
  id: string;
  subject_type: string;
  subject_id: string;
  subject_email: string;
  channel: string;
  category: string;
  action: string;
  source: string;
  policy_version: string;
  proof_text: string;
  /** When consent was given. */
  created_at: string;
  /** When this ledger recorded it. Not the same question. */
  recorded_at: string;
  preferences: Record<string, unknown>;
}

export interface ConsentLedger {
  events: ConsentEvent[];
  count: number;
  /** Which stores this response was drawn from. */
  source_planes: string[];
  /** The response is a point-in-time read, not a live one. */
  snapshot_at: string;
  /** False means this is the whole record, not the first page of it. */
  has_more: boolean;
  schema_version: number;
  /** Workspace the page family is bound to, when the server reports it. */
  workspace_id?: string;
  /** Signed continuation cursor for the next (older) page, when one exists. */
  next_cursor?: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function normalizeConsentLedger(r: Record<string, unknown>): ConsentLedger {
  const workspaceId = str(r?.workspace_id);
  const rawCursor = r?.next_cursor;
  const nextCursor = isConsentCursor(rawCursor) ? rawCursor : "";
  return {
    events: asArray<Record<string, unknown>>(r?.events).map((e) => ({
      id: str(e?.id),
      subject_type: str(e?.subject_type),
      subject_id: str(e?.subject_id),
      subject_email: str(e?.subject_email),
      channel: str(e?.channel),
      category: str(e?.category),
      action: str(e?.action),
      source: str(e?.source),
      policy_version: str(e?.policy_version),
      proof_text: str(e?.proof_text),
      created_at: str(e?.created_at),
      recorded_at: str(e?.recorded_at),
      preferences: obj(e?.preferences),
    })),
    count: num(r?.count),
    source_planes: asArray<string>(r?.source_planes),
    snapshot_at: str(r?.snapshot_at),
    has_more: r?.has_more === true,
    schema_version: num(r?.schema_version),
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

export async function getConsentLedger(): Promise<ConsentLedger> {
  const r = await api.get<Record<string, unknown>>("/api/v1/consent/events");
  return normalizeConsentLedger(r);
}

/** Page size for continuation reads — the server default for page one. */
export const CONSENT_EVENT_PAGE_LIMIT = 200;

/**
 * The older page after `cursor` — GET /api/v1/consent/events?cursor=&limit=.
 * The caller must still run {@link olderEventPageFailure} before appending.
 */
export async function getConsentLedgerPage(
  cursor: string,
  options: { signal?: AbortSignal } = {},
): Promise<ConsentLedger> {
  if (!isConsentCursor(cursor)) throw new ConsentCursorError();
  const params = new URLSearchParams({
    cursor,
    limit: String(CONSENT_EVENT_PAGE_LIMIT),
  });
  const r = await api.get<Record<string, unknown>>(
    `/api/v1/consent/events?${params.toString()}`,
    { signal: options.signal },
  );
  return normalizeConsentLedger(r);
}

export const INCONSISTENT_EVENT_PAGE =
  "The server returned an inconsistent older event page. Loaded correlation evidence was kept; refresh from a new boundary before retrying.";

function eventFractionRemainder(value: string): number {
  const match = /\.(\d{1,9})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return 0;
  return Number(match[1]!.padEnd(9, "0").slice(3));
}

/** Negative when `left` sorts before `right` in newest-first order. */
function compareEventNewest(left: ConsentEvent, right: ConsentEvent): number {
  const ms = Date.parse(right.recorded_at) - Date.parse(left.recorded_at);
  if (Number.isFinite(ms) && ms !== 0) return ms;
  const fraction =
    eventFractionRemainder(right.recorded_at) -
    eventFractionRemainder(left.recorded_at);
  if (fraction !== 0) return fraction;
  return right.id.localeCompare(left.id);
}

/**
 * Why an older event page must NOT be appended to the loaded family, or null
 * when it may be: the same boundary, workspace, a fresh cursor, no repeated
 * event id, and newest-first order across the seam (desktop Consent.tsx:907).
 */
export function olderEventPageFailure(
  base: Pick<ConsentLedger, "snapshot_at" | "workspace_id">,
  loaded: readonly ConsentEvent[],
  page: ConsentLedger,
  requestedCursor: string,
): string | null {
  if (
    page.snapshot_at !== base.snapshot_at ||
    page.workspace_id !== base.workspace_id ||
    (page.events.length === 0 && page.has_more) ||
    page.next_cursor === requestedCursor
  ) {
    return INCONSISTENT_EVENT_PAGE;
  }
  if (page.events.length === 0) return null;
  const ids = new Set(loaded.map((event) => event.id));
  for (const event of page.events) {
    if (!event.id || ids.has(event.id)) return INCONSISTENT_EVENT_PAGE;
    ids.add(event.id);
  }
  const seam = [...loaded.slice(-1), ...page.events];
  for (let index = 1; index < seam.length; index += 1) {
    if (compareEventNewest(seam[index - 1]!, seam[index]!) >= 0) {
      return INCONSISTENT_EVENT_PAGE;
    }
  }
  return null;
}

export interface PrivacyIncidents {
  incidents: unknown[];
  known_jurisdictions: { code: string; name: string }[];
}

export async function getPrivacyIncidents(): Promise<PrivacyIncidents> {
  const r = await api.get<Record<string, unknown>>("/api/v1/privacy/incidents");
  return {
    incidents: asArray(r?.incidents),
    known_jurisdictions: asArray<Record<string, unknown>>(
      r?.known_jurisdictions,
    ).map((j) => ({ code: str(j?.code), name: str(j?.name) })),
  };
}

export interface PushSuppressionRegistryRow {
  id: string;
  tenantId: string;
  fingerprint: string;
  platform: "apns" | "fcm" | "web";
  reason: "manual" | "unregistered" | "expired" | "complaint" | "user_opt_out";
  source: "dashboard" | "provider" | "user" | "complaint" | "legacy";
  createdAt: string;
  updatedAt: string;
  version: number;
  reversible: boolean;
  lockedReason?: PushSuppressionRegistryLockedReason;
}

export type PushSuppressionRegistryLockedReason =
  | "provider_authority"
  | "user_opt_out_authority"
  | "complaint_authority"
  | "legacy_authority_requires_review";

export interface PushSuppressionRegistryPage {
  tenantId: string;
  items: PushSuppressionRegistryRow[];
  total: number;
  snapshotAt: string;
  nextCursor?: string;
}

export class PushSuppressionRegistryContractError extends Error {
  constructor() {
    super("The customer push registry returned an unverifiable response.");
    this.name = "PushSuppressionRegistryContractError";
  }
}

const PUSH_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PUSH_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUSH_FINGERPRINT = /^[0-9a-f]{16}$/u;
const PUSH_CURSOR = /^[A-Za-z0-9_-]{1,2048}$/u;
const PUSH_PLATFORMS = ["apns", "fcm", "web"] as const;
const PUSH_REASONS = [
  "manual",
  "unregistered",
  "expired",
  "complaint",
  "user_opt_out",
] as const;
const PUSH_SOURCES = [
  "dashboard",
  "provider",
  "user",
  "complaint",
  "legacy",
] as const;
const PUSH_LOCKS = new Set<PushSuppressionRegistryLockedReason>([
  "provider_authority",
  "user_opt_out_authority",
  "complaint_authority",
  "legacy_authority_requires_review",
]);

function pushRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushOnly(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function pushText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return "";
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  return value;
}

function pushTime(value: unknown): string {
  const raw = pushText(value, 64);
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      raw,
    );
  const parsed = Date.parse(raw);
  if (
    !parts ||
    !Number.isFinite(parsed) ||
    parsed < Date.UTC(2000, 0, 1) ||
    parsed >= Date.UTC(2100, 0, 1)
  )
    return "";
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59 ||
    Number(parts[8] ?? 0) > 14 ||
    (Number(parts[8] ?? 0) === 14 && Number(parts[9] ?? 0) !== 0) ||
    Number(parts[9] ?? 0) > 59
  )
    return "";
  return raw;
}

function decodePushRow(
  value: unknown,
  expectedTenantId: string,
): PushSuppressionRegistryRow | null {
  if (
    !pushRecord(value) ||
    !pushOnly(value, [
      "id",
      "tenant_id",
      "device_token_hash",
      "platform",
      "reason",
      "source",
      "created_at",
      "updated_at",
      "version",
      "reversible",
      "locked_reason",
    ])
  )
    return null;
  const id = pushText(value.id, 36);
  const tenantId = pushText(value.tenant_id, 36);
  const fingerprint = pushText(value.device_token_hash, 16);
  const platform = pushText(value.platform, 16);
  const reason = pushText(value.reason, 32);
  const source = pushText(value.source, 64);
  const createdAt = pushTime(value.created_at);
  const updatedAt = pushTime(value.updated_at);
  const lockedReasonPresent = Object.prototype.hasOwnProperty.call(
    value,
    "locked_reason",
  );
  const lockedReason = lockedReasonPresent
    ? pushText(value.locked_reason, 64)
    : "";
  const reversible = value.reversible;
  if (
    !PUSH_UUID_V4.test(id) ||
    tenantId !== expectedTenantId ||
    !PUSH_FINGERPRINT.test(fingerprint) ||
    !PUSH_PLATFORMS.includes(platform as (typeof PUSH_PLATFORMS)[number]) ||
    !PUSH_REASONS.includes(reason as (typeof PUSH_REASONS)[number]) ||
    !PUSH_SOURCES.includes(source as (typeof PUSH_SOURCES)[number]) ||
    !createdAt ||
    !updatedAt ||
    Date.parse(createdAt) > Date.parse(updatedAt) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof reversible !== "boolean" ||
    reversible !== (reason === "manual" && source === "dashboard") ||
    (reversible && lockedReasonPresent) ||
    (!reversible &&
      (!lockedReasonPresent ||
        !PUSH_LOCKS.has(lockedReason as PushSuppressionRegistryLockedReason)))
  )
    return null;
  const projectedAuthority =
    (source === "dashboard" && reason === "manual" && lockedReason === "") ||
    (source === "provider" &&
      (reason === "unregistered" || reason === "expired") &&
      lockedReason === "provider_authority") ||
    (source === "user" &&
      reason === "user_opt_out" &&
      lockedReason === "user_opt_out_authority") ||
    (source === "complaint" &&
      reason === "complaint" &&
      lockedReason === "complaint_authority") ||
    (source === "legacy" &&
      lockedReason === "legacy_authority_requires_review");
  if (!projectedAuthority) return null;
  return {
    id,
    tenantId,
    fingerprint,
    platform: platform as PushSuppressionRegistryRow["platform"],
    reason: reason as PushSuppressionRegistryRow["reason"],
    source: source as PushSuppressionRegistryRow["source"],
    createdAt,
    updatedAt,
    version: Number(value.version),
    reversible,
    ...(lockedReason
      ? { lockedReason: lockedReason as PushSuppressionRegistryLockedReason }
      : {}),
  };
}

/** Strict row decoder shared by the read and write Route 43 boundaries. */
export function decodePushSuppressionRegistryRow(
  value: unknown,
  expectedTenantId: string,
): PushSuppressionRegistryRow {
  if (!PUSH_UUID.test(expectedTenantId)) {
    throw new PushSuppressionRegistryContractError();
  }
  const row = decodePushRow(value, expectedTenantId);
  if (!row) throw new PushSuppressionRegistryContractError();
  return row;
}

export function decodePushSuppressions(
  value: unknown,
  expectedTenantId: string,
): PushSuppressionRegistryPage {
  if (
    !PUSH_UUID.test(expectedTenantId) ||
    !pushRecord(value) ||
    !pushOnly(value, [
      "tenantId",
      "items",
      "total",
      "nextCursor",
      "snapshotAt",
    ]) ||
    value.tenantId !== expectedTenantId ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < value.items.length
  )
    throw new PushSuppressionRegistryContractError();
  const snapshotAt = pushTime(value.snapshotAt);
  const nextCursor =
    value.nextCursor === undefined ? "" : pushText(value.nextCursor, 2048);
  if (
    !snapshotAt ||
    (value.nextCursor !== undefined && !PUSH_CURSOR.test(nextCursor))
  ) {
    throw new PushSuppressionRegistryContractError();
  }
  const items: PushSuppressionRegistryRow[] = [];
  const ids = new Set<string>();
  let previousAt = Number.POSITIVE_INFINITY;
  let previousId = "";
  for (const raw of value.items) {
    const row = decodePushRow(raw, expectedTenantId);
    const at = row ? Date.parse(row.createdAt) : Number.NaN;
    if (
      !row ||
      ids.has(row.id) ||
      at > previousAt ||
      (at === previousAt && previousId !== "" && row.id >= previousId)
    ) {
      throw new PushSuppressionRegistryContractError();
    }
    ids.add(row.id);
    previousAt = at;
    previousId = row.id;
    items.push(row);
  }
  if (
    (nextCursor &&
      (items.length !== 100 || Number(value.total) <= items.length)) ||
    (!nextCursor && items.length !== Number(value.total))
  )
    throw new PushSuppressionRegistryContractError();
  return {
    tenantId: expectedTenantId,
    items,
    total: Number(value.total),
    snapshotAt,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export async function getPushSuppressions(
  expectedTenantId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PushSuppressionRegistryPage> {
  if (!PUSH_UUID.test(expectedTenantId))
    throw new PushSuppressionRegistryContractError();
  const response = await api.get<unknown>(
    "/api/v1/push/suppressions?limit=100",
    {
      signal: options.signal,
    },
  );
  return decodePushSuppressions(response, expectedTenantId);
}

/**
 * Whole days between consent being given and this ledger recording it.
 *
 * Returns null when either timestamp is missing or unparseable — an unknown
 * gap must not render as zero, which would assert the two moments coincided.
 */
export function recordingLagDays(e: ConsentEvent): number | null {
  const given = Date.parse(e.created_at);
  const recorded = Date.parse(e.recorded_at);
  if (!Number.isFinite(given) || !Number.isFinite(recorded)) return null;
  return Math.floor((recorded - given) / 86_400_000);
}
