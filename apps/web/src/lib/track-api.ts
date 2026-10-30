// SPDX-License-Identifier: AGPL-3.0-only

import { api, fetchTextAuthed } from "@/lib/api";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_EVENT_NAME_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_PROPERTY_DEPTH = 12;
const MAX_PROPERTY_NODES = 5_000;
const MAX_PROPERTY_KEY_LENGTH = 256;
const MAX_PROPERTY_STRING_LENGTH = 64 * 1024;
const MAX_EVENT_PROPERTY_BYTES = 512 * 1024;
const MAX_COMPOSER_PROPERTY_BYTES = 64 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_PROPERTY_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const EVENT_NAME_PATTERN =
  /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/;

export type TrackJsonValue =
  | null
  | boolean
  | number
  | string
  | TrackJsonValue[]
  | { [key: string]: TrackJsonValue };

export type TrackProperties = Record<string, TrackJsonValue>;

export interface TrackDailyPoint {
  date: string;
  count: number;
}

export interface TrackStats {
  periodDays: number;
  totalEvents: number;
  uniqueSubscribers: number;
  uniqueEventNames: number;
  daily: TrackDailyPoint[];
  timeZone: "UTC";
  asOf: string;
}

export interface TrackCatalogItem {
  eventName: string;
  count: number;
  uniqueSubscribers: number;
  firstSeen: string;
  lastSeen: string;
  daily: TrackDailyPoint[];
}

export interface TrackCatalog {
  items: TrackCatalogItem[];
  totalDistinctEventNames: number;
  periodDays: number;
  dailySeriesPeriodDays: number;
  eventBoundsScope: "period";
  timeZone: "UTC";
  asOf: string;
}

export interface TrackEvent {
  id: number;
  tenantId: string;
  subscriberId: string;
  eventName: string;
  properties: TrackProperties;
  occurredAt: string;
  receivedAt: string;
}

export interface TrackEventsPage {
  items: TrackEvent[];
  requestedLimit: number;
  atLimit: boolean;
}

export interface TrackEventFilters {
  eventName?: string;
  subscriberId?: string;
  before?: string;
  limit?: number;
}

export interface TrackCsvExport {
  csv: string;
  truncated: boolean;
  serverLimit: number;
}

export interface SyntheticTrackEventInput {
  subscriberId: string;
  eventName: string;
  properties: TrackProperties;
  eventId: string;
}

export interface SyntheticTrackEventReceipt {
  id: number;
  subscriberId: string;
  eventId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeString(
  value: unknown,
  maxLength: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    (allowEmpty || value.trim().length > 0)
  );
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function timestamp(value: unknown): value is string {
  return (
    safeString(value, MAX_TIMESTAMP_LENGTH) &&
    Number.isFinite(Date.parse(value))
  );
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneJson(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): TrackJsonValue | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_PROPERTY_NODES || depth > MAX_PROPERTY_DEPTH) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length <= MAX_PROPERTY_STRING_LENGTH ? value : undefined;
  }
  if (Array.isArray(value)) {
    const output: TrackJsonValue[] = [];
    for (const item of value) {
      const cloned = cloneJson(item, state, depth + 1);
      if (cloned === undefined) return undefined;
      output.push(cloned);
    }
    return output;
  }
  const source = record(value);
  if (!source) return undefined;
  const output: Record<string, TrackJsonValue> = Object.create(null) as Record<
    string,
    TrackJsonValue
  >;
  for (const [key, item] of Object.entries(source)) {
    if (
      !safeString(key, MAX_PROPERTY_KEY_LENGTH) ||
      FORBIDDEN_PROPERTY_KEYS.has(key)
    ) {
      return undefined;
    }
    const cloned = cloneJson(item, state, depth + 1);
    if (cloned === undefined) return undefined;
    output[key] = cloned;
  }
  return output;
}

export function normalizeTrackProperties(
  value: unknown,
  maxBytes = MAX_EVENT_PROPERTY_BYTES,
): TrackProperties | null {
  const source = record(value);
  if (!source) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(source);
  } catch {
    return null;
  }
  if (bytes(serialized) > maxBytes) return null;
  const cloned = cloneJson(source, { nodes: 0 });
  return record(cloned) ? (cloned as TrackProperties) : null;
}

