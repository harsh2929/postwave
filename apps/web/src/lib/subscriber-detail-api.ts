// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-subscriber data surfaces of the drill-down (desktop parity rows
 * audience-69/70/71/83):
 *
 *   GET    /api/v1/lists/for-subscriber/{sub_id}              {subscriber_id, items[{id,name}], count}
 *   POST   /api/v1/lists/{id}/subscribers                     {subscriber_ids:[id]} → {added, skipped}
 *   DELETE /api/v1/lists/{id}/subscribers/{sub_id}            204
 *   GET    /api/v1/merge-fields/schema                        {items[…]}
 *   GET    /api/v1/subscribers/{id}/merge-fields              {subscriber_id, values}
 *   PATCH  /api/v1/subscribers/{id}/merge-fields              partial upsert; "" clears
 *   GET    /api/v1/subscribers/{id}/custom-objects            {items[…]}
 *   POST   /api/v1/subscribers/{id}/custom-objects            {objectRecordId, relationship} → 201 link
 *   PATCH  /api/v1/subscribers/{id}/custom-objects/{link_id}  {relationship} → link
 *   DELETE /api/v1/subscribers/{id}/custom-objects/{link_id}  204
 *   PATCH  /api/v1/subscribers/{id}                           {custom_fields} under If-Match
 *
 * Insight + compliance surfaces (desktop parity rows audience-50/78/79):
 *
 *   GET    /api/v1/subscribers/{id}/engagement-score          {score|null, computed_at?}
 *   GET    /api/v1/subscribers/{id}/ai-summary?refresh=1      {summary, drivers[], last_updated, cache_hit, source}
 *   GET    /api/v1/contact-ratings/{subscriber_id}            {subscriber_id, stars?, engagement_score?, engagement_score_at?, source}
 *   PATCH  /api/v1/subscribers/{id}/rating                    {rating: 0..5} (0 clears) → {subscriber_id, rating|null}
 *   GET    /api/v1/subscribers/{id}/history?limit=&before=    {subscriber_id, items[], next_cursor?}
 *   POST   /api/v1/contact-ratings/recompute                  {} → {updated, scanned, started_at, finished_at, window_days}
 *   GET    /api/v1/subscribers/{id}/data-export.zip           application/zip (DSAR bundle)
 *
 * Every response is checked against the identity that was asked for, so a
 * cache mix-up or a partial rollout never becomes editable UI state.
 */
import { api, fetchBlobAuthed } from "@/lib/api";
import {
  isExactSubscriberVersion,
  updateSubscriber,
  type Subscriber,
} from "@/lib/subscribers-api";

export class SubscriberDetailContractError extends Error {
  readonly code = "subscriber_detail_contract_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberDetailContractError";
  }
}

export class SubscriberDetailInputError extends Error {
  readonly code = "subscriber_detail_input_error";

  constructor(message: string) {
    super(message);
    this.name = "SubscriberDetailInputError";
  }
}

export interface DetailMutationOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENGINE_ID_RE = /^[1-9][0-9]{0,15}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function subscriberSegment(subscriberId: string): string {
  const id = subscriberId.trim();
  if (!UUID_RE.test(id)) {
    throw new SubscriberDetailInputError("The subscriber id is invalid.");
  }
  return encodeURIComponent(id);
}

function listSegment(listRef: string): string {
  const ref = listRef.trim();
  if (!UUID_RE.test(ref) && !ENGINE_ID_RE.test(ref)) {
    throw new SubscriberDetailInputError("The list id is invalid.");
  }
  return encodeURIComponent(ref);
}

function linkSegment(linkId: string): string {
  const id = linkId.trim();
  if (!UUID_RE.test(id)) {
    throw new SubscriberDetailInputError("The custom-object link id is invalid.");
  }
  return encodeURIComponent(id);
}

