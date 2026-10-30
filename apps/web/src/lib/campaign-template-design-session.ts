// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CampaignTemplateDesignMode,
  CreateCampaignFromDesignInput,
  CreateCampaignTemplateDesignInput,
  RefineCampaignTemplateDesignInput,
  SaveCampaignTemplateDesignInput,
} from "./campaign-templates-api";
import { CAMPAIGN_TEMPLATE_DESIGN_SESSION_PREFIX } from "./campaign-template-session-cleanup";

export { clearAllCampaignTemplateDesignSessions } from "./campaign-template-session-cleanup";

const PREFIX = CAMPAIGN_TEMPLATE_DESIGN_SESSION_PREFIX;
const MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 60 * 1_000;
const MAX_RECORD_BYTES = 1 * 1_024 * 1_024;
const MAX_JSON_MAP_BYTES = 128 * 1_024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_COLLECTION_ITEMS = 2_048;
const MAX_DESIGN_IDS = 3;
const MAX_PENDING_MUTATIONS = 12;
const MAX_ID_BYTES = 255;
const MAX_SCOPE_ID_BYTES = 255;
const MAX_IDEMPOTENCY_KEY_BYTES = 255;
const MAX_FINGERPRINT_BYTES = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

const CREATE_INPUT_KEYS = [
  "mode",
  "source_template_id",
  "brief",
  "instructions",
  "kind",
  "tone",
  "name",
  "goal",
  "category",
  "subject",
  "preview_text",
  "audience",
  "industry",
  "style",
  "layout",
  "brand",
  "content",
  "variables",
  "reference_template_ids",
  "fidelity",
  "sections",
  "cta",
] as const;

const GOALS = new Set([
  "",
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
]);
const KINDS = new Set(["newsletter", "promo", "announcement"]);
const FIDELITIES = new Set(["close", "balanced", "inspired"]);
const UNVERIFIED_SCOPE_IDS = new Set([
  "anon",
  "anonymous",
  "null",
  "undefined",
  "unknown",
]);

export interface CampaignTemplateDesignRecoveryScope {
  tenantId: string;
  userId: string;
}

interface PendingMutationBase<
  Operation extends CampaignTemplateDesignPendingMutationOperation,
  Payload,
> {
  operation: Operation;
  designId: string;
  fingerprint: string;
  payload: Payload;
  idempotencyKey: string;
  createdAt: number;
}

export type CampaignTemplateDesignPendingMutationOperation =
  | "refine"
  | "retry"
  | "save"
  | "create-campaign";

export type CampaignTemplateDesignPendingMutation =
  | PendingMutationBase<"refine", RefineCampaignTemplateDesignInput>
  | PendingMutationBase<"retry", { base_attempt_count: number }>
  | PendingMutationBase<"save", SaveCampaignTemplateDesignInput>
  | PendingMutationBase<"create-campaign", CreateCampaignFromDesignInput>;

export interface CampaignTemplateDesignSession {
  version: 2;
  scope: CampaignTemplateDesignRecoveryScope;
  mode: CampaignTemplateDesignMode;
  sourceTemplateId?: string;
  designIds: string[];
  selectedDesignId?: string;
  pendingCreate?: {
    input: CreateCampaignTemplateDesignInput;
    idempotencyKeys: string[];
  };
  /**
   * Stable retry keys for archive mutations whose outcome is not yet known.
   * Keys are retained only for design IDs in this bounded recovery session.
   */
  pendingArchiveKeys?: Record<string, string>;
  /**
   * Durable identities for acknowledged-or-ambiguous design mutations. The
   * caller reconciles each operation with the server before replay/removal.
   */
  pendingMutations?: CampaignTemplateDesignPendingMutation[];
  updatedAt: number;
}

export type CampaignTemplateDesignSessionInput = Omit<
  CampaignTemplateDesignSession,
  "version" | "scope" | "updatedAt"
>;

