import type {
  ConversionRow,
  ConversionTrackingKey,
  ProductEvent,
  ProductEventCatalogRow,
  ProductEventCatalogResponse,
  ProductEventStatsResponse,
  Subscriber,
} from "../../lib/api-client";
import {
  type RemoteApiError,
  type RemoteFailure,
  remoteFailureFromError,
} from "../../lib/remote-resource";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_EVENT_NAME_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(
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

function isOptionalBoundedString(
  value: unknown,
  maxLength: number,
): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    isBoundedString(value, maxLength, true)
  );
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    isBoundedString(value, MAX_TIMESTAMP_LENGTH) &&
    Number.isFinite(Date.parse(value))
  );
}

function isEventId(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    isBoundedString(value, MAX_IDENTIFIER_LENGTH)
  );
}

export function isProductEvent(value: unknown): value is ProductEvent {
  if (!isRecord(value) || !isEventId(value.id)) return false;
  const eventName = value.eventName ?? value.event_name;
  if (!isBoundedString(eventName, MAX_EVENT_NAME_LENGTH)) return false;
  if (
    typeof value.eventName === "string" &&
    typeof value.event_name === "string" &&
    value.eventName !== value.event_name
  ) {
    return false;
  }
  if (
    typeof value.subscriberId === "string" &&
    typeof value.subscriber_id === "string" &&
    value.subscriberId !== value.subscriber_id
  ) {
    return false;
  }
  if (
    !isOptionalBoundedString(value.subscriberId, MAX_IDENTIFIER_LENGTH) ||
    !isOptionalBoundedString(value.subscriber_id, MAX_IDENTIFIER_LENGTH) ||
    !isOptionalBoundedString(value.subscriber_email, MAX_IDENTIFIER_LENGTH) ||
    !isOptionalBoundedString(value.occurredAt, MAX_TIMESTAMP_LENGTH) ||
    !isOptionalBoundedString(value.occurred_at, MAX_TIMESTAMP_LENGTH) ||
    !isOptionalBoundedString(value.receivedAt, MAX_TIMESTAMP_LENGTH) ||
    !isOptionalBoundedString(value.received_at, MAX_TIMESTAMP_LENGTH)
  ) {
    return false;
  }
  return (
    value.properties === undefined ||
    value.properties === null ||
    isRecord(value.properties)
  );
}

function payloadList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return null;
  for (const key of ["items", "data", "results"] as const) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return null;
}

/** Null means the wire shape was unverified; [] means a verified empty list. */
export function parseProductEvents(payload: unknown): ProductEvent[] | null {
  const rows = payloadList(payload);
  return rows && rows.length <= 200 && rows.every(isProductEvent) ? rows : null;
}

function isSubscriberChoice(value: unknown): value is Subscriber {
  return (
    isRecord(value) &&
    isBoundedString(value.email, 320) &&
    (value.id === undefined || isBoundedString(value.id, MAX_IDENTIFIER_LENGTH))
  );
}

/** Only fields used by the picker are required; adjacent API versions vary. */
export function parseSubscriberChoices(payload: unknown): Subscriber[] | null {
  const rows = payloadList(payload);
  return rows && rows.length <= 100 && rows.every(isSubscriberChoice)
    ? rows
    : null;
}

function isDailyBucket(value: unknown): boolean {
  return (
    isRecord(value) &&
    isTimestamp(value.date) &&
    isFiniteNonNegative(value.count)
  );
}

function isDenseUTCDailySeries(
  value: unknown,
  expectedDays: number,
  asOf: string,
): boolean {
  if (!Array.isArray(value) || value.length !== expectedDays) return false;
  const expectedLastDate = new Date(asOf).toISOString().slice(0, 10);
  let previousTimestamp: number | null = null;
  for (const bucket of value) {
    if (!isDailyBucket(bucket) || !/^\d{4}-\d{2}-\d{2}$/.test(bucket.date)) {
      return false;
    }
    const timestamp = Date.parse(`${bucket.date}T00:00:00.000Z`);
    if (
      !Number.isFinite(timestamp) ||
      (previousTimestamp !== null &&
        timestamp - previousTimestamp !== 24 * 60 * 60 * 1_000)
    ) {
      return false;
    }
    previousTimestamp = timestamp;
  }
  return value.at(-1)?.date === expectedLastDate;
}

function isCatalogRow(
  value: unknown,
  dailySeriesPeriodDays: number,
  asOf: string,
): value is ProductEventCatalogRow {
  return (
    isRecord(value) &&
    isBoundedString(value.eventName, MAX_EVENT_NAME_LENGTH) &&
    isFiniteNonNegative(value.count) &&
    isFiniteNonNegative(value.uniqueSubscribers) &&
    isTimestamp(value.firstSeen) &&
    isTimestamp(value.lastSeen) &&
    isDenseUTCDailySeries(value.daily, dailySeriesPeriodDays, asOf)
  );
}

