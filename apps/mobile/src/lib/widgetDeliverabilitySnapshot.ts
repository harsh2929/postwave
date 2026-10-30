/**
 * lib/widgetDeliverabilitySnapshot.ts — the shape and the rules of the SENDER
 * HEALTH record inside the widget's App Group container (DELIVERABILITY#64).
 *
 * WHY A THIRD RECORD AND NOT THREE MORE FIELDS ON THE DASHBOARD ONE.
 * Same argument the commerce record makes (lib/widgetCommerceSnapshot.ts), and
 * for the same reason: `writeWidgetSnapshot` is stamped with the moment the
 * DASHBOARD stats landed. Sender health comes from a different endpoint, and
 * — the part that decides it — the server tells us exactly when IT computed
 * the score (`computed_at`, set to `d.now()` at
 * apps/api/internal/deliverability_hub/hub.go:201). Folding the score into the
 * dashboard transaction would relabel a server-side measurement with a
 * client-side arrival time. This record therefore carries its own ready
 * marker, its own schema version, its own measured-at and its own expiry, and
 * is independently valid: a container may hold any subset of the three.
 *
 * WHERE THE NUMBERS COME FROM, read from the Go source and not from a doc:
 *   GET /api/v1/deliverability/hub
 *     mounted behind `apikeys.RequireScope(apikeys.ScopeReadReports)`
 *     (deliverability_hub/handlers.go:36) → `HubScore` (hub.go:117-136) →
 *     `computeHub` (hub.go:197) → `scoreHub` (hub.go:419).
 *
 * THREE FACTS ABOUT THAT PAYLOAD THE WIDGET COPY HAS TO RESPECT:
 *
 *  1. `computed_at` IS THE MEASUREMENT TIME, and it is the server's clock.
 *     The handler recomputes on every request, so on a live fetch it is
 *     "now"; on a cached/offline read it is genuinely older, and the widget
 *     must age accordingly rather than re-stamping itself. Hence the record is
 *     built from `computed_at`, never `Date.now()`.
 *  2. THE SCORE STARTS AT 100 AND SUBTRACTS (`scoreHub`, hub.go:420). A
 *     workspace that has sent nothing can therefore score A. That is not a
 *     lie, but a bare "A" on a home screen would read as "your sending is
 *     healthy" when nothing has been sent. So `sends7d` travels WITH the
 *     score and the native views say it out loud.
 *  3. `parseDeliverabilityHub` COERCES A MISSING SCORE TO 0
 *     (lib/deliverabilityContracts.ts:354). A drifted payload would therefore
 *     arrive as a perfectly renderable "0", i.e. the worst possible grade, and
 *     publishing that to a home screen would start a fire drill over a schema
 *     change. The grade is the guard: the server computes score and grade in
 *     the same switch, so a payload whose grade is not one of A/B/C/D/F did
 *     not come from `scoreHub` and nothing is published.
 *
 * DELIBERATELY IMPORT-FREE of react-native so it runs under the node vitest
 * environment; `./utf8` is itself import-free.
 */
import { utf8ByteLength } from "./utf8";

export const WIDGET_DELIVERABILITY_SCHEMA_VERSION = 1;

/**
 * The disclosure window, mirrored from `WIDGET_SNAPSHOT_TTL_MS` in
 * lib/widgetData.ts and re-validated natively in targets/widget/index.swift.
 * A duplicated literal rather than an import because lib/widgetData.ts pulls
 * in react-native and this module must stay loadable in a node test;
 * lib/widgetDeliverabilityContract.test.ts pins every copy against the others
 * so they cannot drift.
 */
export const WIDGET_DELIVERABILITY_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How stale a published measurement may get before the writer re-stamps it
 * from a newer fetch. Not a freshness claim — `measuredAt` is always the
 * server's `computed_at` — this only stops an open Deliverability tab
 * rewriting the container (and spending an iOS WidgetKit reload) on every
 * render when nothing has moved.
 */
export const WIDGET_DELIVERABILITY_RESTAMP_SECONDS = 5 * 60;

