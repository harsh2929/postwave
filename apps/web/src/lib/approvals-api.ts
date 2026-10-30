// SPDX-License-Identifier: AGPL-3.0-only
//
// Typed client for the approvals inbox. Backend:
// apps/api/internal/approvals/handlers.go (admin-gated). The web UI lets a
// reviewer read the queue and record the release-qualified decision lane.
// Dormant approve/delegation/escalation methods remain transport-hardened but
// must not be treated as UI release evidence.

import { api } from "@/lib/api";

export interface ApprovalReadOptions {
  signal?: AbortSignal;
  /** Reject a well-formed response if it belongs to another workspace. */
  expectedTenantId?: string;
}

export interface ApprovalMutationOptions extends ApprovalReadOptions {
  idempotencyKey: string;
}

const protectedReadOptions = ({ signal }: ApprovalReadOptions = {}) => ({
  cache: "no-store" as const,
  maxAttempts: 1,
  requireOnline: true,
  signal,
});

function protectedMutationOptions({
  idempotencyKey,
  signal,
}: ApprovalMutationOptions) {
  const stableIdempotencyKey = idempotencyKey.trim();
  if (!stableIdempotencyKey) {
    throw new Error("An idempotency key is required for approval mutations.");
  }
  return {
    idempotencyKey: stableIdempotencyKey,
    maxAttempts: 1,
    requireOnline: true,
    signal,
  } as const;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "unverified";

export type ApprovalResourceType =
  | "campaign"
  | "sequence"
  | "automation_send"
  | "unverified";

export interface Approval {
  id: string;
  tenantId: string;
  resourceType: ApprovalResourceType;
  resourceId: string;
  requestedByActorType?: string;
  requestedByActorLabel?: string;
  requestedByApiKeyId?: string | null;
  requestedByUserId?: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  expiresAt: string;
  contentHash?: string;
  consumedAt?: string | null;
  decidedAt?: string | null;
  decidedByUserId?: string | null;
  notes?: string;
}

export type ApprovalContractFailureReason =
  | "invalid-envelope"
  | "missing-list"
  | "too-many-records"
  | "invalid-record"
  | "duplicate-identity"
  | "conflicting-list-keys"
  | "foreign-tenant"
  | "identity-mismatch";

export class ApprovalContractError extends Error {
  constructor(
    readonly reason: ApprovalContractFailureReason,
    readonly recordIndex?: number,
  ) {
    super(
      recordIndex === undefined
        ? `Approval response failed the ${reason} contract.`
        : `Approval response record ${recordIndex + 1} failed the ${reason} contract.`,
    );
    this.name = "ApprovalContractError";
  }
}

const APPROVAL_LIST_CAP = 200;
const APPROVAL_ENVELOPE_KEY_CAP = 12;
const APPROVAL_RECORD_KEY_CAP = 32;
const IDENTIFIER_LIMIT = 128;
const DISPLAY_LIMIT = 2_000;
const TIMESTAMP_LIMIT = 64;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const LIST_KEYS = ["approvals", "items"] as const;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAtMostOwnKeys(value: UnknownRecord, maximum: number): boolean {
  return Object.keys(value).length <= maximum;
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= IDENTIFIER_LIMIT &&
    IDENTIFIER_PATTERN.test(value)
    ? value
    : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > TIMESTAMP_LIMIT) return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
    ? value
    : null;
}

function optionalInstant(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return instant(value);
}

function optionalIdentifier(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedIdentifier(value);
}

