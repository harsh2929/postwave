/**
 * consent-firewall-helpers — pure logic behind the Consent-Safe
 * Activation Firewall UI (feature #2; the firewall lives in
 * apps/api/internal/activation_firewall). JSX-free so the node vitest
 * suite can exercise the count math, the honest-UI sentinel handling,
 * and the destination → purpose copy directly.
 *
 * Honest-UI contract (mirrors AudiencePreviewPanel.tsx): nothing here
 * invents data. When the server returns the sentinel -1 (count
 * unavailable) we render "—" or an explicit "unavailable" — NEVER "0
 * excluded", which would be a lie when the wire is down. The pre-flight
 * count is an ESTIMATE (computed against current consent/suppression
 * state, not the state at run time), so the panel labels it as such; the
 * post-run excluded_count is exact and carries no Estimate badge.
 */

/**
 * Wire shape of GET /api/v1/audience-syncs/{id}/exclusion-preview.
 *
 * Canonical home is api-client.ts (added via the integration manifest);
 * it is mirrored here so this pure helper + its node vitest suite stay
 * standalone (the helper must not depend on the shared client being
 * edited first). The component imports the api-client copy; both shapes
 * are identical by contract.
 *
 * `audience_count === -1` is the sentinel for "source could not be
 * resolved" (the ghost-source guard); the other counts carry -1 only
 * when their sub-lookup was unavailable. Never coerce -1 to 0.
 */
export interface SyncExclusionPreview {
  /** -1 = unavailable (ghost source / wire down). */
  audience_count: number;
  excluded_consent: number;
  excluded_suppression: number;
  excluded_total: number;
  /** One of the five consent.Purpose values. */
  purpose: string;
  computed_at: string;
}

/** Server sentinel: a count the backend could not resolve. */
export const COUNT_UNAVAILABLE = -1;

/** True when the preview's audience source could not be resolved (the
 *  ghost-source guard returned the -1 sentinel for the population). */
export function isPreviewUnavailable(p: SyncExclusionPreview): boolean {
  return (p.audience_count ?? COUNT_UNAVAILABLE) < 0;
}

/**
 * Format a single count honestly: "—" for the -1 sentinel (or any
 * negative / non-finite value), grouped digits otherwise. Never coerces
 * a missing value to 0.
 */
export function formatCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  return n.toLocaleString();
}

/**
 * The number of excluded profiles to surface on the confirm button and
 * the runs slideover. Returns null when unavailable (so callers render a
 * neutral "Run now" rather than "Run now (−0 excluded)" — honest-UI: an
 * unknown count is not zero). 0 is a real, knowable answer and is
 * returned as 0.
 */
export function excludedTotal(p: SyncExclusionPreview): number | null {
  if (isPreviewUnavailable(p)) return null;
  const t = p.excluded_total;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return null;
  return t;
}

/**
 * The count that will actually be synced = audience − excluded. Returns
 * null when either input is unavailable (never a fabricated difference).
 */
export function willSyncCount(p: SyncExclusionPreview): number | null {
  if (isPreviewUnavailable(p)) return null;
  const audience = p.audience_count;
  const total = excludedTotal(p);
  if (total === null) return null;
  return Math.max(0, audience - total);
}

/**
 * The label for the confirm / run button. "Run now" when the count is
 * 0 or unavailable; "Run now (−N excluded)" when N > 0. The verb is
 * caller-supplied so the same helper drives both the page Run-Now button
 * and the modal confirm button.
 */
export function runButtonLabel(
  p: SyncExclusionPreview | null,
  verb = "Run now",
): string {
  if (!p) return verb;
  const n = excludedTotal(p);
  if (n === null || n <= 0) return verb;
  return `${verb} (−${n.toLocaleString()} excluded)`;
}

/**
 * Whether the Run-Now confirm modal is worth showing. Per the spec's
 * friction note: only interrupt with a confirm step when there is a
 * non-zero exclusion count to disclose. When the count is 0 or the
 * preview failed, the run proceeds directly (preserving the current
 * instant-run behaviour — the preview error is advisory, never a gate).
 */
export function shouldConfirmRun(p: SyncExclusionPreview | null): boolean {
  if (!p) return false;
  const n = excludedTotal(p);
  return n !== null && n > 0;
}

/** Human label for a consent.Purpose value. Falls back to the raw
 *  server string rather than guessing a prettier name for an enum we
 *  don't recognise (honest-UI: never invent a label). */
export function purposeLabel(purpose: string): string {
  switch ((purpose ?? "").trim()) {
    case "email_marketing":
      return "email marketing";
    case "sms_marketing":
      return "SMS marketing";
    case "profiling":
      return "profiling";
    case "targeted_ads":
      return "targeted ads";
    case "ai_processing":
      return "AI processing";
    default:
      return purpose || "unknown";
  }
}

/**
 * The "Purpose: targeted_ads (meta destination)" disclosure line. The
 * purpose is read from the server response (which derived it from the
 * destination type + any per-sync override), never fabricated
 * client-side. destType is optional context for the parenthetical.
 */
export function purposeDisclosure(
  p: SyncExclusionPreview,
  destType?: string,
): string {
  const base = `Purpose: ${purposeLabel(p.purpose)}`;
  const d = (destType ?? "").trim();
  return d ? `${base} (${d} destination)` : base;
}

/**
 * The breakdown clause: "(K by consent · L by suppression)". Returns ""
 * when both are 0 / unavailable so the caller can omit the parenthetical
 * entirely. Negative sentinels are treated as unknown and omitted.
 */
export function exclusionBreakdown(p: SyncExclusionPreview): string {
  const parts: string[] = [];
  if (typeof p.excluded_consent === "number" && p.excluded_consent > 0) {
    parts.push(`${p.excluded_consent.toLocaleString()} by consent`);
  }
  if (
    typeof p.excluded_suppression === "number" &&
    p.excluded_suppression > 0
  ) {
    parts.push(`${p.excluded_suppression.toLocaleString()} by suppression`);
  }
  return parts.length ? `(${parts.join(" · ")})` : "";
}