export function newDetailMutationKey(prefix: string): string {
  const unique =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${unique}`;
}

/* ============================ List memberships =========================== */

/** Mirrors `lists.SubscriberListRef` — `id` is the Moosewave list uuid. */
export interface SubscriberListMembership {
  id: string;
  name: string;
}

export interface ListMembershipReceipt {
  added: number;
  skipped: number;
}

export async function listSubscriberListMemberships(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberListMembership[]> {
  const raw = await api.get<unknown>(
    `/api/v1/lists/for-subscriber/${subscriberSegment(subscriberId)}`,
    { signal },
  );
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new SubscriberDetailContractError(
      "The list-membership service returned an incomplete response.",
    );
  }
  if (
    typeof raw.subscriber_id === "string" &&
    !sameId(raw.subscriber_id, subscriberId)
  ) {
    throw new SubscriberDetailContractError(
      "The list-membership service answered for a different subscriber.",
    );
  }
  const items = raw.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      typeof item.name !== "string"
    ) {
      throw new SubscriberDetailContractError(
        "The list-membership service returned an invalid membership.",
      );
    }
    return { id: item.id, name: item.name };
  });
  if (
    new Set(items.map((item) => item.id.toLowerCase())).size !== items.length ||
    (raw.count !== undefined && raw.count !== items.length)
  ) {
    throw new SubscriberDetailContractError(
      "The list-membership service returned duplicate or miscounted memberships.",
    );
  }
  return items.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

/**
 * Adds one subscriber to one list. `listRef` is the Moosewave list uuid or the
 * engine's integer id — the server resolves either.
 */
export async function addSubscriberToList(
  listRef: string,
  subscriberId: string,
  options: DetailMutationOptions = {},
): Promise<ListMembershipReceipt> {
  const raw = await api.post<unknown>(
    `/api/v1/lists/${listSegment(listRef)}/subscribers`,
    { subscriber_ids: [subscriberId.trim()] },
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("subscriber-list-add"),
      signal: options.signal,
    },
  );
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.added) ||
    !Number.isSafeInteger(raw.skipped) ||
    Number(raw.added) < 0 ||
    Number(raw.skipped) < 0 ||
    Number(raw.added) + Number(raw.skipped) !== 1
  ) {
    throw new SubscriberDetailContractError(
      "The list-membership service did not confirm exactly one subscriber.",
    );
  }
  return { added: Number(raw.added), skipped: Number(raw.skipped) };
}

export async function removeSubscriberFromList(
  listRef: string,
  subscriberId: string,
  options: DetailMutationOptions = {},
): Promise<void> {
  await api.delete(
    `/api/v1/lists/${listSegment(listRef)}/subscribers/${subscriberSegment(subscriberId)}`,
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ??
        newDetailMutationKey("subscriber-list-remove"),
      signal: options.signal,
    },
  );
}

/* ============================== Merge fields ============================= */

export const MERGE_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "address",
  "phone",
] as const;
export type MergeFieldType = (typeof MERGE_FIELD_TYPES)[number];

/** Mirrors `merge_fields.MaxValueLength`. */
export const MAX_MERGE_FIELD_VALUE_LENGTH = 4096;

export interface MergeFieldDefinition {
  key: string;
  label: string;
  type: MergeFieldType;
  default_value: string;
  required: boolean;
  position: number;
}

export interface SubscriberMergeFieldValues {
  subscriber_id: string;
  values: Record<string, string>;
}

function isMergeFieldType(value: unknown): value is MergeFieldType {
  return (
    typeof value === "string" &&
    (MERGE_FIELD_TYPES as readonly string[]).includes(value)
  );
}

export async function listMergeFieldSchema(
  signal?: AbortSignal,
): Promise<MergeFieldDefinition[]> {
  const raw = await api.get<unknown>("/api/v1/merge-fields/schema", {
    signal,
  });
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new SubscriberDetailContractError(
      "The audience-field service returned an incomplete schema.",
    );
  }
  const items = raw.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      !item.key.trim() ||
      typeof item.label !== "string" ||
      !isMergeFieldType(item.type) ||
      typeof item.required !== "boolean"
    ) {
      throw new SubscriberDetailContractError(
        "The audience-field service returned an invalid field.",
      );
    }
    return {
      key: item.key,
      label: item.label,
      type: item.type,
      default_value:
        typeof item.default_value === "string" ? item.default_value : "",
      required: item.required,
      position: Number.isSafeInteger(item.position) ? Number(item.position) : 0,
    };
  });
  if (new Set(items.map((item) => item.key)).size !== items.length) {
    throw new SubscriberDetailContractError(
      "The audience-field service returned duplicate fields.",
    );
  }
  return items.sort(
    (left, right) =>
      left.position - right.position || left.key.localeCompare(right.key),
  );
}

function parseMergeFieldValues(
  raw: unknown,
  subscriberId: string,
): SubscriberMergeFieldValues {
  if (
    !isRecord(raw) ||
    typeof raw.subscriber_id !== "string" ||
    !isRecord(raw.values) ||
    !Object.values(raw.values).every((value) => typeof value === "string")
  ) {
    throw new SubscriberDetailContractError(
      "The subscriber audience-field response was incomplete.",
    );
  }
  if (!sameId(raw.subscriber_id, subscriberId)) {
    throw new SubscriberDetailContractError(
      "The audience-field service answered for a different subscriber.",
    );
  }
  return {
    subscriber_id: raw.subscriber_id,
    values: { ...(raw.values as Record<string, string>) },
  };
}

export async function getSubscriberMergeFieldValues(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberMergeFieldValues> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/merge-fields`,
    { signal },
  );
  return parseMergeFieldValues(raw, subscriberId);
}

