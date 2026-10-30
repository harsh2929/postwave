/**
 * Strict, privacy-minimized read contracts for the approvals route.
 *
 * API response types describe the intended wire shape, but they cannot make
 * unknown JSON trustworthy at runtime. These decoders build a bounded local
 * projection and deliberately omit tenant IDs, API-key IDs, content hashes,
 * metadata, and every unrecognised field.
 */

export const APPROVAL_LIST_CAP = 200;

const APPROVAL_ENVELOPE_KEY_CAP = 12;
const APPROVAL_RECORD_KEY_CAP = 32;
const MAX_ID_CHARACTERS = 128;
const MAX_RESOURCE_TYPE_CHARACTERS = 64;
const MAX_STATUS_CHARACTERS = 32;
const MAX_ACTOR_TYPE_CHARACTERS = 64;
const MAX_ACTOR_LABEL_CHARACTERS = 160;
const MAX_NOTES_CHARACTERS = 2_000;
const MAX_TIMESTAMP_CHARACTERS = 64;

const LIST_KEYS = ["approvals", "items", "data", "results"] as const;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

type UnknownRecord = Record<string, unknown>;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "unverified";

export type ApprovalResourceType =
  | "campaign"
  | "sequence"
  | "automation_send"
  | "unverified";

export type ApprovalActorType =
  | "user"
  | "api_key"
  | "agent"
  | "service"
  | "system"
  | "slack"
  | "partner_app"
  | "app"
  | "stream"
  | "unverified";

export interface DecodedApproval {
  id: string;
  resourceType: ApprovalResourceType;
  resourceId: string;
  resourceLabel: string;
  status: ApprovalStatus;
  statusLabel: string;
  /** Only a verified pending row for a recognised resource can be decided. */
  actionable: boolean;
  requestedAt: string;
  requestedByActorType?: ApprovalActorType;
  requestedByActorLabel?: string;
  decidedAt?: string;
  notes?: string;
  expiresAt?: string;
}

export interface DecodedApprovalList {
  /** The only canonical list key exposed beyond this boundary. */
  approvals: DecodedApproval[];
}

export type ApprovalContractFailureReason =
  | "invalid-envelope"
  | "missing-list"
  | "too-many-records"
  | "invalid-record"
  | "duplicate-identity"
  | "conflicting-list-keys";

export type ApprovalContractResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: ApprovalContractFailureReason;
      recordIndex?: number;
    };

const INVALID_OPTIONAL = Symbol("invalid-optional-approval-field");

