import type {
  Tag,
  TagGroup,
  TagMembership,
  TagMembershipBucket,
  TagSubscriber,
  TagSuggestion,
  TagUsage,
} from "../../lib/api-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runeLength(value: string): number {
  return Array.from(value).length;
}

function boundedText(
  value: unknown,
  options: { min?: number; max: number; trimmed?: boolean },
): value is string {
  if (typeof value !== "string") return false;
  const length = runeLength(value);
  return (
    length >= (options.min ?? 0) &&
    length <= options.max &&
    (!options.trimmed || value.trim() === value)
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function optionalUuid(value: unknown): boolean {
  return value === undefined || value === null || value === "" || uuid(value);
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || value === null || timestamp(value);
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads deliberately preserve the bounded pre-1774 envelope. New writes are
 * validated by their forms and by the API, but rejecting an old colour here
 * would hide the entire verified catalogue instead of showing its provenance.
 */
function legacyTagColor(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    boundedText(value, { max: 32 })
  );
}

function legacyName(value: unknown): value is string {
  return (
    boundedText(value, { min: 1, max: 100 }) && runeLength(value.trim()) >= 1
  );
}

function exactTagEtag(value: unknown, id: string, version: number): boolean {
  return value === `"tag:${id}:v${version}"`;
}

export function isTag(value: unknown): value is Tag {
  if (!isRecord(value) || !uuid(value.id)) return false;
  return (
    legacyName(value.name) &&
    legacyTagColor(value.color) &&
    boundedText(value.description, { max: 4_096 }) &&
    timestamp(value.created_at) &&
    optionalUuid(value.created_by) &&
    timestamp(value.updated_at) &&
    optionalUuid(value.updated_by) &&
    optionalTimestamp(value.archived_at) &&
    typeof value.pii === "boolean" &&
    optionalUuid(value.group_id) &&
    safeCount(value.version) &&
    value.version > 0 &&
    exactTagEtag(value.etag, value.id, value.version)
  );
}

export function isTagGroup(value: unknown): value is TagGroup {
  if (!isRecord(value)) return false;
  return (
    uuid(value.id) &&
    legacyName(value.name) &&
    legacyTagColor(value.color) &&
    Number.isSafeInteger(value.sort_order) &&
    timestamp(value.created_at)
  );
}

export function isTagUsage(value: unknown): value is TagUsage {
  if (!isRecord(value)) return false;
  return (
    legacyName(value.tag) &&
    safeCount(value.subscribers) &&
    typeof value.registered === "boolean" &&
    optionalTimestamp(value.created_at)
  );
}

export function isTagSuggestion(value: unknown): value is TagSuggestion {
  if (!isRecord(value)) return false;
  return (
    legacyName(value.tag) &&
    safeCount(value.subscribers) &&
    typeof value.registered === "boolean"
  );
}

export function isTagSubscriber(value: unknown): value is TagSubscriber {
  if (!isRecord(value)) return false;
  return (
    uuid(value.id) &&
    boundedText(value.email, { min: 3, max: 320, trimmed: true }) &&
    boundedText(value.status, { min: 1, max: 64, trimmed: true }) &&
    timestamp(value.created_at)
  );
}

function membershipBucket(value: unknown): value is TagMembershipBucket {
  if (!isRecord(value)) return false;
  if (typeof value.date !== "string" || !DATE_RE.test(value.date)) return false;
  const [year, month, day] = value.date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day &&
    typeof value.net === "number" &&
    Number.isSafeInteger(value.net)
  );
}

function exactNetTotal(daily: TagMembershipBucket[]): number | null {
  let total = 0;
  for (const bucket of daily) {
    total += bucket.net;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function isTagMembership(value: unknown): value is TagMembership {
  if (!isRecord(value) || !isRecord(value.coverage)) return false;
  const daily = value.daily;
  const coverageStart =
    typeof value.coverage.coverage_started_at === "string"
      ? Date.parse(value.coverage.coverage_started_at)
      : Number.NaN;
  const asOf =
    typeof value.coverage.as_of === "string"
      ? Date.parse(value.coverage.as_of)
      : Number.NaN;
  return (
    uuid(value.tag_id) &&
    safeCount(value.days) &&
    value.days >= 1 &&
    value.days <= 365 &&
    safeCount(value.current_count) &&
    safeCount(value.added) &&
    safeCount(value.removed) &&
    Array.isArray(daily) &&
    daily.length <= 366 &&
    daily.every(membershipBucket) &&
    new Set(daily.map((bucket) => bucket.date)).size === daily.length &&
    daily.every(
      (bucket, index) => index === 0 || daily[index - 1]!.date < bucket.date,
    ) &&
    exactNetTotal(daily) === value.added - value.removed &&
    value.coverage.contract_version === "canonical-join-events-v2" &&
    timestamp(value.coverage.coverage_started_at) &&
    timestamp(value.coverage.as_of) &&
    coverageStart <= asOf &&
    daily.every(
      (bucket) =>
        Date.parse(`${bucket.date}T23:59:59.999Z`) >= coverageStart &&
        Date.parse(`${bucket.date}T00:00:00Z`) <= asOf,
    ) &&
    value.coverage.completeness === "complete_from_coverage_start" &&
    value.coverage.source === "subscriber_tags_event_ledger" &&
    typeof value.coverage.requested_window_complete === "boolean"
  );
}