/**
 * Partial upsert — only the keys sent change. An empty string clears the
 * stored value so the field falls back to its schema default.
 */
export async function patchSubscriberMergeFieldValues(
  subscriberId: string,
  values: Record<string, string>,
  options: DetailMutationOptions = {},
): Promise<SubscriberMergeFieldValues> {
  if (Object.keys(values).length === 0) {
    throw new SubscriberDetailInputError("Choose a field to update.");
  }
  const raw = await api.patch<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/merge-fields`,
    values,
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("subscriber-merge-field"),
      signal: options.signal,
    },
  );
  return parseMergeFieldValues(raw, subscriberId);
}

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const at = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day
  );
}

/**
 * Client mirror of `merge_fields.validateTypedValue` so an obviously invalid
 * value never leaves the browser; the server still decides.
 */
export function mergeFieldValueProblem(
  definition: Pick<MergeFieldDefinition, "type" | "required" | "label">,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (Array.from(trimmed).length > MAX_MERGE_FIELD_VALUE_LENGTH) {
    return `Values must be ${MAX_MERGE_FIELD_VALUE_LENGTH} characters or fewer.`;
  }
  if (trimmed === "") {
    return definition.required
      ? `${definition.label} is required and cannot be cleared.`
      : null;
  }
  switch (definition.type) {
    case "number": {
      const parsed = Number(trimmed);
      return Number.isFinite(parsed)
        ? null
        : "Number values must be valid finite numbers.";
    }
    case "boolean":
      return trimmed === "true" || trimmed === "false"
        ? null
        : "Boolean values must be true or false.";
    case "date":
      return isRealCalendarDate(trimmed)
        ? null
        : "Date values must use YYYY-MM-DD.";
    default:
      return null;
  }
}

/* ========================== Custom-object links ========================== */

export interface SubscriberObjectLink {
  id: string;
  objectTypeId: string;
  objectRecordId: string;
  subscriberId?: string;
  relationship: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  objectTypeKey?: string;
  objectTypeLabel?: string;
  externalId?: string;
  properties?: Record<string, unknown>;
}

/** Relationship labels are free text; keep them label-sized. */
export const MAX_RELATIONSHIP_LENGTH = 100;

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseObjectLink(
  raw: unknown,
  subscriberId: string,
): SubscriberObjectLink {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !UUID_RE.test(raw.id) ||
    typeof raw.objectRecordId !== "string" ||
    !raw.objectRecordId ||
    typeof raw.objectTypeId !== "string" ||
    typeof raw.relationship !== "string"
  ) {
    throw new SubscriberDetailContractError(
      "The custom-object service returned an invalid link.",
    );
  }
  if (
    typeof raw.subscriberId === "string" &&
    raw.subscriberId &&
    !sameId(raw.subscriberId, subscriberId)
  ) {
    throw new SubscriberDetailContractError(
      "The custom-object service returned a link for a different subscriber.",
    );
  }
  return {
    id: raw.id,
    objectTypeId: raw.objectTypeId,
    objectRecordId: raw.objectRecordId,
    ...(typeof raw.subscriberId === "string" && raw.subscriberId
      ? { subscriberId: raw.subscriberId }
      : {}),
    relationship: raw.relationship,
    metadata: isRecord(raw.metadata) ? raw.metadata : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
    ...(optionalText(raw.objectTypeKey)
      ? { objectTypeKey: optionalText(raw.objectTypeKey) }
      : {}),
    ...(optionalText(raw.objectTypeLabel)
      ? { objectTypeLabel: optionalText(raw.objectTypeLabel) }
      : {}),
    ...(optionalText(raw.externalId)
      ? { externalId: optionalText(raw.externalId) }
      : {}),
    ...(isRecord(raw.properties) ? { properties: raw.properties } : {}),
  };
}

function relationshipInput(value: string): string {
  const relationship = value.trim() || "related";
  if (Array.from(relationship).length > MAX_RELATIONSHIP_LENGTH) {
    throw new SubscriberDetailInputError(
      `Relationship labels must be ${MAX_RELATIONSHIP_LENGTH} characters or fewer.`,
    );
  }
  return relationship;
}

export async function listSubscriberObjectLinks(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberObjectLink[]> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/custom-objects`,
    { signal },
  );
  if (!isRecord(raw) || !Array.isArray(raw.items)) {
    throw new SubscriberDetailContractError(
      "The custom-object service returned an incomplete link list.",
    );
  }
  const items = raw.items.map((item) => parseObjectLink(item, subscriberId));
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new SubscriberDetailContractError(
      "The custom-object service returned duplicate links.",
    );
  }
  return items;
}