function parseDaily(
  value: unknown,
  expectedDays: number,
): TrackDailyPoint[] | null {
  if (!Array.isArray(value) || value.length !== expectedDays) return null;
  const output: TrackDailyPoint[] = [];
  let previous: number | null = null;
  for (const item of value) {
    const row = record(item);
    if (!row || !/^\d{4}-\d{2}-\d{2}$/.test(String(row.date))) return null;
    const at = Date.parse(`${String(row.date)}T00:00:00.000Z`);
    if (
      !Number.isFinite(at) ||
      (previous !== null && at - previous !== 86_400_000) ||
      !safeCount(row.count)
    ) {
      return null;
    }
    previous = at;
    output.push({ date: String(row.date), count: row.count });
  }
  return output;
}

function validDays(value: number | undefined): number {
  if (value === undefined) return 30;
  if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
    throw new Error("Reporting period must be between 1 and 365 days.");
  }
  return value;
}

export function parseTrackStats(payload: unknown): TrackStats {
  const row = record(payload);
  if (
    !row ||
    !safeCount(row.periodDays) ||
    row.periodDays < 1 ||
    row.periodDays > 365 ||
    !safeCount(row.totalEvents) ||
    !safeCount(row.uniqueSubscribers) ||
    !safeCount(row.uniqueEventNames) ||
    row.uniqueSubscribers > row.totalEvents ||
    row.uniqueEventNames > row.totalEvents ||
    row.timeZone !== "UTC" ||
    !timestamp(row.asOf)
  ) {
    throw new Error("Product-event statistics response was malformed.");
  }
  const daily = parseDaily(row.daily, row.periodDays);
  if (!daily || daily.at(-1)?.date !== row.asOf.slice(0, 10)) {
    throw new Error("Product-event statistics daily series was malformed.");
  }
  const dailyTotal = daily.reduce((sum, point) => sum + point.count, 0);
  if (!Number.isSafeInteger(dailyTotal) || dailyTotal !== row.totalEvents) {
    throw new Error("Product-event statistics totals did not reconcile.");
  }
  return {
    periodDays: row.periodDays,
    totalEvents: row.totalEvents,
    uniqueSubscribers: row.uniqueSubscribers,
    uniqueEventNames: row.uniqueEventNames,
    daily,
    timeZone: "UTC",
    asOf: row.asOf,
  };
}

export function parseTrackCatalog(payload: unknown): TrackCatalog {
  const row = record(payload);
  if (
    !row ||
    !Array.isArray(row.items) ||
    row.items.length > 200 ||
    !safeCount(row.totalDistinctEventNames) ||
    row.totalDistinctEventNames < row.items.length ||
    !safeCount(row.periodDays) ||
    row.periodDays < 1 ||
    row.periodDays > 365 ||
    !safeCount(row.dailySeriesPeriodDays) ||
    row.dailySeriesPeriodDays < 1 ||
    row.dailySeriesPeriodDays > 365 ||
    row.eventBoundsScope !== "period" ||
    row.timeZone !== "UTC" ||
    !timestamp(row.asOf)
  ) {
    throw new Error("Product-event catalogue response was malformed.");
  }
  const items: TrackCatalogItem[] = [];
  const names = new Set<string>();
  for (const item of row.items) {
    const source = record(item);
    if (
      !source ||
      !safeString(source.eventName, MAX_EVENT_NAME_LENGTH) ||
      names.has(source.eventName) ||
      !safeCount(source.count) ||
      !safeCount(source.uniqueSubscribers) ||
      source.uniqueSubscribers > source.count ||
      !timestamp(source.firstSeen) ||
      !timestamp(source.lastSeen) ||
      Date.parse(source.firstSeen) > Date.parse(source.lastSeen) ||
      Date.parse(source.lastSeen) > Date.parse(row.asOf)
    ) {
      throw new Error("Product-event catalogue contained an invalid row.");
    }
    const daily = parseDaily(source.daily, row.dailySeriesPeriodDays);
    if (!daily || daily.at(-1)?.date !== row.asOf.slice(0, 10)) {
      throw new Error("Product-event catalogue daily series was malformed.");
    }
    const dailyTotal = daily.reduce((sum, point) => sum + point.count, 0);
    if (!Number.isSafeInteger(dailyTotal) || dailyTotal > source.count) {
      throw new Error("Product-event catalogue totals did not reconcile.");
    }
    names.add(source.eventName);
    items.push({
      eventName: source.eventName,
      count: source.count,
      uniqueSubscribers: source.uniqueSubscribers,
      firstSeen: source.firstSeen,
      lastSeen: source.lastSeen,
      daily,
    });
  }
  return {
    items,
    totalDistinctEventNames: row.totalDistinctEventNames,
    periodDays: row.periodDays,
    dailySeriesPeriodDays: row.dailySeriesPeriodDays,
    eventBoundsScope: "period",
    timeZone: "UTC",
    asOf: row.asOf,
  };
}

