/**
 * suppression-search — pure helpers behind the Suppressions page's
 * server-side search and reason-chip filtering.
 *
 * Server reality (apps/api/internal/suppressions/handlers.go List):
 *   GET /api/v1/deliverability/suppressions?email=&q=
 *   - `email` is an EXACT citext match (case-insensitive)
 *   - `q` is a case-insensitive email PREFIX filter
 *
 * classifySearchQuery decides which of those (if either) a raw search
 * box value can use:
 *   - "exact"  — the value parses as a full email → `email=`
 *   - "prefix" — ≥3 chars → `q=` (shorter prefixes would scan-storm
 *                the citext index and match half the table anyway)
 *   - "client" — 1–2 chars: too short for the server; filter the
 *                loaded page client-side only
 *   - "none"   — empty query
 */

/** Same shape the Add-suppression form validates against. */
const FULL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Minimum length before we round-trip a prefix search to the server. */
export const SERVER_SEARCH_MIN_PREFIX = 3;

export type SearchMode = "none" | "client" | "prefix" | "exact";

export interface ClassifiedQuery {
  mode: SearchMode;
  /** Trimmed, lowercased value to send (or filter with). */
  value: string;
}

export function classifySearchQuery(raw: string): ClassifiedQuery {
  const value = raw.trim().toLowerCase();
  if (!value) return { mode: "none", value: "" };
  if (FULL_EMAIL_RE.test(value)) return { mode: "exact", value };
  if (value.length >= SERVER_SEARCH_MIN_PREFIX) return { mode: "prefix", value };
  return { mode: "client", value };
}

/** Reason chips offered by the Suppressions page. */
export type SuppressionFilter =
  | "all"
  | "hard_bounce"
  | "soft_bounce"
  | "complaint"
  | "spamtrap"
  | "delivery_issue"
  | "manual"
  | "unsubscribe";

/**
 * Chip → stored reason values. The legacy table stores free-form
 * values ("complaint", "manual", "unsubscribe"); the converged X1
 * store uses the canonical enum ("spam_complaint",
 * "manual_unsubscribe", …). Server-side search returns X1 rows, so
 * the chips must match both families.
 *
 * SUB-047 / SUB-048 widened the taxonomy (suppressions/store.go) to the
 * Klaviyo-compatible set. The chips group it into operator-meaningful
 * buckets: a hard `hard_bounce`, the transient `soft_bounce` family,
 * `complaint`, `spamtrap`, and a catch-all "Delivery issues" bucket for
 * the address-quality signals (role_account / dns_failure /
 * invalid_address / list_unsub_header).
 *
 * KEPT IN LOCKSTEP WITH MOBILE, BY A TEST. Mobile carries the same table in
 * apps/mobile/src/lib/suppressionSearch.ts, and the two had already drifted:
 * this copy bucketed only the canonical `hard_bounce`, so a legacy
 * `email_suppressions` row reading `bounce`/`hardbounce` — which the converger
 * still serves through v_suppressions_unified — was invisible under the Hard
 * bounce chip HERE and visible on the phone. The alias sets below are now the
 * union, and `apps/mobile/src/lib/suppressionReasonContract.test.ts` fails the
 * build if either client learns a reason the other has not, or if the Go enum
 * (suppressions.ValidReasons) grows one that neither has.
 */
export const FILTER_REASON_ALIASES: Readonly<
  Record<Exclude<SuppressionFilter, "all">, readonly string[]>
> = {
  hard_bounce: ["hard_bounce", "hardbounce", "bounce"],
  soft_bounce: ["soft_bounce", "soft_bounce_threshold"],
  complaint: ["complaint", "spam_complaint"],
  spamtrap: ["spamtrap", "spam_trap"],
  delivery_issue: [
    "role_account",
    "role_address",
    "dns_failure",
    "invalid_address",
    "invalid_email",
    "list_unsub_header",
    "blocklist_auto",
  ],
  // `dsar_deletion` matched no chip at all until now: an erasure-request row
  // was reachable only through "All". It is neither a bounce nor a marketing
  // unsubscribe, so it files under the operator-placed hold.
  manual: ["manual", "list_manual", "admin", "blocklisted", "dsar_deletion"],
  unsubscribe: [
    "unsubscribe",
    "unsubscribed",
    "manual_unsubscribe",
    "global_unsubscribe",
  ],
};

export function reasonMatchesFilter(
  reason: string | undefined,
  filter: SuppressionFilter,
): boolean {
  if (filter === "all") return true;
  const r = (reason ?? "").toLowerCase();
  return FILTER_REASON_ALIASES[filter].includes(r);
}