export type CampaignTemplateDesignSessionWriteResult =
  | {
      status: "verified";
      persisted: true;
      session: CampaignTemplateDesignSession;
    }
  | {
      status: "storage_unavailable" | "write_failed" | "verification_failed";
      persisted: false;
      session: CampaignTemplateDesignSession;
    }
  | {
      status: "invalid";
      persisted: false;
      session: null;
    };

function stableMutationJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableMutationJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${stableMutationJSON(item)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Binds persisted mutation metadata to its exact operation, draft, and
 * payload. The server remains the authority through its own request hash; this
 * client fingerprint lets recovery reject locally corrupted records before
 * replay.
 */
export function campaignTemplateDesignMutationFingerprint(
  operation: CampaignTemplateDesignPendingMutationOperation,
  designId: string,
  payload: CampaignTemplateDesignPendingMutation["payload"],
): string {
  const value = `${operation}\u0000${designId}\u0000${stableMutationJSON(payload)}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${operation}:${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isWellFormedString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function validOpaqueId(
  value: unknown,
  maxBytes = MAX_ID_BYTES,
): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() === value &&
    isWellFormedString(value) &&
    !CONTROL_RE.test(value) &&
    byteLength(value) <= maxBytes
  );
}

function validBoundedString(
  value: unknown,
  maxCodePoints: number,
  { nonBlank = false }: { nonBlank?: boolean } = {},
): value is string {
  return (
    typeof value === "string" &&
    isWellFormedString(value) &&
    (!nonBlank || value.trim() !== "") &&
    codePointLength(value) <= maxCodePoints
  );
}

function validOptionalString(
  value: unknown,
  maxCodePoints: number,
): value is string | undefined {
  return value === undefined || validBoundedString(value, maxCodePoints);
}

function validIdempotencyKey(value: unknown): value is string {
  return (
    validOpaqueId(value, MAX_IDEMPOTENCY_KEY_BYTES) &&
    byteLength(value) <= MAX_IDEMPOTENCY_KEY_BYTES
  );
}

function validFingerprint(value: unknown): value is string {
  return validOpaqueId(value, MAX_FINGERPRINT_BYTES);
}

function validTimestamp(value: unknown, now: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= now + MAX_FUTURE_SKEW_MS &&
    now - value <= MAX_AGE_MS
  );
}

function validScope(
  value: unknown,
): value is CampaignTemplateDesignRecoveryScope {
  return (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["tenantId", "userId"]) &&
    validOpaqueId(value.tenantId, MAX_SCOPE_ID_BYTES) &&
    validOpaqueId(value.userId, MAX_SCOPE_ID_BYTES) &&
    !UNVERIFIED_SCOPE_IDS.has(value.tenantId.toLowerCase()) &&
    !UNVERIFIED_SCOPE_IDS.has(value.userId.toLowerCase())
  );
}

function sameScope(
  left: CampaignTemplateDesignRecoveryScope,
  right: CampaignTemplateDesignRecoveryScope,
): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

function storageKey(
  scope: CampaignTemplateDesignRecoveryScope,
  mode: CampaignTemplateDesignMode,
  sourceTemplateId?: string,
): string | null {
  if (
    !validScope(scope) ||
    (mode !== "adapt" && mode !== "generate") ||
    (mode === "adapt" && !validOpaqueId(sourceTemplateId)) ||
    (mode === "generate" && sourceTemplateId !== undefined)
  ) {
    return null;
  }
  return [
    PREFIX,
    encodeURIComponent(scope.tenantId),
    encodeURIComponent(scope.userId),
    mode,
    encodeURIComponent(sourceTemplateId ?? "new"),
  ].join(":");
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function validJsonMap(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    if (
      current.value === null ||
      typeof current.value === "boolean" ||
      typeof current.value === "string"
    ) {
      if (
        typeof current.value === "string" &&
        !isWellFormedString(current.value)
      ) {
        return false;
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) return false;
      continue;
    }
    if (typeof current.value !== "object") return false;
    if (seen.has(current.value)) return false;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_COLLECTION_ITEMS) return false;
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) return false;
    const entries = Object.entries(current.value);
    if (entries.length > MAX_JSON_COLLECTION_ITEMS) return false;
    for (const [key, item] of entries) {
      if (!isWellFormedString(key) || byteLength(key) > MAX_JSON_MAP_BYTES) {
        return false;
      }
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }

  try {
    return byteLength(JSON.stringify(value)) <= MAX_JSON_MAP_BYTES;
  } catch {
    return false;
  }
}

function validOptionalJsonMap(
  value: unknown,
): value is Record<string, unknown> | undefined {
  return value === undefined || validJsonMap(value);
}

function validStringArray(
  value: unknown,
  maxItems: number,
  itemMaxCodePoints: number,
  { nonBlank = false }: { nonBlank?: boolean } = {},
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) =>
      validBoundedString(item, itemMaxCodePoints, { nonBlank }),
    )
  );
}

function validReferenceIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DESIGN_IDS &&
    value.every((id) => validOpaqueId(id)) &&
    new Set(value).size === value.length
  );
}

function validCreateInput(
  value: unknown,
  mode: CampaignTemplateDesignMode,
  sourceTemplateId?: string,
): value is CreateCampaignTemplateDesignInput {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, CREATE_INPUT_KEYS) ||
    value.mode !== mode
  ) {
    return false;
  }
  if (
    mode === "adapt"
      ? !validOpaqueId(sourceTemplateId) ||
        value.source_template_id !== sourceTemplateId
      : value.source_template_id !== undefined
  ) {
    return false;
  }
  if (
    !validOptionalString(value.brief, 8_000) ||
    !validOptionalString(value.instructions, 4_000) ||
    !validOptionalString(value.tone, 500) ||
    !validOptionalString(value.name, 200) ||
    !validOptionalString(value.subject, 998) ||
    !validOptionalString(value.preview_text, 500) ||
    !validOptionalString(value.category, 120) ||
    !validOptionalString(value.audience, 1_500) ||
    !validOptionalString(value.industry, 120) ||
    !validOptionalString(value.style, 120) ||
    !validOptionalString(value.layout, 120) ||
    !validOptionalString(value.cta, 1_500) ||
    (value.kind !== undefined &&
      (typeof value.kind !== "string" || !KINDS.has(value.kind))) ||
    (value.goal !== undefined &&
      (typeof value.goal !== "string" || !GOALS.has(value.goal))) ||
    (value.fidelity !== undefined &&
      (typeof value.fidelity !== "string" ||
        !FIDELITIES.has(value.fidelity))) ||
    !validOptionalJsonMap(value.brand) ||
    !validOptionalJsonMap(value.content) ||
    !validOptionalJsonMap(value.variables) ||
    (value.reference_template_ids !== undefined &&
      !validReferenceIds(value.reference_template_ids)) ||
    (value.sections !== undefined &&
      !validStringArray(value.sections, 12, 120, { nonBlank: true }))
  ) {
    return false;
  }
  if (
    mode === "generate" &&
    (!validBoundedString(value.brief, 8_000, { nonBlank: true }) ||
      value.source_template_id !== undefined)
  ) {
    return false;
  }
  if (mode === "adapt" && value.reference_template_ids) {
    const references = new Set([
      sourceTemplateId!,
      ...value.reference_template_ids,
    ]);
    if (references.size > MAX_DESIGN_IDS) return false;
  }
  return true;
}

function validCommitPayload(value: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 1 &&
    typeof value.output_hash === "string" &&
    /^[a-f0-9]{64}$/iu.test(value.output_hash)
  );
}

function validPositiveListId(value: unknown): value is string | number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1;
  }
  if (
    typeof value !== "string" ||
    !/^0*[1-9][0-9]*$/u.test(value) ||
    value.length > 32
  ) {
    return false;
  }
  const canonical = value.replace(/^0+/u, "");
  return (
    canonical.length < 19 ||
    (canonical.length === 19 && canonical <= "9223372036854775807")
  );
}

function validPendingMutationPayload(
  operation: CampaignTemplateDesignPendingMutationOperation,
  value: unknown,
): boolean {
  if (!isPlainRecord(value)) return false;
  switch (operation) {
    case "refine":
      return (
        hasOnlyKeys(value, ["instructions", "base_revision"]) &&
        validBoundedString(value.instructions, 4_000, { nonBlank: true }) &&
        Number.isSafeInteger(value.base_revision) &&
        (value.base_revision as number) >= 1
      );
    case "retry":
      return (
        hasOnlyKeys(value, ["base_attempt_count"]) &&
        Number.isSafeInteger(value.base_attempt_count) &&
        (value.base_attempt_count as number) >= 0
      );
    case "save":
      return (
        hasOnlyKeys(value, [
          "revision",
          "output_hash",
          "slug",
          "name",
          "subject",
          "preview_text",
        ]) &&
        validCommitPayload(value) &&
        typeof value.slug === "string" &&
        /^[a-z][a-z0-9-]{0,79}$/u.test(value.slug) &&
        validOptionalString(value.name, 200) &&
        validOptionalString(value.subject, 998) &&
        validOptionalString(value.preview_text, 500)
      );
    case "create-campaign":
      return (
        hasOnlyKeys(value, [
          "revision",
          "output_hash",
          "name",
          "subject",
          "preview_text",
          "variables",
          "segment_id",
          "list_id",
        ]) &&
        validCommitPayload(value) &&
        validOptionalString(value.name, 200) &&
        validOptionalString(value.subject, 998) &&
        validOptionalString(value.preview_text, 500) &&
        validOptionalJsonMap(value.variables) &&
        (value.segment_id === undefined || validOpaqueId(value.segment_id)) &&
        (value.list_id === undefined || validPositiveListId(value.list_id)) &&
        !(value.segment_id !== undefined && value.list_id !== undefined)
      );
  }
}

function validPendingMutation(
  value: unknown,
  designIds: Set<string>,
  updatedAt: number,
  now: number,
): value is CampaignTemplateDesignPendingMutation {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      "operation",
      "designId",
      "fingerprint",
      "payload",
      "idempotencyKey",
      "createdAt",
    ]) ||
    (value.operation !== "refine" &&
      value.operation !== "retry" &&
      value.operation !== "save" &&
      value.operation !== "create-campaign") ||
    !validOpaqueId(value.designId) ||
    !designIds.has(value.designId) ||
    !validFingerprint(value.fingerprint) ||
    !validIdempotencyKey(value.idempotencyKey) ||
    !validTimestamp(value.createdAt, now) ||
    (value.createdAt as number) > updatedAt + MAX_FUTURE_SKEW_MS
  ) {
    return false;
  }
  if (!validPendingMutationPayload(value.operation, value.payload)) {
    return false;
  }
  return (
    value.fingerprint ===
    campaignTemplateDesignMutationFingerprint(
      value.operation,
      value.designId,
      value.payload as CampaignTemplateDesignPendingMutation["payload"],
    )
  );
}

function decodeSession(
  raw: string,
  expectedScope: CampaignTemplateDesignRecoveryScope,
  expectedMode: CampaignTemplateDesignMode,
  expectedSourceTemplateId: string | undefined,
  now: number,
): CampaignTemplateDesignSession | null {
  // This byte bound intentionally happens before JSON.parse. Persisted state
  // is attacker-controlled input after extensions, devtools, or old clients.
  if (byteLength(raw) > MAX_RECORD_BYTES) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, [
        "version",
        "scope",
        "mode",
        "sourceTemplateId",
        "designIds",
        "selectedDesignId",
        "pendingCreate",
        "pendingArchiveKeys",
        "pendingMutations",
        "updatedAt",
      ]) ||
      value.version !== 2 ||
      !validScope(value.scope) ||
      !sameScope(value.scope, expectedScope) ||
      value.mode !== expectedMode ||
      value.sourceTemplateId !== expectedSourceTemplateId ||
      !validTimestamp(value.updatedAt, now) ||
      !Array.isArray(value.designIds) ||
      value.designIds.length > MAX_DESIGN_IDS ||
      !value.designIds.every((id) => validOpaqueId(id)) ||
      new Set(value.designIds).size !== value.designIds.length
    ) {
      return null;
    }

    const designIds = new Set(value.designIds as string[]);
    if (
      value.selectedDesignId !== undefined &&
      (!validOpaqueId(value.selectedDesignId) ||
        !designIds.has(value.selectedDesignId))
    ) {
      return null;
    }

    const stableKeys = new Set<string>();
    if (value.pendingCreate !== undefined) {
      if (
        !isPlainRecord(value.pendingCreate) ||
        !hasOnlyKeys(value.pendingCreate, ["input", "idempotencyKeys"]) ||
        !validCreateInput(
          value.pendingCreate.input,
          expectedMode,
          expectedSourceTemplateId,
        ) ||
        !Array.isArray(value.pendingCreate.idempotencyKeys) ||
        value.pendingCreate.idempotencyKeys.length < 1 ||
        value.pendingCreate.idempotencyKeys.length > MAX_DESIGN_IDS ||
        !value.pendingCreate.idempotencyKeys.every(validIdempotencyKey) ||
        new Set(value.pendingCreate.idempotencyKeys).size !==
          value.pendingCreate.idempotencyKeys.length
      ) {
        return null;
      }
      for (const key of value.pendingCreate.idempotencyKeys as string[]) {
        stableKeys.add(key);
      }
    }

    if (value.pendingArchiveKeys !== undefined) {
      if (!isPlainRecord(value.pendingArchiveKeys)) return null;
      const entries = Object.entries(value.pendingArchiveKeys);
      if (
        entries.length < 1 ||
        entries.length > MAX_DESIGN_IDS ||
        new Set(entries.map(([, key]) => key)).size !== entries.length ||
        entries.some(
          ([id, key]) =>
            !designIds.has(id) ||
            !validOpaqueId(id) ||
            !validIdempotencyKey(key) ||
            stableKeys.has(key),
        )
      ) {
        return null;
      }
      for (const [, key] of entries) stableKeys.add(key as string);
    }

    if (value.pendingMutations !== undefined) {
      if (
        !Array.isArray(value.pendingMutations) ||
        value.pendingMutations.length < 1 ||
        value.pendingMutations.length > MAX_PENDING_MUTATIONS
      ) {
        return null;
      }
      const identities = new Set<string>();
      const fingerprints = new Set<string>();
      for (const mutation of value.pendingMutations) {
        if (
          !validPendingMutation(
            mutation,
            designIds,
            value.updatedAt as number,
            now,
          )
        ) {
          return null;
        }
        const identity = `${mutation.operation}\u0000${mutation.designId}`;
        if (
          identities.has(identity) ||
          fingerprints.has(mutation.fingerprint) ||
          stableKeys.has(mutation.idempotencyKey)
        ) {
          return null;
        }
        identities.add(identity);
        fingerprints.add(mutation.fingerprint);
        stableKeys.add(mutation.idempotencyKey);
      }
    }

    return value as unknown as CampaignTemplateDesignSession;
  } catch {
    return null;
  }
}

function removeBestEffort(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Exact-key reads remain fail closed even when privacy mode blocks cleanup.
  }
}

export function readCampaignTemplateDesignSession(
  scope: CampaignTemplateDesignRecoveryScope,
  mode: CampaignTemplateDesignMode,
  sourceTemplateId?: string,
): CampaignTemplateDesignSession | null {
  const key = storageKey(scope, mode, sourceTemplateId);
  const storage = localStorageOrNull();
  if (!key || !storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const parsed = decodeSession(raw, scope, mode, sourceTemplateId, Date.now());
  if (!parsed) removeBestEffort(storage, key);
  return parsed;
}

export function writeCampaignTemplateDesignSession(
  scope: CampaignTemplateDesignRecoveryScope,
  session: CampaignTemplateDesignSessionInput,
): CampaignTemplateDesignSessionWriteResult {
  const key = storageKey(scope, session.mode, session.sourceTemplateId);
  if (!key || !Array.isArray(session.designIds)) {
    return { status: "invalid", persisted: false, session: null };
  }

  const designIds = Array.from(new Set(session.designIds)).slice(
    0,
    MAX_DESIGN_IDS,
  );
  const pendingArchiveEntries = session.pendingArchiveKeys
    ? Object.entries(session.pendingArchiveKeys)
        .filter(
          (entry): entry is [string, string] =>
            designIds.includes(entry[0]) && validIdempotencyKey(entry[1]),
        )
        .slice(0, MAX_DESIGN_IDS)
    : [];
  const now = Date.now();
  const candidate: CampaignTemplateDesignSession = {
    version: 2,
    scope: { tenantId: scope.tenantId, userId: scope.userId },
    mode: session.mode,
    ...(session.sourceTemplateId
      ? { sourceTemplateId: session.sourceTemplateId }
      : {}),
    designIds,
    ...(session.selectedDesignId && designIds.includes(session.selectedDesignId)
      ? { selectedDesignId: session.selectedDesignId }
      : {}),
    ...(session.pendingCreate ? { pendingCreate: session.pendingCreate } : {}),
    ...(pendingArchiveEntries.length
      ? { pendingArchiveKeys: Object.fromEntries(pendingArchiveEntries) }
      : {}),
    ...(session.pendingMutations?.length
      ? { pendingMutations: session.pendingMutations }
      : {}),
    updatedAt: now,
  };

  let raw: string;
  try {
    raw = JSON.stringify(candidate);
  } catch {
    return { status: "invalid", persisted: false, session: null };
  }
  if (byteLength(raw) > MAX_RECORD_BYTES) {
    return { status: "invalid", persisted: false, session: null };
  }
  const canonical = decodeSession(
    raw,
    scope,
    session.mode,
    session.sourceTemplateId,
    now,
  );
  if (!canonical) {
    return { status: "invalid", persisted: false, session: null };
  }

  const storage = localStorageOrNull();
  if (!storage) {
    return {
      status: "storage_unavailable",
      persisted: false,
      session: canonical,
    };
  }
  try {
    storage.setItem(key, raw);
  } catch {
    return { status: "write_failed", persisted: false, session: canonical };
  }

  let readBack: string | null;
  try {
    readBack = storage.getItem(key);
  } catch {
    removeBestEffort(storage, key);
    return {
      status: "verification_failed",
      persisted: false,
      session: canonical,
    };
  }
  if (readBack !== raw) {
    removeBestEffort(storage, key);
    return {
      status: "verification_failed",
      persisted: false,
      session: canonical,
    };
  }
  const verified = decodeSession(
    readBack,
    scope,
    session.mode,
    session.sourceTemplateId,
    now,
  );
  if (!verified) {
    removeBestEffort(storage, key);
    return {
      status: "verification_failed",
      persisted: false,
      session: canonical,
    };
  }
  return { status: "verified", persisted: true, session: verified };
}

export function clearCampaignTemplateDesignSession(
  scope: CampaignTemplateDesignRecoveryScope,
  mode: CampaignTemplateDesignMode,
  sourceTemplateId?: string,
): void {
  const key = storageKey(scope, mode, sourceTemplateId);
  const storage = localStorageOrNull();
  if (key && storage) removeBestEffort(storage, key);
}