export function parseTrackEvents(
  payload: unknown,
  expectedTenantId: string,
  requestedLimit: number,
): TrackEventsPage {
  const envelope = record(payload);
  if (
    !envelope ||
    !Array.isArray(envelope.items) ||
    envelope.items.length > requestedLimit
  ) {
    throw new Error("Product-event feed response was malformed.");
  }
  const items: TrackEvent[] = [];
  const ids = new Set<number>();
  let previousOccurred = Number.POSITIVE_INFINITY;
  for (const item of envelope.items) {
    const row = record(item);
    const properties = row
      ? normalizeTrackProperties(row.properties, MAX_EVENT_PROPERTY_BYTES)
      : null;
    if (
      !row ||
      !Number.isSafeInteger(row.id) ||
      Number(row.id) <= 0 ||
      ids.has(Number(row.id)) ||
      row.tenantId !== expectedTenantId ||
      !safeString(row.subscriberId, MAX_IDENTIFIER_LENGTH) ||
      !safeString(row.eventName, MAX_EVENT_NAME_LENGTH) ||
      !timestamp(row.occurredAt) ||
      !timestamp(row.receivedAt) ||
      !properties
    ) {
      throw new Error("Product-event feed contained an invalid row.");
    }
    const occurred = Date.parse(row.occurredAt);
    if (occurred > previousOccurred) {
      throw new Error("Product-event feed ordering could not be verified.");
    }
    previousOccurred = occurred;
    ids.add(Number(row.id));
    items.push({
      id: Number(row.id),
      tenantId: row.tenantId,
      subscriberId: row.subscriberId,
      eventName: row.eventName,
      properties,
      occurredAt: row.occurredAt,
      receivedAt: row.receivedAt,
    });
  }
  return { items, requestedLimit, atLimit: items.length === requestedLimit };
}

export function parseTrackPropertiesJson(raw: string): TrackProperties {
  if (bytes(raw) > MAX_COMPOSER_PROPERTY_BYTES) {
    throw new Error("Event properties must be 64 KiB or smaller.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Event properties must be valid JSON.");
  }
  const properties = normalizeTrackProperties(
    parsed,
    MAX_COMPOSER_PROPERTY_BYTES,
  );
  if (!properties) {
    throw new Error(
      "Event properties must be a bounded JSON object without unsafe property names.",
    );
  }
  return properties;
}

export function validateSyntheticTrackEvent(
  input: SyntheticTrackEventInput,
): SyntheticTrackEventInput {
  const subscriberId = input.subscriberId.trim();
  const eventName = input.eventName.trim();
  const eventId = input.eventId.trim();
  if (!safeString(subscriberId, MAX_IDENTIFIER_LENGTH)) {
    throw new Error("A bounded subscriber ID is required.");
  }
  if (
    !safeString(eventName, MAX_EVENT_NAME_LENGTH) ||
    !EVENT_NAME_PATTERN.test(eventName)
  ) {
    throw new Error(
      "Event name must use lowercase snake_case segments separated by dots.",
    );
  }
  if (!safeString(eventId, 128)) {
    throw new Error("A stable event idempotency ID is required.");
  }
  const properties = normalizeTrackProperties(
    input.properties,
    MAX_COMPOSER_PROPERTY_BYTES,
  );
  if (!properties) throw new Error("Event properties are not safe to send.");
  return { subscriberId, eventName, eventId, properties };
}

export async function getTrackStats(
  options: {
    days?: number;
    eventName?: string;
    signal?: AbortSignal;
  } = {},
): Promise<TrackStats> {
  const days = validDays(options.days);
  const response = await api.get<unknown>("/api/v1/track/stats", {
    query: {
      days,
      event_name: options.eventName?.trim() || undefined,
    },
    signal: options.signal,
  });
  const parsed = parseTrackStats(response);
  if (parsed.periodDays !== days) {
    throw new Error(
      "Product-event statistics period did not match the request.",
    );
  }
  return parsed;
}