interface DecodedApprovalProjection {
  approval: DecodedApproval;
  /** Bounded source truth used only to compare duplicated envelope keys. */
  integrityKey: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAtMostOwnKeys(value: UnknownRecord, maximum: number): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function ownValue(value: UnknownRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function failure<T>(
  reason: ApprovalContractFailureReason,
  recordIndex?: number,
): ApprovalContractResult<T> {
  return recordIndex === undefined
    ? { ok: false, reason }
    : { ok: false, reason, recordIndex };
}

function boundedIdentifier(value: unknown, maximum: number): string | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > maximum ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

export function approvalIsoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_CHARACTERS) {
    return null;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function optionalInstant(
  value: unknown,
): string | undefined | typeof INVALID_OPTIONAL {
  if (value === undefined || value === null) return undefined;
  return approvalIsoInstant(value) ?? INVALID_OPTIONAL;
}

function optionalDisplayText(
  value: unknown,
  maximum: number,
): string | undefined | typeof INVALID_OPTIONAL {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > maximum * 2 ||
    Array.from(value).length > maximum ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    return INVALID_OPTIONAL;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function normalizedStatus(status: string): ApprovalStatus {
  switch (status) {
    case "pending":
    case "approved":
    case "rejected":
    case "expired":
      return status;
    default:
      return "unverified";
  }
}

function normalizedResourceType(resourceType: string): ApprovalResourceType {
  switch (resourceType) {
    case "campaign":
    case "sequence":
    case "automation_send":
      return resourceType;
    default:
      return "unverified";
  }
}

function normalizedActorType(actorType: string): ApprovalActorType {
  switch (actorType) {
    case "user":
    case "api_key":
    case "agent":
    case "service":
    case "system":
    case "slack":
    case "partner_app":
    case "app":
    case "stream":
      return actorType;
    default:
      return "unverified";
  }
}

export function approvalStatusLabel(status: unknown): string {
  switch (status) {
    case "pending":
      return "Pending review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    default:
      return "Status unverified";
  }
}

export function approvalResourceLabel(resourceType: unknown): string {
  switch (resourceType) {
    case "campaign":
      return "Campaign";
    case "sequence":
      return "Sequence";
    case "automation_send":
      return "Automation send";
    default:
      return "Resource";
  }
}

export function canRejectApproval(
  row: Pick<DecodedApproval, "actionable" | "expiresAt">,
  now = Date.now(),
): boolean {
  if (!row.actionable || !row.expiresAt) return false;
  const expiresAt = Date.parse(row.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function decodeApprovalProjection(
  value: unknown,
): ApprovalContractResult<DecodedApprovalProjection> {
  if (!isRecord(value) || !hasAtMostOwnKeys(value, APPROVAL_RECORD_KEY_CAP)) {
    return failure("invalid-record");
  }
  const id = boundedIdentifier(ownValue(value, "id"), MAX_ID_CHARACTERS);
  const sourceResourceType = boundedIdentifier(
    ownValue(value, "resourceType"),
    MAX_RESOURCE_TYPE_CHARACTERS,
  );
  const resourceId = boundedIdentifier(
    ownValue(value, "resourceId"),
    MAX_ID_CHARACTERS,
  );
  const sourceStatus = boundedIdentifier(
    ownValue(value, "status"),
    MAX_STATUS_CHARACTERS,
  );
  const requestedAt = approvalIsoInstant(ownValue(value, "requestedAt"));
  if (
    !id ||
    !sourceResourceType ||
    !resourceId ||
    !sourceStatus ||
    !requestedAt
  ) {
    return failure("invalid-record");
  }
  const resourceType = normalizedResourceType(sourceResourceType);
  const status = normalizedStatus(sourceStatus);

  const sourceActorType = ownValue(value, "requestedByActorType");
  const requestedByActorType =
    sourceActorType === undefined || sourceActorType === null
      ? undefined
      : typeof sourceActorType === "string" &&
          sourceActorType.length <= MAX_ACTOR_TYPE_CHARACTERS &&
          IDENTIFIER_PATTERN.test(sourceActorType)
        ? normalizedActorType(sourceActorType)
        : INVALID_OPTIONAL;

  const requestedByActorLabel = optionalDisplayText(
    ownValue(value, "requestedByActorLabel"),
    MAX_ACTOR_LABEL_CHARACTERS,
  );
  const notes = optionalDisplayText(
    ownValue(value, "notes"),
    MAX_NOTES_CHARACTERS,
  );
  const decidedAt = optionalInstant(ownValue(value, "decidedAt"));
  const expiresAt = optionalInstant(ownValue(value, "expiresAt"));
  if (
    requestedByActorType === INVALID_OPTIONAL ||
    requestedByActorLabel === INVALID_OPTIONAL ||
    notes === INVALID_OPTIONAL ||
    decidedAt === INVALID_OPTIONAL ||
    expiresAt === INVALID_OPTIONAL
  ) {
    return failure("invalid-record");
  }

  return {
    ok: true,
    data: {
      approval: {
        id,
        resourceType,
        resourceId,
        resourceLabel: approvalResourceLabel(resourceType),
        status,
        statusLabel: approvalStatusLabel(status),
        actionable: status === "pending" && resourceType !== "unverified",
        requestedAt,
        ...(requestedByActorType ? { requestedByActorType } : {}),
        ...(requestedByActorLabel ? { requestedByActorLabel } : {}),
        ...(decidedAt ? { decidedAt } : {}),
        ...(notes ? { notes } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      },
      integrityKey: JSON.stringify({
        id,
        sourceResourceType,
        resourceId,
        sourceStatus,
        requestedAt,
        sourceActorType,
        requestedByActorLabel,
        decidedAt,
        notes,
        expiresAt,
      }),
    },
  };
}

function decodeApprovalArray(
  value: unknown,
): ApprovalContractResult<DecodedApprovalProjection[]> {
  if (!Array.isArray(value)) return failure("invalid-envelope");
  if (value.length > APPROVAL_LIST_CAP) return failure("too-many-records");
  const approvals: DecodedApprovalProjection[] = [];
  const identities = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const decoded = decodeApprovalProjection(value[index]);
    if (!decoded.ok) return failure("invalid-record", index);
    if (identities.has(decoded.data.approval.id)) {
      return failure("duplicate-identity", index);
    }
    identities.add(decoded.data.approval.id);
    approvals.push(decoded.data);
  }
  return { ok: true, data: approvals };
}

function sameApprovalLists(
  left: readonly DecodedApprovalProjection[],
  right: readonly DecodedApprovalProjection[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (approval, index) => approval.integrityKey === right[index]?.integrityKey,
  );
}

export function decodeApprovalList(
  value: unknown,
): ApprovalContractResult<DecodedApprovalList> {
  if (!isRecord(value) || !hasAtMostOwnKeys(value, APPROVAL_ENVELOPE_KEY_CAP)) {
    return failure("invalid-envelope");
  }
  const presentKeys = LIST_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (presentKeys.length === 0) return failure("missing-list");

  let canonical: DecodedApprovalProjection[] | null = null;
  for (const key of presentKeys) {
    const decoded = decodeApprovalArray(value[key]);
    if (!decoded.ok) return decoded;
    if (canonical && !sameApprovalLists(canonical, decoded.data)) {
      return failure("conflicting-list-keys");
    }
    canonical ??= decoded.data;
  }
  return {
    ok: true,
    data: { approvals: (canonical ?? []).map(({ approval }) => approval) },
  };
}

export function decodeApprovalDetail(
  value: unknown,
): ApprovalContractResult<DecodedApproval> {
  const decoded = decodeApprovalProjection(value);
  return decoded.ok ? { ok: true, data: decoded.data.approval } : decoded;
}
