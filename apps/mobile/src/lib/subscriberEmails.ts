/**
 * subscriberEmails — SUB-016 alternate addresses on one profile ("also reach
 * me at my work address"), phone-sized.
 *
 * Desktop's SubscriberEmailsSection translated. The rules this module owns:
 *
 *  - a profile caps at MAX_EMAILS_PER_PROFILE addresses, refused locally
 *    before the round-trip;
 *  - the PRIMARY address is identity: it cannot be removed here and its row
 *    says so (rotation is the subscriber editor's job, on the web);
 *  - per-address consent changes carry the SAME reviewed-evidence envelope
 *    as every other consent write on mobile (the body mirrors desktop's
 *    SubscriberEmailUpdateInput key for key);
 *  - suppression is its own axis (a suppressed address can still be
 *    "subscribed" — the hold is deliverability, not consent) and demands an
 *    operator reason.
 *
 * Import-free so every rule runs in the node vitest suite.
 */
import type { ConsentEvidenceDraft } from "@/lib/subscriberConsentEvidence";

/** Mirrors desktop's MAX_EMAILS_PER_PROFILE (server MaxEmailsPerProfile). */
export const MAX_EMAILS_PER_PROFILE = 5;

export interface SubscriberEmailRow {
  id: string;
  email: string;
  isPrimary: boolean;
  /** subscribed | unsubscribed | never_subscribed | pending | unknown. */
  consentStatus: string;
  suppressed: boolean;
  /** Strong address revision token — echoed as If-Match on PATCH/DELETE. */
  version: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GET {items} body, defensively. Primary-first order is the server's. */
export function parseSubscriberEmails(payload: unknown): SubscriberEmailRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.items)) return [];
  return rec.items.flatMap((row): SubscriberEmailRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    const email = str(r.email);
    if (!id || !email) return [];
    return [
      {
        id,
        email,
        isPrimary: r.is_primary === true,
        consentStatus: str(r.consent_status) || "unknown",
        suppressed: r.suppressed === true,
        version: str(r.version),
      },
    ];
  });
}

/** Human label per consent state — desktop's vocabulary. */
export function emailConsentLabel(status: string): string {
  switch (status) {
    case "subscribed":
      return "Subscribed";
    case "unsubscribed":
      return "Unsubscribed";
    case "never_subscribed":
      return "Never subscribed";
    case "pending":
      return "Pending";
    case "unknown":
      return "No recorded signal";
    default:
      return status;
  }
}

/** Why another address cannot be added right now, or null. */
export function addEmailProblem(
  rows: readonly SubscriberEmailRow[],
  candidate: string,
): string | null {
  if (rows.length >= MAX_EMAILS_PER_PROFILE) {
    return `A profile holds at most ${MAX_EMAILS_PER_PROFILE} addresses.`;
  }
  const trimmed = candidate.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "Enter a valid email address.";
  }
  if (rows.some((row) => row.email.toLowerCase() === trimmed.toLowerCase())) {
    return "That address is already on this profile.";
  }
  return null;
}

/**
 * POST body for attaching a secondary address. No consent fields: the
 * address arrives with no recorded signal, and granting consent is a
 * separate reviewed decision — the same two-step honesty as single create.
 */
export function buildAddEmailBody(email: string): Record<string, unknown> {
  return { email: email.trim() };
}

/**
 * PATCH body for one reviewed consent decision on one address — desktop's
 * SubscriberEmailUpdateInput consent variant, key for key.
 */
export function buildEmailConsentPatch(
  nextStatus: "subscribed" | "unsubscribed",
  draft: ConsentEvidenceDraft,
): Record<string, string> {
  return {
    consent_status: nextStatus,
    source: draft.source.trim(),
    channel: draft.channel.trim(),
    legal_basis: draft.legalBasis.trim(),
    occurred_at: new Date(Date.parse(draft.capturedAt)).toISOString(),
    jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    evidence: draft.evidence.trim(),
  };
}

/**
 * PATCH body for the suppression axis — the update input's other variant.
 * The reason is mandatory: an unexplained hold is unauditable.
 */
export function buildEmailSuppressionPatch(
  suppressed: boolean,
  reason: string,
): Record<string, unknown> | null {
  const trimmed = reason.trim();
  if (!trimmed) return null;
  return { suppressed, suppression_reason: trimmed };
}
