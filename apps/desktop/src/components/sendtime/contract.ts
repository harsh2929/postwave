import type {
  BestSendTime,
  SchedulePreviewResponse,
  SegmentBestSendTime,
  SegmentHeatmapResponse,
  SubscriberOpenPattern,
} from "../../lib/api-client";

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerIn(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    finiteNumber(value) &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validTimestamp(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "string" && !Number.isNaN(Date.parse(value)))
  );
}

function validRequiredTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !Number.isNaN(Date.parse(value))
  );
}

function optionalBoolean(value: unknown): boolean {
  return value == null || typeof value === "boolean";
}

function hasCoordinatePair(day: unknown, hour: unknown): day is number {
  const dayPresent = day != null;
  const hourPresent = hour != null;
  return (
    dayPresent === hourPresent &&
    (!dayPresent || (integerIn(day, 0, 6) && integerIn(hour, 0, 23)))
  );
}

export function isWeeklyGrid(value: unknown): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === 7 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 24 &&
        row.every((cell) => finiteNumber(cell) && cell >= 0),
    )
  );
}

export function decodeSegmentHeatmap(
  value: unknown,
): SegmentHeatmapResponse | null {
  const candidate = record(value);
  if (
    !candidate ||
    !isWeeklyGrid(candidate.grid) ||
    !integerIn(candidate.subscribers_with_data, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(candidate.best_dow, 0, 6) ||
    !integerIn(candidate.best_hour, 0, 23) ||
    !validRequiredTimestamp(candidate.computed_at) ||
    !optionalBoolean(candidate.has_secondary) ||
    !optionalBoolean(candidate.has_secondary_window) ||
    !hasCoordinatePair(candidate.secondary_dow, candidate.secondary_hour)
  ) {
    return null;
  }
  const secondaryDeclared =
    candidate.has_secondary === true || candidate.has_secondary_window === true;
  const secondaryDenied =
    candidate.has_secondary === false ||
    candidate.has_secondary_window === false;
  const hasSecondaryCoordinates = candidate.secondary_dow != null;
  if (
    (secondaryDeclared && !hasSecondaryCoordinates) ||
    (secondaryDenied && hasSecondaryCoordinates)
  ) {
    return null;
  }
  return value as SegmentHeatmapResponse;
}

export function decodeSegmentBest(value: unknown): SegmentBestSendTime | null {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.best_hour_utc !== "string" ||
    !/^(?:[01]\d|2[0-3]):00$/.test(candidate.best_hour_utc) ||
    !finiteNumber(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    !integerIn(candidate.sample_size, 0, Number.MAX_SAFE_INTEGER) ||
    !validTimestamp(candidate.computed_at) ||
    candidate.computed_at == null
  ) {
    return null;
  }
  return value as SegmentBestSendTime;
}

export function decodeBestSendTime(value: unknown): BestSendTime | null {
  const candidate = record(value);
  if (
    !candidate ||
    !integerIn(candidate.best_hour_utc, -1, 167) ||
    !validRequiredTimestamp(candidate.computed_at) ||
    !integerIn(candidate.sample_size, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  if (candidate.email != null && typeof candidate.email !== "string") {
    return null;
  }
  return value as BestSendTime;
}

export function decodeSubscriberPattern(
  value: unknown,
): SubscriberOpenPattern | null {
  const candidate = record(value);
  if (
    !candidate ||
    !isWeeklyGrid(candidate.grid) ||
    !integerIn(candidate.sample_size, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(candidate.best_dow, 0, 6) ||
    !integerIn(candidate.best_hour, 0, 23) ||
    !validRequiredTimestamp(candidate.computed_at) ||
    !optionalBoolean(candidate.bimodal) ||
    !hasCoordinatePair(candidate.secondary_dow, candidate.secondary_hour)
  ) {
    return null;
  }
  const hasSecondaryCoordinates = candidate.secondary_dow != null;
  if (
    (candidate.bimodal === true && !hasSecondaryCoordinates) ||
    (candidate.bimodal === false && hasSecondaryCoordinates)
  ) {
    return null;
  }
  return value as SubscriberOpenPattern;
}

export function decodeSchedulePreview(
  value: unknown,
): SchedulePreviewResponse | null {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.campaign_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate.campaign_id,
    ) ||
    !integerIn(candidate.scheduled, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(candidate.within_days, 7, 30) ||
    !integerIn(candidate.tenant_mean, 0, 167) ||
    typeof candidate.truncated !== "boolean" ||
    !integerIn(candidate.hard_cap, 1, Number.MAX_SAFE_INTEGER) ||
    (candidate.strategy !== "per_recipient" &&
      candidate.strategy !== "modal_hour") ||
    !validRequiredTimestamp(candidate.reference_at) ||
    !integerIn(candidate.max_per_minute, 0, Number.MAX_SAFE_INTEGER) ||
    !integerIn(candidate.max_per_day, 0, Number.MAX_SAFE_INTEGER) ||
    typeof candidate.peak_day_utc !== "string" ||
    (candidate.peak_day_utc !== "" &&
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.peak_day_utc)) ||
    !integerIn(candidate.tier_cap_today, -1, Number.MAX_SAFE_INTEGER) ||
    typeof candidate.warmup_cap_breach !== "boolean" ||
    !validRequiredTimestamp(candidate.counted_at) ||
    !Array.isArray(candidate.distribution) ||
    candidate.distribution.length !== 24
  ) {
    return null;
  }

  let distributed = 0;
  for (const [hour, rawBucket] of candidate.distribution.entries()) {
    const bucket = record(rawBucket);
    if (
      !bucket ||
      bucket.hour !== hour ||
      !integerIn(bucket.count, 0, Number.MAX_SAFE_INTEGER)
    ) {
      return null;
    }
    distributed += bucket.count as number;
  }

  if (
    distributed !== candidate.scheduled ||
    candidate.max_per_minute > candidate.scheduled ||
    candidate.max_per_day > candidate.scheduled ||
    (candidate.scheduled === 0 && candidate.peak_day_utc !== "")
  ) {
    return null;
  }

  return value as SchedulePreviewResponse;
}