export async function linkSubscriberObject(
  subscriberId: string,
  input: { objectRecordId: string; relationship: string },
  options: DetailMutationOptions = {},
): Promise<SubscriberObjectLink> {
  const objectRecordId = input.objectRecordId.trim();
  if (!UUID_RE.test(objectRecordId)) {
    throw new SubscriberDetailInputError("Choose a record to link.");
  }
  const raw = await api.post<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/custom-objects`,
    { objectRecordId, relationship: relationshipInput(input.relationship) },
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("subscriber-object-link"),
      signal: options.signal,
    },
  );
  const link = parseObjectLink(raw, subscriberId);
  if (!sameId(link.objectRecordId, objectRecordId)) {
    throw new SubscriberDetailContractError(
      "The custom-object service linked a different record.",
    );
  }
  return link;
}

export async function updateSubscriberObjectLink(
  subscriberId: string,
  linkId: string,
  input: { relationship: string },
  options: DetailMutationOptions = {},
): Promise<SubscriberObjectLink> {
  const raw = await api.patch<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/custom-objects/${linkSegment(linkId)}`,
    { relationship: relationshipInput(input.relationship) },
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ??
        newDetailMutationKey("subscriber-object-link-update"),
      signal: options.signal,
    },
  );
  const link = parseObjectLink(raw, subscriberId);
  if (!sameId(link.id, linkId)) {
    throw new SubscriberDetailContractError(
      "The custom-object service updated a different link.",
    );
  }
  return link;
}

