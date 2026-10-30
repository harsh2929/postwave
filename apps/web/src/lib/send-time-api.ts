// SPDX-License-Identifier: AGPL-3.0-only
//
// Workspace send-time-optimization (STO) settings client.
//
// Backend (apps/api/internal/settings/send_time_optimization.go):
//   GET /api/v1/settings/send-time-optimization → {"enabled": bool}
//   PUT /api/v1/settings/send-time-optimization ← {"enabled": bool}  (admin)
//
// A missing tenant row reads as enabled=true (the column default), matching
// the historical default-on posture. The web dashboard previously surfaced
// STO read-only in reports; this gives it the same governance toggle desktop
// has (desktop gap A24).

import { api } from "./api";

export interface SendTimeOptimization {
  enabled: boolean;
}

export const sendTimeOptimizationApi = {
  get: (): Promise<SendTimeOptimization> =>
    api.get<SendTimeOptimization>("/api/v1/settings/send-time-optimization"),
  set: (enabled: boolean): Promise<SendTimeOptimization> =>
    api.put<SendTimeOptimization>("/api/v1/settings/send-time-optimization", {
      enabled,
    }),
};

// SETA-041: best-send-time analysis powering the STO behavior-preview heatmap.
// Backend: GET /api/v1/send-time-opt/best-time-analysis (internal/send_time_opt).
export interface StoAnalysisBucket {
  day_of_week: number; // 0=Sunday
  hour_utc: number; // 0..23
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  open_rate: number;
  click_rate: number;
  score: number;
  subscriber_signal?: number;
}

export interface BestTimeAnalysis {
  lookback_days: number;
  generated_at: string;
  top_buckets: StoAnalysisBucket[];
  heatmap: StoAnalysisBucket[];
}

export function getBestTimeAnalysis(
  days = 90,
  signal?: AbortSignal,
): Promise<BestTimeAnalysis> {
  return api.get<BestTimeAnalysis>(
    `/api/v1/send-time-opt/best-time-analysis?days=${encodeURIComponent(days)}`,
    { signal },
  );
}

export interface WeeklySendTimePattern {
  grid: number[][];
  sampleSize: number;
  bestDay: number;
  bestHour: number;
  secondaryDay: number | null;
  secondaryHour: number | null;
  hasSecondary: boolean;
  computedAt: string;
}

export interface SegmentSendTimePattern extends WeeklySendTimePattern {
  segmentId: string;
}

export interface SegmentSendTimeBest {
  segmentId: string;
  bestHourUtc: number;
  confidence: number;
  sampleSize: number;
  computedAt: string;
}

export interface SubscriberSendTimeBest {
  bestHourOfWeekUtc: number;
  sampleSize: number;
  computedAt: string;
}