export const WIDGET_DELIVERABILITY_SCHEMA_KEY = "pw_widget_deliv_schema";
export const WIDGET_DELIVERABILITY_READY_KEY = "pw_widget_deliv_ready";
export const WIDGET_DELIVERABILITY_SCORE_KEY = "pw_widget_deliv_score";
export const WIDGET_DELIVERABILITY_GRADE_KEY = "pw_widget_deliv_grade";
export const WIDGET_DELIVERABILITY_STATUS_KEY = "pw_widget_deliv_status";
export const WIDGET_DELIVERABILITY_THROTTLED_KEY = "pw_widget_deliv_throttled";
export const WIDGET_DELIVERABILITY_BREACHES_KEY = "pw_widget_deliv_breaches";
export const WIDGET_DELIVERABILITY_SENDS7D_KEY = "pw_widget_deliv_sends7d";
export const WIDGET_DELIVERABILITY_MEASURED_AT_KEY =
  "pw_widget_deliv_measured_at";
export const WIDGET_DELIVERABILITY_EXPIRES_AT_KEY =
  "pw_widget_deliv_expires_at";

/**
 * Every key, so lib/widgetData.ts can fold them into the ONE purge list that
 * opt-out, app lock, sign-out and account deletion already drive. A third
 * record with a third purge path is a third thing to forget.
 */
export const WIDGET_DELIVERABILITY_KEYS = [
  WIDGET_DELIVERABILITY_SCHEMA_KEY,
  WIDGET_DELIVERABILITY_READY_KEY,
  WIDGET_DELIVERABILITY_SCORE_KEY,
  WIDGET_DELIVERABILITY_GRADE_KEY,
  WIDGET_DELIVERABILITY_STATUS_KEY,
  WIDGET_DELIVERABILITY_THROTTLED_KEY,
  WIDGET_DELIVERABILITY_BREACHES_KEY,
  WIDGET_DELIVERABILITY_SENDS7D_KEY,
  WIDGET_DELIVERABILITY_MEASURED_AT_KEY,
  WIDGET_DELIVERABILITY_EXPIRES_AT_KEY,
] as const;

export const MAX_DELIVERABILITY_WIDGET_INTEGER = 2_147_483_647;
/** "Needs attention" is the longest label `statusLabel` emits. */
export const MAX_DELIVERABILITY_STATUS_BYTES = 32;

/** The exact set `scoreHub` can return (hub.go:526-538). */
export const DELIVERABILITY_GRADES = ["A", "B", "C", "D", "F"] as const;
export type DeliverabilityGrade = (typeof DELIVERABILITY_GRADES)[number];

export interface DeliverabilityWidgetInput {
  /** `HubScore.Score` — 0...100, computed with `HubScore.Grade`. */
  score: number | null | undefined;
  /** `HubScore.Grade` — A|B|C|D|F. The guard against a drifted payload. */
  grade: string | null | undefined;
  /** `HubScore.Status` — the human label `statusLabel` derived from grade. */
  status: string | null | undefined;
  /** `HubScore.AutoThrottled` — the one bit worth a Lock Screen. */
  autoThrottled: boolean | null | undefined;
  /** `len(HubScore.Breaches)` — how many rules tripped. 0 is a measurement. */
  breaches: number | null | undefined;
  /** `HubScore.Totals.Sends7d` — what the score was computed over. */
  sends7d: number | null | undefined;
  /**
   * `HubScore.ComputedAt` in unix milliseconds — when the SERVER computed the
   * score, never when this device rendered it.
   */
  measuredAtMs: number | null | undefined;
}

export interface DeliverabilityWidgetPayload {
  score: number;
  grade: DeliverabilityGrade;
  status: string;
  /** 1 when Moosewave has already throttled this workspace's send rate. */
  throttled: number;
  breaches: number;
  sends7d: number;
  /** Unix SECONDS the score was computed. */
  measuredAt: number;
  /** Unix SECONDS the disclosure lapses. */
  expiresAt: number;
}

/** Control characters out, whitespace collapsed, bounded in BYTES not chars. */
export function normalizeStatusLabel(raw: unknown): string {
  const value = typeof raw === "string" ? raw : "";
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (utf8ByteLength(cleaned) <= MAX_DELIVERABILITY_STATUS_BYTES) return cleaned;
  let out = "";
  for (const character of cleaned) {
    if (utf8ByteLength(out + character) > MAX_DELIVERABILITY_STATUS_BYTES) break;
    out += character;
  }
  return out;
}