export async function unlinkSubscriberObject(
  subscriberId: string,
  linkId: string,
  options: DetailMutationOptions = {},
): Promise<void> {
  await api.delete(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/custom-objects/${linkSegment(linkId)}`,
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ??
        newDetailMutationKey("subscriber-object-unlink"),
      signal: options.signal,
    },
  );
}

/* ========================== Custom-field values ========================== */

export type CustomFieldStoredValue = Subscriber["custom_fields"][string];

/**
 * The FULL `custom_fields` map to send when one value changes. The backend
 * treats a non-nil custom_fields as a full replace, so every key the operator
 * did not touch — defined or ad-hoc — is carried through verbatim; only `key`
 * is set (or, for `null`, removed).
 */
export function customFieldsWithValue(
  current: Subscriber["custom_fields"] | null | undefined,
  key: string,
  value: CustomFieldStoredValue | undefined,
): Subscriber["custom_fields"] {
  const next: Subscriber["custom_fields"] = { ...(current ?? {}) };
  if (value === null || value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Sets (or, with `null`, removes) one custom-field value under the exact
 * revision that was loaded. A stale revision is a 412/409 from the server,
 * never a silent overwrite of someone else's change.
 */
export async function setSubscriberCustomFieldValue(
  subscriber: Subscriber,
  key: string,
  value: CustomFieldStoredValue,
  options: DetailMutationOptions = {},
): Promise<Subscriber> {
  const id = subscriber.id;
  if (!id || !isExactSubscriberVersion(subscriber.version, id)) {
    throw new SubscriberDetailInputError(
      "Reload this subscriber before changing custom fields so the latest revision can be verified.",
    );
  }
  const fieldKey = key.trim();
  if (!fieldKey) {
    throw new SubscriberDetailInputError("Choose a custom field.");
  }
  if (value === null && !Object.hasOwn(subscriber.custom_fields ?? {}, fieldKey)) {
    throw new SubscriberDetailInputError(
      "This subscriber has no stored value for that field.",
    );
  }
  return updateSubscriber(
    id,
    {
      custom_fields: customFieldsWithValue(
        subscriber.custom_fields,
        fieldKey,
        value,
      ),
    },
    {
      expectedVersion: subscriber.version,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("subscriber-custom-field"),
      signal: options.signal,
    },
  );
}

/* ============================ Engagement score =========================== */

/** Mirrors `subscriberscore.EngagementScore`; `score` is null until scored. */
export interface SubscriberEngagementScore {
  score: number | null;
  computed_at: string | null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export async function getSubscriberEngagementScore(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberEngagementScore> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/engagement-score`,
    { signal },
  );
  if (
    !isRecord(raw) ||
    !(raw.score === null || Number.isSafeInteger(raw.score)) ||
    (raw.computed_at != null && !isTimestamp(raw.computed_at))
  ) {
    throw new SubscriberDetailContractError(
      "The engagement-score service returned an incomplete response.",
    );
  }
  return {
    score: raw.score === null ? null : Number(raw.score),
    computed_at: isTimestamp(raw.computed_at) ? raw.computed_at : null,
  };
}

/* =============================== AI summary ============================== */

export interface SubscriberAiSummaryDriver {
  key: string;
  label: string;
  value: string;
  weight?: "high" | "medium" | "low";
}

/**
 * Mirrors `profile_summary.Summary`. `source` says who wrote the sentence:
 * "ai" when the model produced it, "deterministic" when the structured-signal
 * fallback did — the card discloses which, never implying AI when it was not.
 */
export interface SubscriberAiSummary {
  summary: string;
  drivers: SubscriberAiSummaryDriver[];
  last_updated: string;
  cache_hit: boolean;
  source: "ai" | "deterministic";
}

const SUMMARY_WEIGHTS = new Set(["high", "medium", "low"]);