export interface SendTimeSegmentOption {
  id: string;
  name: string;
  lastCount: number | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requireUuid(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_RE.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function responseRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} response`);
  }
  return value as Record<string, unknown>;
}

function responseInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function responseTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function parseGrid(value: unknown, sampleSize: number): number[][] {
  if (!Array.isArray(value) || value.length !== 7) {
    throw new Error("Invalid send-time weekly grid");
  }
  let sum = 0;
  const grid = value.map((row) => {
    if (!Array.isArray(row) || row.length !== 24) {
      throw new Error("Invalid send-time weekly grid");
    }
    return row.map((cell) => {
      if (
        typeof cell !== "number" ||
        !Number.isFinite(cell) ||
        cell < 0 ||
        cell > 1
      ) {
        throw new Error("Invalid send-time weekly grid cell");
      }
      sum += cell;
      return cell;
    });
  });
  if (
    (sampleSize === 0 && sum !== 0) ||
    (sampleSize > 0 && (sum < 0.99 || sum > 1.01))
  ) {
    throw new Error("Invalid send-time weekly grid total");
  }
  return grid;
}

function parseWeeklyPattern(
  value: unknown,
  options: { segmentId?: string; subscriber: boolean },
): WeeklySendTimePattern {
  const response = responseRecord(value, "send-time pattern");
  const sampleField = options.subscriber
    ? "sample_size"
    : "subscribers_with_data";
  const sampleSize = responseInteger(
    response[sampleField],
    0,
    Number.MAX_SAFE_INTEGER,
    sampleField,
  );
  const bestDay = responseInteger(response.best_dow, 0, 6, "best_dow");
  const bestHour = responseInteger(response.best_hour, 0, 23, "best_hour");
  const computedAt = responseTimestamp(response.computed_at, "computed_at");
  if (options.segmentId && response.segment_id !== options.segmentId) {
    throw new Error("Send-time segment identity mismatch");
  }
  const secondaryDay =
    response.secondary_dow == null
      ? null
      : responseInteger(response.secondary_dow, 0, 6, "secondary_dow");
  const secondaryHour =
    response.secondary_hour == null
      ? null
      : responseInteger(response.secondary_hour, 0, 23, "secondary_hour");
  if ((secondaryDay === null) !== (secondaryHour === null)) {
    throw new Error("Invalid send-time secondary window");
  }
  const declared = options.subscriber
    ? response.bimodal === true
    : response.has_secondary_window === true;
  return {
    grid: parseGrid(response.grid, sampleSize),
    sampleSize,
    bestDay,
    bestHour,
    secondaryDay,
    secondaryHour,
    // Older Go JSON omitted a coordinate when its numeric value was zero.
    // Only claim a secondary window when both coordinates are observable.
    hasSecondary: declared && secondaryDay !== null && secondaryHour !== null,
    computedAt,
  };
}

export async function getSegmentSendTimePattern(
  segmentId: string,
  signal?: AbortSignal,
): Promise<SegmentSendTimePattern> {
  const id = requireUuid(segmentId, "segment id");
  const response = await api.get<unknown>(
    `/api/v1/send-time-opt/heatmap?segment_id=${encodeURIComponent(id)}`,
    { signal },
  );
  return {
    ...parseWeeklyPattern(response, { segmentId: id, subscriber: false }),
    segmentId: id,
  };
}

export async function getSegmentSendTimeBest(
  segmentId: string,
  signal?: AbortSignal,
): Promise<SegmentSendTimeBest> {
  const id = requireUuid(segmentId, "segment id");
  const response = responseRecord(
    await api.get<unknown>(
      `/api/v1/send-time-opt?segment_id=${encodeURIComponent(id)}`,
      { signal },
    ),
    "segment send-time recommendation",
  );
  if (response.segment_id !== id) {
    throw new Error("Send-time segment identity mismatch");
  }
  if (
    typeof response.best_hour_utc !== "string" ||
    !/^(?:[01]\d|2[0-3]):00$/u.test(response.best_hour_utc)
  ) {
    throw new Error("Invalid segment best send hour");
  }
  if (
    typeof response.confidence !== "number" ||
    !Number.isFinite(response.confidence) ||
    response.confidence < 0 ||
    response.confidence > 1
  ) {
    throw new Error("Invalid segment send-time coverage");
  }
  return {
    segmentId: id,
    bestHourUtc: Number(response.best_hour_utc.slice(0, 2)),
    confidence: response.confidence,
    sampleSize: responseInteger(
      response.sample_size,
      0,
      Number.MAX_SAFE_INTEGER,
      "sample_size",
    ),
    computedAt: responseTimestamp(response.computed_at, "computed_at"),
  };
}

export async function getSubscriberSendTimePattern(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<WeeklySendTimePattern> {
  const id = requireUuid(subscriberId, "subscriber id");
  const response = await api.get<unknown>(
    `/api/v1/subscribers/${encodeURIComponent(id)}/open-pattern`,
    { signal },
  );
  // The wire may carry email for desktop compatibility. The aggregate parser
  // intentionally drops it so PII is not retained in web query state.
  return parseWeeklyPattern(response, { subscriber: true });
}

export async function getSubscriberSendTimeBest(
  subscriberId: string,
  signal?: AbortSignal,
): Promise<SubscriberSendTimeBest> {
  const id = requireUuid(subscriberId, "subscriber id");
  const response = responseRecord(
    await api.get<unknown>(
      `/api/v1/subscribers/${encodeURIComponent(id)}/best-send-time`,
      { signal },
    ),
    "subscriber send-time recommendation",
  );
  return {
    bestHourOfWeekUtc: responseInteger(
      response.best_hour_utc,
      0,
      167,
      "best_hour_utc",
    ),
    sampleSize: responseInteger(
      response.sample_size,
      0,
      Number.MAX_SAFE_INTEGER,
      "sample_size",
    ),
    computedAt: responseTimestamp(response.computed_at, "computed_at"),
  };
}

export function isSendTimeIdentity(value: string): boolean {
  return UUID_RE.test(value.trim());
}

// ---------------------------------------------------------------------------
// Schedule-by-best-time (desktop gap campaigns-108)
// ---------------------------------------------------------------------------
//
// Two routes back the desktop "Campaign delivery plan" surface:
//
//   POST /api/v1/campaigns/{id}/schedule-by-best-time/preview   read-only
//   POST /api/v1/campaigns/{id}/schedule-by-best-time           durable write
//
// ONLY THE PREVIEW IS DECLARED HERE, and that asymmetry is deliberate rather
// than unfinished. The commit writes `campaign_recipient_send_at` rows — it
// queues delivery — and this web app holds every scheduling write closed
// behind `CAMPAIGN_SCHEDULING_RELEASE_HOLD` (lib/campaigns-api.ts), where
// `scheduleByBestTime` already exists as an adapter that rejects before
// transport. Adding a second adapter here that DID reach the network would
// route around that hold rather than lift it. The preview handler is
// documented read-only server-side ("It never writes the schedule into
// campaign_recipient_send_at", apps/api/internal/send_time_opt/
// schedule_preview.go), so it queues nothing and is safe to reach.
//
// The preview still requires `write:campaigns`: it discloses a campaign's
// audience plan, so a viewer key must not be able to probe it.

export type SendTimeStrategy = "per_recipient" | "modal_hour";

export const SEND_TIME_STRATEGIES: readonly SendTimeStrategy[] = [
  "per_recipient",
  "modal_hour",
];

/** One (hour-of-day UTC, recipient count) column of the preview histogram. */
export interface SendTimeDistributionBucket {
  hour: number;
  count: number;
}

export interface SchedulePreview {
  campaignId: string;
  scheduled: number;
  withinDays: number;
  tenantMean: number;
  /** The audience exceeded the server's safe scheduling load cap. */
  truncated: boolean;
  hardCap: number;
  strategy: SendTimeStrategy;
  referenceAt: string;
  /** Exactly 24 buckets, ascending, empty hours included. */
  distribution: SendTimeDistributionBucket[];
  maxPerMinute: number;
  maxPerDay: number;
  peakDayUtc: string;
  /** Warmup-day cap: -1 = no cap applies, 0 = the server reader was unwired. */
  tierCapToday: number;
  warmupCapBreach: boolean;
  countedAt: string;
}

export interface SchedulePreviewInput {
  strategy: SendTimeStrategy;
  /** 7..30; the server rejects anything outside that band. */
  withinDays: number;
  /** RFC3339. Omitted entirely when blank so the server uses its own clock. */
  referenceAt?: string;
}

function isSendTimeStrategy(value: unknown): value is SendTimeStrategy {
  return value === "per_recipient" || value === "modal_hour";
}

function parseDistribution(value: unknown): SendTimeDistributionBucket[] {
  if (!Array.isArray(value) || value.length !== 24) {
    throw new Error("Invalid send-time schedule distribution");
  }
  return value.map((entry, index) => {
    const bucket = responseRecord(entry, "send-time distribution bucket");
    // Ascending, one bucket per UTC hour. A shuffled or sparse histogram
    // rendered against a fixed 24-column axis would silently mislabel every
    // column, so the ordering is asserted rather than assumed.
    if (bucket.hour !== index) {
      throw new Error("Invalid send-time distribution ordering");
    }
    return {
      hour: index,
      count: responseInteger(
        bucket.count,
        0,
        Number.MAX_SAFE_INTEGER,
        "distribution count",
      ),
    };
  });
}

export function parseSchedulePreview(
  value: unknown,
  expectedCampaignId: string,
): SchedulePreview {
  const response = responseRecord(value, "send-time schedule preview");
  if (response.campaign_id !== expectedCampaignId) {
    throw new Error("Send-time schedule preview identity mismatch");
  }
  if (!isSendTimeStrategy(response.strategy)) {
    throw new Error("Invalid send-time schedule strategy");
  }
  const scheduled = responseInteger(
    response.scheduled,
    0,
    Number.MAX_SAFE_INTEGER,
    "scheduled",
  );
  const distribution = parseDistribution(response.distribution);
  const total = distribution.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total !== scheduled) {
    throw new Error("Send-time distribution does not account for every recipient");
  }
  return {
    campaignId: expectedCampaignId,
    scheduled,
    withinDays: responseInteger(response.within_days, 7, 30, "within_days"),
    tenantMean: responseInteger(response.tenant_mean, 0, 23, "tenant_mean"),
    truncated: response.truncated === true,
    hardCap: responseInteger(
      response.hard_cap,
      0,
      Number.MAX_SAFE_INTEGER,
      "hard_cap",
    ),
    strategy: response.strategy,
    referenceAt: responseTimestamp(response.reference_at, "reference_at"),
    distribution,
    maxPerMinute: responseInteger(
      response.max_per_minute,
      0,
      Number.MAX_SAFE_INTEGER,
      "max_per_minute",
    ),
    maxPerDay: responseInteger(
      response.max_per_day,
      0,
      Number.MAX_SAFE_INTEGER,
      "max_per_day",
    ),
    peakDayUtc: typeof response.peak_day_utc === "string" ? response.peak_day_utc : "",
    tierCapToday: responseInteger(
      response.tier_cap_today,
      -1,
      Number.MAX_SAFE_INTEGER,
      "tier_cap_today",
    ),
    warmupCapBreach: response.warmup_cap_breach === true,
    countedAt: responseTimestamp(response.counted_at, "counted_at"),
  };
}

/**
 * Dry-run the schedule the commit endpoint WOULD produce. Writes nothing.
 *
 * `within_days` is clamped by the caller rather than the server default so the
 * number rendered under the histogram is the number that was actually sent.
 */
export async function previewScheduleByBestTime(
  campaignId: string,
  input: SchedulePreviewInput,
  signal?: AbortSignal,
): Promise<SchedulePreview> {
  const id = requireUuid(campaignId, "campaign id");
  if (!isSendTimeStrategy(input.strategy)) {
    throw new Error("Invalid send-time schedule strategy");
  }
  if (
    !Number.isSafeInteger(input.withinDays) ||
    input.withinDays < 7 ||
    input.withinDays > 30
  ) {
    throw new Error("Schedule search window must be between 7 and 30 days");
  }
  const reference = input.referenceAt?.trim();
  const response = await api.post<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(id)}/schedule-by-best-time/preview`,
    {
      strategy: input.strategy,
      within_days: input.withinDays,
      ...(reference ? { reference_at: reference } : {}),
    },
    { requireOnline: true, maxAttempts: 1, signal },
  );
  return parseSchedulePreview(response, id);
}

export async function listSendTimeSegments(
  signal?: AbortSignal,
): Promise<SendTimeSegmentOption[]> {
  const response = await api.get<unknown>("/api/v1/segments", { signal });
  if (!Array.isArray(response) || response.length > 1_000) {
    throw new Error("Invalid send-time segment catalog");
  }
  const seen = new Set<string>();
  return response.map((value) => {
    const row = responseRecord(value, "send-time segment");
    const id = requireUuid(
      typeof row.id === "string" ? row.id : "",
      "segment id",
    );
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || name.length > 200 || seen.has(id)) {
      throw new Error("Invalid send-time segment identity");
    }
    seen.add(id);
    let lastCount: number | null = null;
    const rawCount = row.lastCount ?? row.last_count;
    if (rawCount != null) {
      lastCount = responseInteger(
        rawCount,
        0,
        Number.MAX_SAFE_INTEGER,
        "segment last count",
      );
    }
    return { id, name, lastCount };
  });
}