/**
 * The grade, or null.
 *
 * Null rather than a fallback letter on purpose: the grade is what tells the
 * builder the payload really came from `scoreHub`, so inventing one would
 * defeat the only guard the record has against a schema drift being rendered
 * as "0 · Critical".
 */
export function normalizeGrade(raw: unknown): DeliverabilityGrade | null {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (DELIVERABILITY_GRADES as readonly string[]).includes(value)
    ? (value as DeliverabilityGrade)
    : null;
}

function wholeInRange(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > max) return null;
  return rounded;
}

/**
 * Build the record, or null when it cannot be published honestly.
 *
 * Every null return is a case where writing SOMETHING would be worse than
 * writing nothing: a grade that did not come from the scorer, a score outside
 * the scorer's own range, no status to name it, a count that was never
 * measured, a send total that will not fit the shared integer contract, or no
 * idea when the server computed any of it.
 */
export function buildDeliverabilityWidgetPayload(
  input: DeliverabilityWidgetInput,
): DeliverabilityWidgetPayload | null {
  const grade = normalizeGrade(input.grade);
  if (grade === null) return null;

  const score = wholeInRange(input.score, 100);
  if (score === null) return null;

  const status = normalizeStatusLabel(input.status);
  if (!status) return null;

  const breaches = wholeInRange(
    input.breaches,
    MAX_DELIVERABILITY_WIDGET_INTEGER,
  );
  if (breaches === null) return null;

  const sends7d = wholeInRange(
    input.sends7d,
    MAX_DELIVERABILITY_WIDGET_INTEGER,
  );
  if (sends7d === null) return null;

  if (typeof input.autoThrottled !== "boolean") return null;

  const measuredAtMs = input.measuredAtMs;
  if (
    typeof measuredAtMs !== "number" ||
    !Number.isFinite(measuredAtMs) ||
    measuredAtMs <= 0
  ) {
    return null;
  }

  return {
    score,
    grade,
    status,
    throttled: input.autoThrottled ? 1 : 0,
    breaches,
    sends7d,
    measuredAt: Math.floor(measuredAtMs / 1000),
    expiresAt: Math.floor(
      (measuredAtMs + WIDGET_DELIVERABILITY_TTL_MS) / 1000,
    ),
  };
}

/**
 * Everything except the timestamps. Two reads of an unchanged workspace
 * produce the same fingerprint, so an open Deliverability tab does not rewrite
 * the App Group on every poll.
 */
export function deliverabilityWidgetFingerprint(
  payload: DeliverabilityWidgetPayload,
): string {
  return [
    payload.score,
    payload.grade,
    payload.status,
    payload.throttled,
    payload.breaches,
    payload.sends7d,
  ].join(" ");
}

/**
 * Publish when anything moved, or when the published measurement is old enough
 * that re-stamping it is worth a WidgetKit reload.
 *
 * The last clause is what keeps a healthy workspace's tile alive: the record
 * expires twelve hours after it was COMPUTED, and a workspace whose score has
 * not budged is exactly the one that would otherwise go blank.
 */
export function shouldPublishDeliverabilityWidget(
  last: DeliverabilityWidgetPayload | null,
  next: DeliverabilityWidgetPayload,
): boolean {
  if (last === null) return true;
  if (
    deliverabilityWidgetFingerprint(last) !==
    deliverabilityWidgetFingerprint(next)
  ) {
    return true;
  }
  return (
    next.measuredAt - last.measuredAt >= WIDGET_DELIVERABILITY_RESTAMP_SECONDS
  );
}

/**
 * `computed_at` (RFC-3339 off the wire) as unix milliseconds, or null.
 *
 * Separate from the builder because the two callers hold it differently — the
 * screen has the parsed hub, the background task has the raw response — and
 * because "the server did not tell us when it measured" has to be a refusal,
 * not a `Date.now()`.
 */
export function computedAtMs(raw: unknown): number | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
