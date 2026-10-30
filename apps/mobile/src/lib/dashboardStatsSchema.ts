/**
 * lib/dashboardStatsSchema.ts — the runtime contract for
 * `GET /api/v1/dashboard/stats`.
 *
 * The mobile hook used to do `return res ?? {}` behind a bare generic cast, so
 * a null body, a 204, or an envelope-shape drift resolved as a SUCCESS and the
 * dashboard confidently painted "0 subscribers · 0 sent · 0 sequences" beside a
 * green "Live" badge. Zero is a real measurement and must never be invented.
 *
 * Three rules, mirroring the desktop validator (`isDashboardStatsPayload`):
 *
 *  1. A NON-OBJECT IS A FAILURE, NOT AN EMPTY WORKSPACE. `null`, an array, a
 *     string, `undefined` → throw, so the screen routes into its error/retry
 *     path instead of rendering fabricated zeros.
 *  2. AN UNRECOGNISABLE OBJECT IS ALSO A FAILURE. The Go handler emits every
 *     count field unconditionally (they are non-pointer ints, and openapi marks
 *     them required), so a payload carrying none of them is drift — `{}` is not
 *     a workspace with nothing in it.
 *  3. IMPOSSIBLE VALUES ARE REFUSED RATHER THAN RENDERED. A negative count or a
 *     NaN is a server/serialisation bug; painting it teaches the user to
 *     distrust every other number on the screen.
 *
 * Everything here is pure so it can be unit-tested without React Native, and so
 * the same validator can gate a future SSE frame as well as a fetch response.
 */

/** One row from `recent_audit`. Optional everywhere: older API versions and the
 *  /audit fallback both produce partially-populated rows. */
export interface DashboardAuditEvent {
  id?: string;
  action?: string;
  actor?: string;
  at?: string;
  description?: string;
}

/**
 * The comparison window returned by `?compare=true` — one window of the same
 * length immediately preceding the current one. Field names match
 * `PreviousWindow` in apps/api/internal/analytics/analytics.go.
 */
export interface DashboardPreviousWindow {
  subscribers_added?: number;
  subscribers_unsubbed?: number;
  campaigns_sent?: number;
  opens_total?: number;
  clicks_total?: number;
  bounces_total?: number;
  unique_opens?: number;
  unique_clicks?: number;
  unique_bounces?: number;
  unique_delivered?: number;
  unique_sent?: number;
  emails_sent?: number;
}

/**
 * Shape returned by GET /api/v1/dashboard/stats.
 *
 * Fields are optional because the legacy nested deployments are still
 * tolerated (see the `subscribers` / `campaigns_sent` / `active_sequences`
 * members), NOT because absence is expected on a current server. There is
 * deliberately no `[extra: string]: unknown` index signature: it made every
 * typo compile and hid the fact that the real contract has 15 required fields.
 */
export interface DashboardStats {
  range?: string;
  subscribers_total?: number;
  subscribers_added_30d?: number;
  subscribers_unsubbed_30d?: number;
  opens_total_30d?: number;
  unique_opens_30d?: number;
  unique_clicks_30d?: number;
  unique_bounces_30d?: number;
  unique_delivered_30d?: number;
  unique_sent_30d?: number;
  clicks_total_30d?: number;
  campaigns_sent_30d?: number;
  bounces_total_30d?: number;
  emails_sent_30d?: number;
  active_sequences_count?: number;
  open_rate?: { rate?: number; delta?: number };
  recent_audit?: DashboardAuditEvent[];
  inbox_health?: { score?: number; state?: string } | null;
  previous?: DashboardPreviousWindow;
  sparklines?: Record<string, number[]>;
  anomalies?: Record<string, boolean>;
  // Legacy nested shape (subscribers.total, etc). Retained for deployments
  // that predate the flat contract.
  subscribers?: { total?: number; delta_30d?: number };
  campaigns_sent?: { this_month?: number; delta?: number };
  active_sequences?: { count?: number; delta?: number };
}

/**
 * Thrown when the response cannot be trusted. Carries a stable `name` so the
 * failure taxonomy can branch on it without string-matching a message.
 */
export class DashboardPayloadError extends Error {
  override readonly name = "DashboardPayloadError";

  constructor(message = "The dashboard response could not be read.") {
    super(message);
  }
}

/**
 * Audit rows are rendered six at a time; a server that returns five thousand is
 * either misconfigured or hostile, and holding them all in memory helps nobody.
 */
export const MAX_RECENT_AUDIT_ROWS = 25;

/** Flat count fields. Present on every current deployment. */
const COUNT_FIELDS = [
  "subscribers_total",
  "subscribers_added_30d",
  "subscribers_unsubbed_30d",
  "opens_total_30d",
  "unique_opens_30d",
  "unique_clicks_30d",
  "unique_bounces_30d",
  "unique_delivered_30d",
  "unique_sent_30d",
  "clicks_total_30d",
  "campaigns_sent_30d",
  "bounces_total_30d",
  "emails_sent_30d",
  "active_sequences_count",
] as const;