function optionalDisplay(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "string" ||
    value.length > DISPLAY_LIMIT * 2 ||
    Array.from(value).length > DISPLAY_LIMIT ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function normalizeStatus(value: string): ApprovalStatus {
  switch (value) {
    case "pending":
    case "approved":
    case "rejected":
    case "expired":
      return value;
    default:
      return "unverified";
  }
}

function normalizeResourceType(value: string): ApprovalResourceType {
  switch (value) {
    case "campaign":
    case "sequence":
    case "automation_send":
      return value;
    default:
      return "unverified";
  }
}

function decodeApproval(
  value: unknown,
  expectedTenantId?: string,
  expectedId?: string,
  recordIndex?: number,
): Approval {
  const invalid = (reason: ApprovalContractFailureReason = "invalid-record") =>
    new ApprovalContractError(reason, recordIndex);
  if (!isRecord(value) || !hasAtMostOwnKeys(value, APPROVAL_RECORD_KEY_CAP)) {
    throw invalid();
  }
  const id = boundedIdentifier(value.id);
  const tenantId = boundedIdentifier(value.tenantId);
  const sourceResourceType = boundedIdentifier(value.resourceType);
  const resourceId = boundedIdentifier(value.resourceId);
  const sourceStatus = boundedIdentifier(value.status);
  const requestedAt = instant(value.requestedAt);
  const expiresAt = instant(value.expiresAt);
  if (
    !id ||
    !tenantId ||
    !sourceResourceType ||
    !resourceId ||
    !sourceStatus ||
    !requestedAt ||
    !expiresAt
  ) {
    throw invalid();
  }
  if (expectedTenantId && tenantId !== expectedTenantId) {
    throw invalid("foreign-tenant");
  }
  if (expectedId && id !== expectedId) {
    throw invalid("identity-mismatch");
  }

  const requestedByActorType = optionalIdentifier(value.requestedByActorType);
  const requestedByActorLabel = optionalDisplay(value.requestedByActorLabel);
  const requestedByApiKeyId = optionalIdentifier(value.requestedByApiKeyId);
  const requestedByUserId = optionalIdentifier(value.requestedByUserId);
  const decidedAt = optionalInstant(value.decidedAt);
  const decidedByUserId = optionalIdentifier(value.decidedByUserId);
  const notes = optionalDisplay(value.notes);
  const contentHash = optionalIdentifier(value.contentHash);
  const consumedAt = optionalInstant(value.consumedAt);
  if (
    requestedByActorType === null ||
    requestedByActorLabel === null ||
    requestedByApiKeyId === null ||
    requestedByUserId === null ||
    decidedAt === null ||
    decidedByUserId === null ||
    notes === null ||
    contentHash === null ||
    consumedAt === null
  ) {
    throw invalid();
  }

  return {
    id,
    tenantId,
    resourceType: normalizeResourceType(sourceResourceType),
    resourceId,
    status: normalizeStatus(sourceStatus),
    requestedAt,
    expiresAt,
    ...(requestedByActorType !== undefined ? { requestedByActorType } : {}),
    ...(requestedByActorLabel !== undefined ? { requestedByActorLabel } : {}),
    ...(requestedByApiKeyId !== undefined ? { requestedByApiKeyId } : {}),
    ...(requestedByUserId !== undefined ? { requestedByUserId } : {}),
    ...(decidedAt !== undefined ? { decidedAt } : {}),
    ...(decidedByUserId !== undefined ? { decidedByUserId } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
    ...(consumedAt !== undefined ? { consumedAt } : {}),
  };
}

function decodeApprovalList(
  value: unknown,
  expectedTenantId?: string,
): Approval[] {
  if (!isRecord(value) || !hasAtMostOwnKeys(value, APPROVAL_ENVELOPE_KEY_CAP)) {
    throw new ApprovalContractError("invalid-envelope");
  }
  const presentKeys = LIST_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  if (presentKeys.length === 0) {
    throw new ApprovalContractError("missing-list");
  }
  let canonical: Approval[] | null = null;
  let canonicalIntegrity: string[] | null = null;
  for (const key of presentKeys) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      throw new ApprovalContractError("invalid-envelope");
    }
    if (candidate.length > APPROVAL_LIST_CAP) {
      throw new ApprovalContractError("too-many-records");
    }
    const identities = new Set<string>();
    const integrity: string[] = [];
    const decoded = candidate.map((entry, index) => {
      const approval = decodeApproval(
        entry,
        expectedTenantId,
        undefined,
        index,
      );
      if (identities.has(approval.id)) {
        throw new ApprovalContractError("duplicate-identity", index);
      }
      identities.add(approval.id);
      const source = entry as UnknownRecord;
      integrity.push(
        JSON.stringify({
          ...approval,
          sourceResourceType: source.resourceType,
          sourceStatus: source.status,
        }),
      );
      return approval;
    });
    if (
      canonicalIntegrity &&
      JSON.stringify(canonicalIntegrity) !== JSON.stringify(integrity)
    ) {
      throw new ApprovalContractError("conflicting-list-keys");
    }
    canonical ??= decoded;
    canonicalIntegrity ??= integrity;
  }
  return canonical ?? [];
}