export async function getTrackCatalog(
  options: {
    days?: number;
    signal?: AbortSignal;
  } = {},
): Promise<TrackCatalog> {
  const days = validDays(options.days);
  const response = await api.get<unknown>("/api/v1/track/catalog", {
    query: { days },
    signal: options.signal,
  });
  const parsed = parseTrackCatalog(response);
  if (parsed.periodDays !== days) {
    throw new Error(
      "Product-event catalogue period did not match the request.",
    );
  }
  return parsed;
}

function normalizedFilters(
  filters: TrackEventFilters,
): Required<Pick<TrackEventFilters, "limit">> &
  Omit<TrackEventFilters, "limit"> {
  const limit = filters.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Product-event page size must be between 1 and 200.");
  }
  const eventName = filters.eventName?.trim() || undefined;
  const subscriberId = filters.subscriberId?.trim() || undefined;
  const before = filters.before?.trim() || undefined;
  if (eventName && !safeString(eventName, MAX_EVENT_NAME_LENGTH)) {
    throw new Error("Event-name filter is invalid.");
  }
  if (subscriberId && !safeString(subscriberId, MAX_IDENTIFIER_LENGTH)) {
    throw new Error("Subscriber filter is invalid.");
  }
  if (before && !timestamp(before)) {
    throw new Error("Before-time filter must be an RFC3339 timestamp.");
  }
  return { eventName, subscriberId, before, limit };
}

export async function listTrackEvents(options: {
  tenantId: string;
  filters?: TrackEventFilters;
  signal?: AbortSignal;
}): Promise<TrackEventsPage> {
  const filters = normalizedFilters(options.filters ?? {});
  const response = await api.get<unknown>("/api/v1/track/events", {
    query: {
      event_name: filters.eventName,
      subscriber_id: filters.subscriberId,
      before: filters.before,
      limit: filters.limit,
    },
    signal: options.signal,
  });
  return parseTrackEvents(response, options.tenantId, filters.limit);
}

export async function exportTrackEventsCsv(
  options: {
    filters?: Omit<TrackEventFilters, "before" | "limit"> & {
      occurredAfter?: string;
      limit?: number;
    };
    signal?: AbortSignal;
  } = {},
): Promise<TrackCsvExport> {
  const limit = options.filters?.limit ?? 10_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("CSV export size must be between 1 and 10,000 rows.");
  }
  const eventName = options.filters?.eventName?.trim() || undefined;
  const subscriberId = options.filters?.subscriberId?.trim() || undefined;
  const occurredAfter = options.filters?.occurredAfter?.trim() || undefined;
  if (eventName && !safeString(eventName, MAX_EVENT_NAME_LENGTH)) {
    throw new Error("Event-name export filter is invalid.");
  }
  if (subscriberId && !safeString(subscriberId, MAX_IDENTIFIER_LENGTH)) {
    throw new Error("Subscriber export filter is invalid.");
  }
  if (occurredAfter && !timestamp(occurredAfter)) {
    throw new Error("Export start time must be an RFC3339 timestamp.");
  }
  const params = new URLSearchParams();
  if (eventName) params.set("event_name", eventName);
  if (subscriberId) params.set("subscriber_id", subscriberId);
  if (occurredAfter) params.set("occurred_after", occurredAfter);
  params.set("limit", String(limit));
  let contentType = "";
  let truncated = false;
  let serverLimit = limit;
  const csv = await fetchTextAuthed(
    `/api/v1/track/events.csv?${params.toString()}`,
    {
      signal: options.signal,
      maxBytes: MAX_EXPORT_BYTES,
      onResponse: (response) => {
        if (!response.ok) return;
        contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        truncated = response.headers.get("x-postwave-truncated") === "true";
        const rawLimit = Number(
          response.headers.get("x-postwave-export-limit"),
        );
        if (
          Number.isSafeInteger(rawLimit) &&
          rawLimit > 0 &&
          rawLimit <= 10_000
        ) {
          serverLimit = rawLimit;
        }
      },
    },
  );
  if (!contentType.startsWith("text/csv")) {
    throw new Error(
      "Product-event export returned an unexpected content type.",
    );
  }
  if (
    !csv.startsWith(
      "id,occurred_at,received_at,subscriber_id,event_name,properties_json",
    )
  ) {
    throw new Error("Product-event export header could not be verified.");
  }
  return { csv, truncated, serverLimit };
}

// ---------------------------------------------------------------------------
// Subscriber investigation scope
//
// The feed, live tail and export filter on the opaque `subscriber_id` the
// server stores. Operators know people by email, so an email is resolved to
// that ID through the ordinary subscriber directory (GET /api/v1/subscribers,
// `q` search, bounded page) and must match EXACTLY (case-insensitive) — a
// fuzzy first hit would silently scope the investigation to someone else.
// ---------------------------------------------------------------------------

