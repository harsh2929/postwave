/**
 * subscriberSuppression — is THIS contact on the deliverability
 * suppression list, and if so why?
 *
 * The profile used to answer that question from `subscriber.status ===
 * "blocklisted"`, which reads the SUBSCRIBERS row. Deliverability
 * suppressions live in a different table with their own reason, their own
 * timestamps and their own audit trail: a hard bounce recorded by the
 * bounce webhook suppresses an address without ever touching the
 * subscriber's status, so a profile could confidently show "Subscribed"
 * for someone the sender will never mail again.
 *
 * Import-free (vitest runs in a node environment), so the matching and
 * wording rules below are directly testable.
 */

/** The subset of `GET /api/v1/deliverability/suppressions` a profile needs. */
export interface SuppressionMatch {
  id: string;
  email: string;
  reason: string;
  createdAt: string;
}

interface RawSuppressionRow {
  id?: unknown;
  email?: unknown;
  reason?: unknown;
  created_at?: unknown;
}

/**
 * Find the row for exactly this address.
 *
 * The endpoint's `email=` filter is an exact citext match, so in the happy
 * path `items` is either empty or a single row. The address is re-checked
 * here anyway: a gateway build that does not understand `email=` returns
 * the unfiltered first page, and trusting it would paint a DANGER banner
 * — "this person is suppressed" — on a perfectly deliverable contact.
 * A false negative (we say nothing) is recoverable; a false positive on a
 * compliance surface is not.
 */
export function matchSuppressionForEmail(
  items: readonly unknown[] | undefined,
  email: string | undefined,
): SuppressionMatch | null {
  const address = (email ?? "").trim().toLowerCase();
  if (!address || !items?.length) return null;
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as RawSuppressionRow;
    const rowEmail =
      typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    if (rowEmail !== address) continue;
    return {
      id: typeof row.id === "string" && row.id ? row.id : address,
      email: rowEmail,
      reason: typeof row.reason === "string" ? row.reason.trim() : "",
      createdAt: typeof row.created_at === "string" ? row.created_at : "",
    };
  }
  return null;
}

/**
 * One sentence a screen reader can read instead of parsing a coloured
 * badge plus a relative timestamp. State is never colour-alone.
 *
 * `since` is the already-formatted relative or absolute time (the caller
 * owns locale formatting via src/lib/format.ts); empty when unknown, which
 * is stated rather than papered over with "just now".
 */
export function suppressionSpokenSummary(
  reasonText: string,
  since: string,
): string {
  const head = `Suppressed. Reason: ${reasonText || "unknown"}.`;
  return since ? `${head} Added ${since}.` : `${head} Date unknown.`;
}
