/**
 * deliverabilitySignals — the pure derivations behind the deliverability
 * surfaces: sender score/grade, the rate-limit meter, quiet-hours state, DNS
 * mechanism health and blocklist tiers.
 *
 * These live here (not in a screen) for two reasons: they are the parts worth
 * unit-testing, and desktop and mobile must agree on the thresholds. Every
 * threshold below is the one desktop already uses:
 *   - meter tone flips at 60% and 90% (SendingSettings.tsx RateLimitMeter)
 *   - grade tone follows the server's Excellent|Good|Fair|Poor|Critical enum
 *     (apps/api/internal/sender_reputation DomainStat.Grade)
 *
 * Nothing here imports react-native, so it stays testable in a node vitest run.
 */

export type SignalTone = "neutral" | "success" | "warning" | "danger" | "info";

/* ---------------------------------------------------------------- score --- */

/**
 * Hub / reputation score is 0-100. Thresholds mirror the server's own grade
 * boundaries so the colour never contradicts the letter next to it.
 */
export function scoreTone(score: unknown): SignalTone {
  const n = typeof score === "number" && Number.isFinite(score) ? score : null;
  if (n === null) return "neutral";
  if (n >= 90) return "success";
  if (n >= 75) return "info";
  if (n >= 50) return "warning";
  return "danger";
}

/** Server grades are words, not letters. Unknown values stay neutral. */
export function gradeTone(grade: unknown): SignalTone {
  const g = typeof grade === "string" ? grade.trim().toLowerCase() : "";
  if (g === "excellent" || g === "a" || g === "a+") return "success";
  if (g === "good" || g === "b") return "info";
  if (g === "fair" || g === "c") return "warning";
  if (g === "poor" || g === "critical" || g === "d" || g === "f") return "danger";
  return "neutral";
}

/** Breach severity is "info" | "warn" | "critical" (hub.go ThresholdBreach). */
export function severityTone(severity: unknown): SignalTone {
  const s = typeof severity === "string" ? severity.trim().toLowerCase() : "";
  if (s === "critical" || s === "error") return "danger";
  if (s === "warn" || s === "warning" || s === "action") return "warning";
  if (s === "info") return "info";
  return "neutral";
}

/** Most severe first, then stable by title, so the action centre is orderable. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  error: 0,
  action: 1,
  warn: 1,
  warning: 1,
  info: 2,
};

export function severityRank(severity: unknown): number {
  const s = typeof severity === "string" ? severity.trim().toLowerCase() : "";
  return SEVERITY_RANK[s] ?? 3;
}

export function sortBySeverity<T extends { severity?: string; title?: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const delta = severityRank(a.severity) - severityRank(b.severity);
    if (delta !== 0) return delta;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
}

/** `up` is good for a score and bad for a bounce rate, so the caller says which. */
export function trendTone(
  trend: unknown,
  { higherIsBetter = true } = {},
): SignalTone {
  const value = typeof trend === "string" ? trend.trim().toLowerCase() : "";
  if (value === "up") return higherIsBetter ? "success" : "danger";
  if (value === "down") return higherIsBetter ? "danger" : "success";
  return "neutral";
}

/* ---------------------------------------------------------------- meter --- */

export interface MeterState {
  /** 0-1, clamped. `null` when there is no cap to measure against. */
  fraction: number | null;
  tone: SignalTone;
  /** Whole percent for display; `null` mirrors `fraction`. */
  percent: number | null;
}

/**
 * Rate-limit meter. A missing / non-positive cap means "uncapped", which is a
 * real state, not a zero — returning `fraction: null` keeps the caller from
 * drawing an empty bar that reads as "0% of your quota used".
 */
export function meterState(used: unknown, cap: unknown): MeterState {
  const capN = typeof cap === "number" && Number.isFinite(cap) ? cap : null;
  const usedN =
    typeof used === "number" && Number.isFinite(used) && used > 0 ? used : 0;
  if (capN === null || capN <= 0) {
    return { fraction: null, tone: "neutral", percent: null };
  }
  const fraction = Math.min(1, usedN / capN);
  // Rounded for DISPLAY only. Comparing the rounded percent against the
  // thresholds would let 89.9% round up to 90 and report "danger" — a false
  // alarm on a workspace that has not actually crossed the line. The tone is
  // decided on the real fraction; the integer is what the label renders.
  const percent = Math.min(100, Math.round(fraction * 100));
  // Desktop flips at 60 / 90; keep the same boundaries so the two clients
  // never disagree about whether a workspace is "close to its cap".
  const tone: SignalTone =
    fraction >= 0.9 ? "danger" : fraction >= 0.6 ? "warning" : "success";
  return { fraction, tone, percent };
}

/* ---------------------------------------------------------- quiet hours --- */