const MAX_EMAIL_LENGTH = 320;
const SUBSCRIBER_LOOKUP_PAGE = 5;
const RECENT_SUBSCRIBERS_PAGE = 8;

export interface TrackSubscriberChoice {
  id: string;
  email: string;
}

export interface TrackSubscriberScope {
  id: string;
  label: string;
}

export function parseTrackSubscriberChoices(
  payload: unknown,
  maxRows: number,
): TrackSubscriberChoice[] {
  const envelope = record(payload);
  const items = envelope?.items;
  if (!Array.isArray(items) || items.length > maxRows) {
    throw new Error(
      "The subscriber lookup response could not be verified. Retry before changing the filter.",
    );
  }
  const output: TrackSubscriberChoice[] = [];
  for (const item of items) {
    const row = record(item);
    const id =
      typeof row?.id === "number" && Number.isSafeInteger(row.id)
        ? String(row.id)
        : row?.id;
    if (
      !row ||
      !safeString(id, MAX_IDENTIFIER_LENGTH) ||
      id.trim() !== id ||
      !safeString(row.email, MAX_EMAIL_LENGTH)
    ) {
      throw new Error(
        "The subscriber lookup response contained an invalid row. Retry before changing the filter.",
      );
    }
    output.push({ id, email: row.email });
  }
  return output;
}

export async function lookupTrackSubscribersByEmail(
  email: string,
  signal?: AbortSignal,
): Promise<TrackSubscriberChoice[]> {
  const response = await api.get<unknown>("/api/v1/subscribers", {
    query: { q: email, per_page: SUBSCRIBER_LOOKUP_PAGE },
    signal,
  });
  return parseTrackSubscriberChoices(response, SUBSCRIBER_LOOKUP_PAGE);
}

export async function listRecentTrackSubscribers(
  signal?: AbortSignal,
): Promise<TrackSubscriberChoice[]> {
  const response = await api.get<unknown>("/api/v1/subscribers", {
    query: { per_page: RECENT_SUBSCRIBERS_PAGE },
    signal,
  });
  return parseTrackSubscriberChoices(response, RECENT_SUBSCRIBERS_PAGE);
}

/**
 * Resolve "subscriber ID or email" input into the feed's subscriber scope.
 * Throws an Error whose message is the sentence to render.
 */
export async function resolveTrackSubscriberScope(
  input: string,
  signal?: AbortSignal,
): Promise<TrackSubscriberScope> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Enter a subscriber ID or email address.");
  if (!safeString(trimmed, MAX_IDENTIFIER_LENGTH)) {
    throw new Error(
      "Enter an ID or email without control characters (512 characters maximum).",
    );
  }
  if (!trimmed.includes("@")) return { id: trimmed, label: trimmed };
  if (trimmed.length > MAX_EMAIL_LENGTH) {
    throw new Error("Email addresses must be 320 characters or fewer.");
  }
  const choices = await lookupTrackSubscribersByEmail(trimmed, signal);
  const wanted = trimmed.toLowerCase();
  const match = choices.find((choice) => choice.email.toLowerCase() === wanted);
  if (!match) {
    throw new Error(
      "No subscriber matched that email address. Check the spelling or enter a subscriber ID.",
    );
  }
  return { id: match.id, label: match.email };
}

export async function sendSyntheticTrackEvent(
  rawInput: SyntheticTrackEventInput,
): Promise<SyntheticTrackEventReceipt> {
  const input = validateSyntheticTrackEvent(rawInput);
  const response = await api.post<unknown>(
    "/api/v1/track",
    {
      subscriber_id: input.subscriberId,
      event_name: input.eventName,
      event_id: input.eventId,
      properties: input.properties,
    },
    {
      requireOnline: true,
      maxAttempts: 1,
      idempotencyKey: input.eventId,
    },
  );
  const receipt = record(response);
  if (
    !receipt ||
    !Number.isSafeInteger(receipt.id) ||
    Number(receipt.id) <= 0 ||
    receipt.subscriber_id !== input.subscriberId
  ) {
    throw new Error(
      "The event may have been accepted, but its receipt could not be verified. Retry with the same retained event ID before creating another.",
    );
  }
  return {
    id: Number(receipt.id),
    subscriberId: input.subscriberId,
    eventId: input.eventId,
  };
}