export function parseProductEventCatalog(
  payload: unknown,
): ProductEventCatalogResponse | null {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 200 ||
    !isFiniteNonNegative(payload.totalDistinctEventNames) ||
    payload.totalDistinctEventNames < payload.items.length ||
    !isFiniteNonNegative(payload.periodDays) ||
    payload.periodDays < 1 ||
    payload.periodDays > 365 ||
    !isFiniteNonNegative(payload.dailySeriesPeriodDays) ||
    payload.dailySeriesPeriodDays < 1 ||
    payload.dailySeriesPeriodDays > 365 ||
    payload.eventBoundsScope !== "period" ||
    payload.timeZone !== "UTC" ||
    !isTimestamp(payload.asOf)
  ) {
    return null;
  }
  const dailySeriesPeriodDays = payload.dailySeriesPeriodDays;
  const asOf = payload.asOf;
  if (
    !payload.items.every((row) =>
      isCatalogRow(row, dailySeriesPeriodDays, asOf),
    )
  ) {
    return null;
  }
  return payload as unknown as ProductEventCatalogResponse;
}

export function parseProductEventStats(
  payload: unknown,
): ProductEventStatsResponse | null {
  if (!isRecord(payload)) return null;
  if (
    !isFiniteNonNegative(payload.periodDays) ||
    payload.periodDays < 1 ||
    payload.periodDays > 365 ||
    !isFiniteNonNegative(payload.totalEvents) ||
    !isFiniteNonNegative(payload.uniqueSubscribers) ||
    !isFiniteNonNegative(payload.uniqueEventNames) ||
    payload.timeZone !== "UTC" ||
    !isTimestamp(payload.asOf) ||
    !isDenseUTCDailySeries(payload.daily, payload.periodDays, payload.asOf)
  ) {
    return null;
  }
  return payload as unknown as ProductEventStatsResponse;
}

function isConversionRow(value: unknown): value is ConversionRow {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    isBoundedString(value.tenant_id, MAX_IDENTIFIER_LENGTH) &&
    isBoundedString(value.event_name, MAX_EVENT_NAME_LENGTH) &&
    isOptionalBoundedString(value.subscriber_email, 320) &&
    (value.amount_cents === undefined ||
      value.amount_cents === null ||
      (typeof value.amount_cents === "number" &&
        Number.isSafeInteger(value.amount_cents))) &&
    isOptionalBoundedString(value.currency, 16) &&
    isOptionalBoundedString(value.campaign_id, MAX_IDENTIFIER_LENGTH) &&
    (value.attributed_via === undefined ||
      value.attributed_via === "explicit" ||
      value.attributed_via === "last_touch" ||
      value.attributed_via === "none" ||
      value.attributed_via === "code_redemption" ||
      value.attributed_via === "campaign_vanity_path") &&
    isRecord(value.properties) &&
    isTimestamp(value.occurred_at)
  );
}

export function parseConversionRows(payload: unknown): ConversionRow[] | null {
  return Array.isArray(payload) &&
    payload.length <= 50 &&
    payload.every(isConversionRow)
    ? payload
    : null;
}

function isTrackingKey(value: unknown): value is ConversionTrackingKey {
  return (
    isRecord(value) &&
    isBoundedString(value.id, MAX_IDENTIFIER_LENGTH) &&
    isBoundedString(value.tenant_id, MAX_IDENTIFIER_LENGTH) &&
    isBoundedString(value.label, 120) &&
    isBoundedString(value.prefix, 128, true) &&
    (value.revoked_at === undefined ||
      value.revoked_at === null ||
      isTimestamp(value.revoked_at)) &&
    isTimestamp(value.created_at)
  );
}

export function parseConversionKeys(
  payload: unknown,
): ConversionTrackingKey[] | null {
  return Array.isArray(payload) &&
    payload.length <= 1_000 &&
    payload.every(isTrackingKey)
    ? payload
    : null;
}

export function parseCreatedSecret(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return isBoundedString(payload.plaintext, 4_096) ? payload.plaintext : null;
}

export function isConfirmedRevocation(payload: unknown): boolean {
  return isRecord(payload) && payload.ok === true;
}

/** A write may have committed when its acknowledgement was lost or invalid. */
export function isUncertainMutationFailure(error: RemoteApiError): boolean {
  const code = error.code?.trim().toLowerCase();
  if (error.kind === "network") {
    return code !== "offline" && code !== "aborted";
  }
  return (
    error.kind === "parse" ||
    error.kind === "timeout" ||
    error.status === 408 ||
    (error.status !== undefined && error.status >= 500)
  );
}

export function safeTrackFailure(
  error: RemoteApiError,
  fallback: string,
): string {
  const failure = remoteFailureFromError(error);
  const message =
    failure.message === "The server could not verify this data."
      ? fallback
      : failure.message;
  const diagnostics = [
    failure.code ? `Code: ${failure.code}.` : "",
    failure.requestId ? `Reference: ${failure.requestId}.` : "",
  ].filter(Boolean);
  return [message, ...diagnostics].join(" ");
}

export function safeRemoteFailureText(failure: RemoteFailure): string {
  return [
    failure.message,
    failure.code ? `Code: ${failure.code}.` : "",
    failure.requestId ? `Reference: ${failure.requestId}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function boundedJsonPreview(value: unknown, maxLength = 4_000): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (!serialized) return "No properties recorded.";
    if (serialized.length <= maxLength) return serialized;
    return `${serialized.slice(0, maxLength)}\n… Preview truncated at ${maxLength.toLocaleString()} characters.`;
  } catch {
    return "Properties could not be displayed safely.";
  }
}

export function safeAbsoluteTime(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "Invalid timestamp";
  return timestamp.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}