export interface QuietHoursState {
  /** `null` when the server could not compute it (no tz configured). */
  active: boolean | null;
  tone: SignalTone;
  label: string;
}

/**
 * `in_quiet_hours` is a pointer server-side and is omitted entirely when no
 * timezone is set — so `undefined` must NOT collapse to "not in quiet hours".
 */
export function quietHoursState(
  inQuietHours: unknown,
  { start = "", end = "" } = {},
): QuietHoursState {
  const window = start && end ? `${start}–${end}` : "";
  if (typeof inQuietHours !== "boolean") {
    return {
      active: null,
      tone: "neutral",
      label: window ? `Quiet hours ${window}` : "No quiet hours",
    };
  }
  if (inQuietHours) {
    return {
      active: true,
      tone: "warning",
      label: window ? `Paused — quiet hours ${window}` : "Paused — quiet hours",
    };
  }
  return {
    active: false,
    tone: "success",
    label: window ? `Sending — quiet ${window}` : "Sending",
  };
}

/* ------------------------------------------------------------ dns health --- */

export interface DnsMechanism {
  key: "SPF" | "DKIM" | "DMARC";
  ok: boolean;
  tone: SignalTone;
  /** Spoken form — a coloured pill alone is not an accessible status. */
  accessibilityLabel: string;
}

export interface DnsHealthRow {
  domain?: string;
  verify_state?: string;
  spf_verified_at?: string | null;
  dkim_verified_at?: string | null;
  dmarc_verified_at?: string | null;
  last_attempt_at?: string | null;
  last_error?: string;
  is_stale?: boolean;
}

/**
 * The API returns per-mechanism *timestamps*, not booleans: a non-empty
 * `*_verified_at` is the only signal that a record was seen. Treat an empty
 * string the same as null — the Go handler omits the field when unset but
 * older rows serialise "".
 */
export function dnsMechanisms(row: DnsHealthRow | undefined): DnsMechanism[] {
  const at = (value: string | null | undefined) =>
    typeof value === "string" && value.trim() !== "";
  const defs: { key: DnsMechanism["key"]; ok: boolean }[] = [
    { key: "SPF", ok: at(row?.spf_verified_at) },
    { key: "DKIM", ok: at(row?.dkim_verified_at) },
    { key: "DMARC", ok: at(row?.dmarc_verified_at) },
  ];
  return defs.map(({ key, ok }) => ({
    key,
    ok,
    tone: ok ? ("success" as const) : ("danger" as const),
    accessibilityLabel: `${key} ${ok ? "published" : "missing"}`,
  }));
}

/** Index any per-domain side-signal by lowercased domain, as desktop does. */
export function indexByDomain<T extends { domain?: string }>(
  rows: readonly T[] | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  // `rows ?? []` is a NULLISH guard and a for-of over a truthy non-array throws
  // "is not iterable". Callers pass `health.data ?? []` straight from a query.
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = (row?.domain ?? "").trim().toLowerCase();
    if (key) out[key] = row;
  }
  return out;
}

/* ------------------------------------------------------------- blocklist --- */

export function blocklistTierLabel(tier1: unknown): string {
  return tier1 === true ? "Tier 1" : "Tier 2";
}

export function blocklistTone(tier1: unknown): SignalTone {
  return tier1 === true ? "danger" : "warning";
}

/* ----------------------------------------------------------------- misc --- */

/**
 * Copy for a failed WRITE.
 *
 * Re-verify is the one action a user will hammer (DNS propagation invites
 * repeated taps) and therefore the most likely to draw a 429 — which used to
 * surface as `e.message` under a title reading "Verify failed", i.e. "your
 * domain is broken" rather than "you checked too often". Nothing in the cluster
 * inspected status codes, even though the plumbing existed.
 */
export function writeFailureMessage(error: unknown, fallback: string): string {
  const status =
    error && typeof error === "object" && "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : 0;
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (code === "offline_write_refused" && error instanceof Error) {
    return error.message;
  }
  if (status === 429) {
    return "Checked too recently — wait a minute and try again.";
  }
  if (status === 403) {
    return "Your role can't make this change. Ask an admin.";
  }
  if (status === 401) {
    return "Your session expired. Sign in again to continue.";
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/**
 * A side-fetch that failed must render an em-dash plus an explicit notice, not
 * an implied "not configured" — desktop's D10 lesson, ported. Returns the
 * notice string, or null when there is nothing to say.
 */
export function sideSignalNotice(
  label: string,
  failed: boolean,
  offline: boolean,
): string | null {
  if (!failed) return null;
  return offline
    ? `${label} unavailable offline — shown as —, not as "not configured".`
    : `${label} couldn't be loaded, so it shows as — rather than "not configured".`;
}