/** Legacy nested containers that also count as "this is a stats payload". */
const LEGACY_CONTAINERS = [
  "subscribers",
  "campaigns_sent",
  "active_sequences",
  "open_rate",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function isValidCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * True when `value` is a dashboard-stats payload we are willing to render.
 * Deliberately permissive about EXTRA fields (the gateway adds them without a
 * client release) and strict about the ones we know.
 */
export function isDashboardStatsPayload(value: unknown): boolean {
  if (!isPlainObject(value)) return false;

  let recognised = 0;
  for (const field of COUNT_FIELDS) {
    if (!(field in value)) continue;
    if (!isValidCount(value[field])) return false;
    recognised += 1;
  }
  for (const field of LEGACY_CONTAINERS) {
    if (field in value && isPlainObject(value[field])) recognised += 1;
  }
  if (recognised === 0) return false;

  if ("recent_audit" in value && value.recent_audit != null) {
    if (!Array.isArray(value.recent_audit)) return false;
  }
  if (
    "inbox_health" in value &&
    value.inbox_health != null &&
    !isPlainObject(value.inbox_health)
  ) {
    return false;
  }
  if (
    "previous" in value &&
    value.previous != null &&
    !isPlainObject(value.previous)
  ) {
    return false;
  }
  return true;
}

/**
 * Daily buckets the server will chart. Longer series are the server's business
 * (a 90-day window is 90 points); this is a hostile-payload ceiling, not a
 * window length.
 */
export const MAX_SPARKLINE_POINTS = 400;

/**
 * Keep only the series that are genuinely `number[]`.
 *
 * The desktop has already been shipped a payload carrying
 * `sparklines: { opens: "1,3,5" }`, so the field is NOT self-describing on the
 * wire. Dropping a malformed series is right where throwing would be wrong:
 * a decorative trend line is not worth failing the six headline numbers over,
 * and a silently-`undefined` series renders as no chart rather than a wrong
 * one. Non-finite and negative points are dropped with the whole series — a
 * partially-repaired chart is a fabricated shape.
 */
export function normalizeSparklines(
  value: unknown,
): Record<string, number[]> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, number[]> = {};
  for (const [metric, series] of Object.entries(value)) {
    if (!Array.isArray(series) || series.length > MAX_SPARKLINE_POINTS) continue;
    if (!series.every((point) => isValidCount(point))) continue;
    out[metric] = series as number[];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Keep only real booleans — a truthy string is not a detection. */
export function normalizeAnomalies(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [metric, flag] of Object.entries(value)) {
    if (typeof flag === "boolean") out[metric] = flag;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeAuditRow(row: unknown): DashboardAuditEvent | null {
  if (!isPlainObject(row)) return null;
  const out: DashboardAuditEvent = {};
  if (typeof row.id === "string" && row.id) out.id = row.id;
  else if (typeof row.id === "number") out.id = String(row.id);
  if (typeof row.action === "string") out.action = row.action;
  if (typeof row.actor === "string") out.actor = row.actor;
  if (typeof row.at === "string") out.at = row.at;
  if (typeof row.description === "string") out.description = row.description;
  return out;
}

/**
 * Validate and normalize a raw stats response.
 *
 * Throws `DashboardPayloadError` rather than substituting `{}` — a thrown
 * failure is what routes the screen into its retry affordance, whereas an empty
 * object silently becomes an all-zero workspace.
 */
export function parseDashboardStats(raw: unknown): DashboardStats {
  if (!isDashboardStatsPayload(raw)) {
    throw new DashboardPayloadError();
  }
  const value = raw as Record<string, unknown>;
  const stats = { ...value } as DashboardStats;

  if (Array.isArray(value.recent_audit)) {
    stats.recent_audit = value.recent_audit
      .slice(0, MAX_RECENT_AUDIT_ROWS)
      .map(normalizeAuditRow)
      .filter((row): row is DashboardAuditEvent => row !== null);
  }

  // `?sparklines=true` adds both of these. They are decoration + a warning
  // flag, never a headline number, so a malformed one is dropped rather than
  // failing the payload — but it is dropped, not rendered.
  const sparklines = normalizeSparklines(value.sparklines);
  if (sparklines) stats.sparklines = sparklines;
  else delete stats.sparklines;
  const anomalies = normalizeAnomalies(value.anomalies);
  if (anomalies) stats.anomalies = anomalies;
  else delete stats.anomalies;

  return stats;
}

/**
 * Does the dashboard still have to read `/audit` for its activity feed?
 *
 * The answer is a PAYLOAD question, not a timing one, and that distinction is
 * the whole point of this function. `recent_audit` is `omitempty` on the Go
 * struct and nothing in apps/api/internal/analytics ever assigns it, so the
 * feed's only production source is the dedicated /audit read. Deciding "do I
 * need it?" from `!stats.isLoading && …` therefore held that read back a full
 * round trip (50-300ms on a phone) behind the stats read, on the app's landing
 * screen, on every launch — nothing is persisted, so stats is always cold.
 *
 * An in-flight stats read has no payload, so it cannot be carrying the rows:
 * the answer while loading is YES, and the two reads leave together. If a
 * server ever does populate the field, this flips to false the moment the
 * payload lands and the caller prefers those rows — the fallback is still a
 * fallback, it just no longer waits to find out.
 */
export function dashboardNeedsAuditFallback(
  data: Pick<DashboardStats, "recent_audit"> | null | undefined,
): boolean {
  return !Array.isArray(data?.recent_audit);
}