/** Lists approvals, optionally filtered by status (defaults to pending). */
export function listApprovals(
  status: ApprovalStatus | "all" = "pending",
  limit = 50,
  options: ApprovalReadOptions = {},
): Promise<Approval[]> {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();
  return api
    .get<unknown>(
      `/api/v1/approvals${qs ? `?${qs}` : ""}`,
      protectedReadOptions(options),
    )
    .then((value) => decodeApprovalList(value, options.expectedTenantId));
}

export function getApproval(
  id: string,
  options: ApprovalReadOptions = {},
): Promise<Approval> {
  return api
    .get<unknown>(
      `/api/v1/approvals/${encodeURIComponent(id)}`,
      protectedReadOptions(options),
    )
    .then((value) => decodeApproval(value, options.expectedTenantId, id));
}

export function approveApproval(
  id: string,
  notes: string | undefined,
  options: ApprovalMutationOptions,
): Promise<{ ok: boolean; followup_error?: string }> {
  return api.post(
    `/api/v1/approvals/${encodeURIComponent(id)}/approve`,
    { notes: notes ?? "" },
    protectedMutationOptions(options),
  );
}

export function rejectApproval(
  id: string,
  notes: string | undefined,
  options: ApprovalMutationOptions,
): Promise<{ ok: boolean }> {
  return api.post(
    `/api/v1/approvals/${encodeURIComponent(id)}/reject`,
    { notes: notes ?? "" },
    protectedMutationOptions(options),
  );
}

// ---------------------------------------------------------------------------
// Delegation + escalation policy (admin governance — backend handlers.go:89-93)
// ---------------------------------------------------------------------------

export interface Delegation {
  id: string;
  tenantId: string;
  fromUserId: string;
  toUserId: string;
  startsAt: string;
  endsAt?: string | null;
  reason?: string;
  createdByUserId?: string;
  createdAt: string;
  revokedAt?: string | null;
}

export interface DelegationInput {
  fromUserId: string;
  toUserId: string;
  reason?: string;
  startsAt?: string;
  endsAt?: string | null;
}

export interface EscalationPolicy {
  tenantId?: string;
  escalateAfterHours?: number | null;
  notifyOwners: boolean;
}

export function listDelegations(
  options: ApprovalReadOptions = {},
): Promise<Delegation[]> {
  return api
    .get<{
      delegations?: Delegation[];
    }>("/api/v1/approvals/delegations", protectedReadOptions(options))
    .then((r) => r.delegations ?? []);
}

export function createDelegation(
  input: DelegationInput,
  options: ApprovalMutationOptions,
): Promise<Delegation> {
  return api.post<Delegation>(
    "/api/v1/approvals/delegations",
    input,
    protectedMutationOptions(options),
  );
}

export function revokeDelegation(
  id: string,
  options: ApprovalMutationOptions,
): Promise<{ ok: boolean }> {
  return api.delete(
    `/api/v1/approvals/delegations/${encodeURIComponent(id)}`,
    protectedMutationOptions(options),
  );
}

export function getEscalationPolicy(
  options: ApprovalReadOptions = {},
): Promise<EscalationPolicy> {
  return api
    .get<
      Partial<EscalationPolicy>
    >("/api/v1/approvals/escalation-policy", protectedReadOptions(options))
    .then((p) => ({
      escalateAfterHours: p.escalateAfterHours ?? null,
      notifyOwners: p.notifyOwners ?? false,
    }));
}

/**
 * Replaces the escalation policy (PUT is a full replace) — always send the
 * complete intended state so a partial body can't null-out a field.
 */
export function updateEscalationPolicy(
  policy: EscalationPolicy,
  options: ApprovalMutationOptions,
): Promise<EscalationPolicy> {
  return api.put<EscalationPolicy>(
    "/api/v1/approvals/escalation-policy",
    {
      escalateAfterHours: policy.escalateAfterHours ?? null,
      notifyOwners: policy.notifyOwners,
    },
    protectedMutationOptions(options),
  );
}