export async function getSubscriberAiSummary(
  subscriberId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<SubscriberAiSummary> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/ai-summary`,
    {
      query: options.refresh ? { refresh: 1 } : undefined,
      signal: options.signal,
    },
  );
  if (
    !isRecord(raw) ||
    typeof raw.summary !== "string" ||
    !raw.summary.trim() ||
    !Array.isArray(raw.drivers) ||
    !isTimestamp(raw.last_updated) ||
    typeof raw.cache_hit !== "boolean" ||
    (raw.source !== "ai" && raw.source !== "deterministic")
  ) {
    throw new SubscriberDetailContractError(
      "The profile-summary service returned an incomplete response.",
    );
  }
  const drivers = raw.drivers.map((driver) => {
    if (
      !isRecord(driver) ||
      typeof driver.key !== "string" ||
      !driver.key ||
      typeof driver.label !== "string" ||
      typeof driver.value !== "string"
    ) {
      throw new SubscriberDetailContractError(
        "The profile-summary service returned an invalid driver.",
      );
    }
    return {
      key: driver.key,
      label: driver.label,
      value: driver.value,
      ...(typeof driver.weight === "string" && SUMMARY_WEIGHTS.has(driver.weight)
        ? { weight: driver.weight as SubscriberAiSummaryDriver["weight"] }
        : {}),
    };
  });
  return {
    summary: raw.summary,
    drivers,
    last_updated: raw.last_updated,
    cache_hit: raw.cache_hit,
    source: raw.source,
  };
}

/* ============================= Contact rating ============================ */

/**
 * Mirrors `contact_rating.SubscriberRating`. `stars` is the stored manual
 * rating when `source` is "manual"; for "heuristic" it is derived from the
 * engagement score and no manual rating exists.
 */
export interface SubscriberRatingView {
  subscriber_id: string;
  stars: number | null;
  engagement_score: number | null;
  engagement_score_at: string | null;
  source: "manual" | "heuristic";
}

export interface SubscriberRatingReceipt {
  subscriber_id: string;
  rating: number | null;
}

export interface ContactHistoryEvent {
  id: string;
  subscriber_id: string;
  kind: string;
  at: string;
  payload: Record<string, unknown>;
}

export interface ContactHistoryPage {
  items: ContactHistoryEvent[];
  next_cursor: string | null;
}

export interface ContactRatingRecomputeResult {
  updated: number;
  scanned: number;
  window_days: number;
  started_at: string;
  finished_at: string;
}

function isStarValue(value: unknown, min: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= 5
  );
}

export async function getSubscriberRatingView(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberRatingView> {
  const raw = await api.get<unknown>(
    `/api/v1/contact-ratings/${subscriberSegment(subscriberId)}`,
    { signal },
  );
  if (
    !isRecord(raw) ||
    typeof raw.subscriber_id !== "string" ||
    (raw.source !== "manual" && raw.source !== "heuristic") ||
    (raw.stars != null && !isStarValue(raw.stars, 1)) ||
    (raw.engagement_score != null &&
      !Number.isSafeInteger(raw.engagement_score)) ||
    (raw.engagement_score_at != null && !isTimestamp(raw.engagement_score_at))
  ) {
    throw new SubscriberDetailContractError(
      "The contact-rating service returned an incomplete response.",
    );
  }
  if (!sameId(raw.subscriber_id, subscriberId)) {
    throw new SubscriberDetailContractError(
      "The contact-rating service answered for a different subscriber.",
    );
  }
  return {
    subscriber_id: raw.subscriber_id,
    stars: isStarValue(raw.stars, 1) ? raw.stars : null,
    engagement_score:
      raw.engagement_score == null ? null : Number(raw.engagement_score),
    engagement_score_at: isTimestamp(raw.engagement_score_at)
      ? raw.engagement_score_at
      : null,
    source: raw.source,
  };
}

/** The manual rating an operator set, or null — never the heuristic stars. */
export function manualRatingOf(
  view: SubscriberRatingView | null | undefined,
): number | null {
  return view?.source === "manual" ? view.stars : null;
}

/** Sets a manual 1..5 rating; `0` clears it so the heuristic applies again. */
export async function setSubscriberRating(
  subscriberId: string,
  rating: number,
  options: DetailMutationOptions = {},
): Promise<SubscriberRatingReceipt> {
  if (!isStarValue(rating, 0)) {
    throw new SubscriberDetailInputError(
      "Ratings are whole stars from 1 to 5, or 0 to clear.",
    );
  }
  const raw = await api.patch<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/rating`,
    { rating },
    {
      requireOnline: true,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("subscriber-rating"),
      signal: options.signal,
    },
  );
  if (
    !isRecord(raw) ||
    typeof raw.subscriber_id !== "string" ||
    !(raw.rating === null || isStarValue(raw.rating, 1))
  ) {
    throw new SubscriberDetailContractError(
      "The rating service returned an incomplete response.",
    );
  }
  if (!sameId(raw.subscriber_id, subscriberId)) {
    throw new SubscriberDetailContractError(
      "The rating service answered for a different subscriber.",
    );
  }
  const stored = raw.rating === null ? null : Number(raw.rating);
  if (stored !== (rating === 0 ? null : rating)) {
    throw new SubscriberDetailContractError(
      "The rating service stored a different rating than the one chosen.",
    );
  }
  return { subscriber_id: raw.subscriber_id, rating: stored };
}

export const CONTACT_HISTORY_PAGE_SIZE = 50;

