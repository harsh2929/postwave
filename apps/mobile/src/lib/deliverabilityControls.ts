/**
 * deliverabilityControls — send-window policy plus registry rollups, split from
 * `deliverabilityDiagnostics` so neither file carries the other's vocabulary.
 *
 * A diagnostic tells you what happened; these two tell you what is allowed to
 * happen next, and one of them is writable:
 *
 *   send window        — the tenant-wide local-time window plus its
 *                        enforcement tier (off / warn / block). The incident
 *                        question is "will this policy refuse my send, and can
 *                        I relax it from here".
 *   push suppressions  — tenant-customer APNs/FCM/Web authority facts. The
 *                        customer runtime remains release-held, so this is a
 *                        registry observation rather than a live send result.
 *
 * Import-free apart from the pure contracts module, so every rule below is
 * testable in the node vitest environment.
 *
 * Endpoints, read from the Go handlers:
 *   GET /api/v1/send-window        send_window/send_window.go:95
 *   PUT /api/v1/send-window        send_window/send_window.go:96  (admin)
 *   GET /api/v1/push/suppressions  pushsuppressions/pushsuppressions.go:156
 */
import { itemsOf, numberOr, str } from "@/lib/deliverabilityContracts";
import type { SignalTone } from "@/lib/deliverabilitySignals";
import type { PushSuppressionRow } from "@/lib/pushSuppressions";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ---------------------------------------------------------- send window --- */

export type SendWindowTier = "off" | "warn" | "block";

export const SEND_WINDOW_TIERS: readonly {
  value: SendWindowTier;
  label: string;
}[] = [
  { value: "off", label: "Off" },
  { value: "warn", label: "Warn" },
  { value: "block", label: "Block" },
];

export interface SendWindowPolicy {
  startLocal: string;
  endLocal: string;
  timezone: string;
  weekdayBitmap: number;
  weekdays: string[];
  enforcement: SendWindowTier;
}

export function isSendWindowTier(value: unknown): value is SendWindowTier {
  return value === "off" || value === "warn" || value === "block";
}

/**
 * GET returns `{policy: … | null}`; PUT returns the bare policy. Both shapes
 * land here so the mutation's response can refresh the cache without a second
 * round-trip.
 */
export function parseSendWindow(value: unknown): SendWindowPolicy | null {
  if (!isRecord(value)) return null;
  const body = isRecord(value["policy"])
    ? value["policy"]
    : "policy" in value
      ? null
      : value;
  if (!isRecord(body)) return null;
  const start = str(body["start_local"]).trim();
  const end = str(body["end_local"]).trim();
  if (!start || !end) return null;
  const enforcementRaw = str(body["enforcement"]).trim().toLowerCase();
  const weekdays = itemsOf(body["weekdays"] ?? [], "send window")
    .map((d) => str(d).trim())
    .filter((d) => d !== "");
  return {
    startLocal: start,
    endLocal: end,
    timezone: str(body["timezone"]).trim() || "UTC",
    weekdayBitmap: numberOr(body["weekday_bitmap"], 126),
    weekdays,
    enforcement: isSendWindowTier(enforcementRaw) ? enforcementRaw : "warn",
  };
}

export interface SendWindowSummary {
  tier: SendWindowTier;
  tierLabel: string;
  tone: SignalTone;
  /** The window itself, in one line. */
  windowLine: string;
  /** What the tier DOES, in one sentence — the part an operator acts on. */
  effect: string;
}

/**
 * The incident question is not "what is the window", it is "will this policy
 * stop my send right now". `block` is therefore the state that gets the loud
 * tone, even though nothing is broken — it is the one that refuses work.
 */
export function sendWindowSummary(
  policy: SendWindowPolicy | null | undefined,
): SendWindowSummary | null {
  if (!policy) return null;
  // The null check guards the POLICY, not its array field. A payload that
  // arrives without `weekdays` -- Go's `omitempty` on an empty slice, or any
  // partial object -- reaches `.length` on undefined and takes the screen
  // down. A window with no weekdays listed means every day, which is exactly
  // what the empty branch below already says.
  const weekdays = Array.isArray(policy.weekdays) ? policy.weekdays : [];
  const days =
    weekdays.length === 0
      ? "every day"
      : policy.weekdays.length === 7
        ? "every day"
        : policy.weekdays.join(", ");
  const windowLine = `${policy.startLocal}–${policy.endLocal} ${policy.timezone} · ${days}`;
  if (policy.enforcement === "block") {
    return {
      tier: "block",
      tierLabel: "Blocking",
      tone: "danger",
      windowLine,
      effect: "Sends scheduled outside this window are refused.",
    };
  }
  if (policy.enforcement === "warn") {
    return {
      tier: "warn",
      tierLabel: "Warning",
      tone: "warning",
      windowLine,
      effect: "Sends outside this window warn, but go out.",
    };
  }
  return {
    tier: "off",
    tierLabel: "Off",
    tone: "neutral",
    windowLine,
    effect: "The window is recorded but not enforced.",
  };
}

/* ------------------------------------------------------- push suppression - */

export interface PushSummary {
  total: number;
  /** Platform → count, largest first. */
  platforms: { key: string; label: string; count: number }[];
  /** Reason → count, largest first. */
  reasons: { key: string; label: string; count: number }[];
}

const PLATFORM_LABELS: Record<string, string> = {
  apns: "iOS",
  fcm: "Android",
  web: "Web",
};

const REASON_LABELS: Record<string, string> = {
  manual: "Added by hand",
  unregistered: "Token unregistered",
  expired: "Token expired",
  complaint: "Complaint",
  user_opt_out: "Opted out",
};

function tally(
  rows: readonly PushSuppressionRow[],
  pick: (row: PushSuppressionRow) => string,
  labels: Record<string, string>,
): { key: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  // Callers pass wire rows straight in; for-of on a non-array throws before a
  // single count is made.
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = pick(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: labels[key] ?? key.replace(/_/g, " "),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Tokens are hashed, so a per-row list is diagnostic rather than actionable.
 * The useful shape is therefore the ROLLUP: "are we still pushing at 400 dead
 * iOS tokens?" is the health check this answers.
 */
export function pushSummary(rows: readonly PushSuppressionRow[]): PushSummary {
  return {
    total: rows.length,
    platforms: tally(rows, (r) => r.platform, PLATFORM_LABELS),
    reasons: tally(rows, (r) => r.reason, REASON_LABELS),
  };
}