/** Stable fields that bind a decision dialog to the exact record inspected. */
export function isSameApprovalTarget(
  opened: Approval,
  fresh: Approval,
): boolean {
  return (
    fresh.id === opened.id &&
    fresh.tenantId === opened.tenantId &&
    fresh.resourceType === opened.resourceType &&
    fresh.resourceId === opened.resourceId &&
    fresh.requestedAt === opened.requestedAt &&
    (fresh.expiresAt ?? "") === (opened.expiresAt ?? "") &&
    (fresh.contentHash ?? "") === (opened.contentHash ?? "") &&
    (fresh.consumedAt ?? null) === (opened.consumedAt ?? null) &&
    (fresh.requestedByApiKeyId ?? null) ===
      (opened.requestedByApiKeyId ?? null) &&
    (fresh.requestedByUserId ?? null) === (opened.requestedByUserId ?? null) &&
    (fresh.requestedByActorType ?? "") ===
      (opened.requestedByActorType ?? "") &&
    (fresh.requestedByActorLabel ?? "") === (opened.requestedByActorLabel ?? "")
  );
}

/** True when a delegation is currently active (not revoked, not ended). */
export function isDelegationActive(d: Delegation, now = Date.now()): boolean {
  if (d.revokedAt) return false;
  const startsAt = Date.parse(d.startsAt);
  if (Number.isFinite(startsAt) && startsAt > now) return false;
  if (d.endsAt) {
    const endsAt = Date.parse(d.endsAt);
    if (!Number.isFinite(endsAt) || endsAt < now) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Deep-links an approval's resource to the object under review so a reviewer
 * can inspect what they are approving (GOV-004). Backend resource types:
 * campaign, sequence, automation_send (approvals.go). Returns null for an
 * unknown type or empty id, in which case the UI shows plain mono text.
 */
export function resourceHref(
  resourceType: string,
  resourceId: string,
): string | null {
  const id = (resourceId ?? "").trim();
  if (!id) return null;
  const encoded = encodeURIComponent(id);
  switch ((resourceType ?? "").trim()) {
    case "campaign":
      return `/app/campaigns/${encoded}`;
    case "sequence":
      return `/app/automations/${encoded}`;
    case "automation_send":
      // An automation send is reviewed from its parent automation surface.
      return `/app/automations/${encoded}`;
    default:
      return null;
  }
}

/** Human, title-cased label for a resource type ("automation_send" → "Automation send"). */
export function resourceTypeLabel(resourceType: string): string {
  const raw = (resourceType ?? "").trim();
  if (!raw) return "Resource";
  const spaced = raw.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type ApprovalStatusCounts = Record<ApprovalStatus | "all", number>;

/**
 * Tallies a set of approvals by status for the filter-tab counts (GOV-025).
 * `all` is the total. Computed client-side from one `listApprovals("all")`
 * fetch so the counts and the filtered view stay in sync after a decision.
 */
export function countByStatus(approvals: Approval[]): ApprovalStatusCounts {
  const counts: ApprovalStatusCounts = {
    all: approvals.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    cancelled: 0,
    unverified: 0,
  };
  for (const a of approvals) {
    if (a.status in counts) counts[a.status] += 1;
  }
  return counts;
}

/** Human label for who requested an approval (actor label, then user id). */
export function requesterLabel(a: Approval): string {
  if (a.requestedByActorLabel && a.requestedByActorLabel.trim()) {
    return a.requestedByActorLabel.trim();
  }
  if (a.requestedByUserId) return a.requestedByUserId;
  if (a.requestedByActorType) return a.requestedByActorType;
  return "Unknown";
}

/** Whether a reviewer can still act on this approval. */
export function isActionable(a: Approval, now = Date.now()): boolean {
  const expiresAt = Date.parse(a.expiresAt);
  return (
    a.status === "pending" &&
    a.resourceType !== "unverified" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now
  );
}

/** Maps an approval status to a Badge variant. */
export function statusVariant(
  status: ApprovalStatus,
): "success" | "warning" | "destructive" | "secondary" {
  switch (status) {
    case "approved":
      return "success";
    case "pending":
      return "warning";
    case "rejected":
      return "destructive";
    default:
      return "secondary";
  }
}