export async function listSubscriberContactHistory(
  subscriberId: string,
  options: { before?: string; signal?: AbortSignal } = {},
): Promise<ContactHistoryPage> {
  const raw = await api.get<unknown>(
    `/api/v1/subscribers/${subscriberSegment(subscriberId)}/history`,
    {
      query: { limit: CONTACT_HISTORY_PAGE_SIZE, before: options.before },
      signal: options.signal,
    },
  );
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.items) ||
    raw.items.length > 200 ||
    (raw.next_cursor !== undefined &&
      (typeof raw.next_cursor !== "string" ||
        !raw.next_cursor ||
        raw.next_cursor.length > 512))
  ) {
    throw new SubscriberDetailContractError(
      "The contact-history service returned an incomplete response.",
    );
  }
  if (
    typeof raw.subscriber_id === "string" &&
    !sameId(raw.subscriber_id, subscriberId)
  ) {
    throw new SubscriberDetailContractError(
      "The contact-history service answered for a different subscriber.",
    );
  }
  const items = raw.items.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.kind !== "string" ||
      !item.kind ||
      !isTimestamp(item.at) ||
      !isRecord(item.payload)
    ) {
      throw new SubscriberDetailContractError(
        "The contact-history service returned an invalid event.",
      );
    }
    return {
      id: item.id,
      subscriber_id:
        typeof item.subscriber_id === "string" ? item.subscriber_id : "",
      kind: item.kind,
      at: item.at,
      payload: item.payload,
    };
  });
  return {
    items,
    next_cursor:
      typeof raw.next_cursor === "string" && raw.next_cursor
        ? raw.next_cursor
        : null,
  };
}

/**
 * Readable line for one contact-history event. Only the allowlisted
 * `rating.changed` payload is ever shown; anything else renders a neutral
 * title and never raw JSON (the server already strips other payloads).
 */
export function contactHistoryDisplay(
  event: Pick<ContactHistoryEvent, "kind" | "payload">,
): { title: string; detail: string | null } {
  if (event.kind === "rating.changed") {
    const rating = event.payload.rating;
    return {
      title: "Contact rating changed",
      detail: isStarValue(rating, 0)
        ? rating === 0
          ? "Rating cleared"
          : `${rating} of 5 stars`
        : null,
    };
  }
  return { title: "Subscriber activity recorded", detail: null };
}

/**
 * Tenant-wide sweep: writes derived stars for every subscriber WITHOUT a
 * manual rating. Manual ratings are never overwritten. One attempt — a
 * workspace-wide write is never silently replayed.
 */
export async function recomputeContactRatingsTenantWide(
  options: DetailMutationOptions = {},
): Promise<ContactRatingRecomputeResult> {
  const raw = await api.post<unknown>(
    "/api/v1/contact-ratings/recompute",
    {},
    {
      requireOnline: true,
      maxAttempts: 1,
      timeoutMs: 30_000,
      idempotencyKey:
        options.idempotencyKey ?? newDetailMutationKey("contact-rating-recompute"),
      signal: options.signal,
    },
  );
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.updated) ||
    !Number.isSafeInteger(raw.scanned) ||
    !Number.isSafeInteger(raw.window_days) ||
    Number(raw.updated) < 0 ||
    Number(raw.updated) > Number(raw.scanned) ||
    !isTimestamp(raw.started_at) ||
    !isTimestamp(raw.finished_at)
  ) {
    throw new SubscriberDetailContractError(
      "The rating recompute returned an incomplete result.",
    );
  }
  return {
    updated: Number(raw.updated),
    scanned: Number(raw.scanned),
    window_days: Number(raw.window_days),
    started_at: raw.started_at,
    finished_at: raw.finished_at,
  };
}

/* ========================= DSAR data-export bundle ======================== */

/** Reviewed ceiling for the in-browser DSAR bundle (the API builds it inline). */
export const SUBSCRIBER_DATA_EXPORT_MAX_BYTES = 64 * 1024 * 1024;

export interface SubscriberDataExport {
  blob: Blob;
  filename: string;
}

/**
 * Downloads the subscriber's DSAR (GDPR Art. 15 / CCPA) ZIP. Binary-safe: the
 * bytes are never decoded as text. The server audits every export
 * (`subscriber.data_export`) and persists the disclosed snapshot.
 */
export async function downloadSubscriberDataExport(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberDataExport> {
  const segment = subscriberSegment(subscriberId);
  const download = await fetchBlobAuthed(
    `/api/v1/subscribers/${segment}/data-export.zip`,
    {
      accept: "application/zip",
      maxBytes: SUBSCRIBER_DATA_EXPORT_MAX_BYTES,
      signal,
    },
  );
  if (download.blob.size === 0) {
    throw new SubscriberDetailContractError(
      "The data export came back empty. Nothing was saved; try again.",
    );
  }
  const filename =
    download.filename && /\.zip$/i.test(download.filename)
      ? download.filename
      : `subscriber-${segment}-data-export-${new Date().toISOString().slice(0, 10)}.zip`;
  return { blob: download.blob, filename };
}
