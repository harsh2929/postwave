/**
 * lib/privacyPortalOps.ts — the pure half of the privacy-portal operator
 * surface: the regions matrix, the consent-proof summary and the double
 * opt-in pending queue.
 *
 * WHY THESE LIVE ON THE COMPLIANCE SCREEN. Desktop renders them on
 * PrivacyPortal.tsx; mobile's equivalent operator surface is the Compliance
 * screen, which is already registered admin-only (mobileRoutesAdmin
 * `compliance`) — the same floor every `/privacy/portal/*` route carries in
 * the routeauth manifest (family:admin), so no affordance is ever shown to a
 * role that cannot use it.
 *
 * THE RESEND VERB IS DELIBERATELY CALLED "EXTEND". Desktop's
 * DoubleOptinPendingTable header records the finding: the `resend` endpoint
 * updates `sent_at` and pushes `expires_at` out by 60 days, and the actual
 * email is sent out-of-band by the consent worker watching `sent_at` — so
 * this surface never claims that another email was sent. The copy constants
 * below are that honesty, kept in one place.
 *
 * VALIDATION MIRRORS THE SERVER field for field
 * (privacy_portal/portal.go `RegionInput.Validate`): region_code required
 * (uppercased), framework must be one of the fixed set (lowercased).
 *
 * Import-free apart from lib/format, so everything here runs under the node
 * vitest environment.
 */
import { plural } from "@/lib/format";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/* ------------------------------------------------------------------ *
 * Regions matrix
 * ------------------------------------------------------------------ */

/** Mirrors privacy_portal.Region (Go). */
export interface PrivacyRegionRow {
  id: string;
  regionCode: string;
  framework: string;
  requiresDoubleOptIn: boolean;
  requiresExplicitConsent: boolean;
  doNotSellDefault: boolean;
  gpcHonored: boolean;
}

/**
 * Mirrors `validFrameworks` (privacy_portal/portal.go). Order is display
 * order: the two regimes operators actually configure lead.
 */
export const PRIVACY_FRAMEWORKS = [
  "gdpr",
  "ccpa",
  "lgpd",
  "pipeda",
  "apo",
  "other",
] as const;
export type PrivacyFramework = (typeof PRIVACY_FRAMEWORKS)[number];

/** Parse a `{regions: [...]}` payload (GET /privacy/portal or /portal/regions). */
export function parsePrivacyRegions(raw: unknown): PrivacyRegionRow[] {
  if (!isRecord(raw) || !Array.isArray(raw.regions)) return [];
  const out: PrivacyRegionRow[] = [];
  for (const entry of raw.regions) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const regionCode = str(entry.region_code);
    if (!id || !regionCode) continue;
    out.push({
      id,
      regionCode,
      framework: str(entry.framework) || "other",
      requiresDoubleOptIn: entry.requires_double_optin === true,
      requiresExplicitConsent: entry.requires_explicit_consent === true,
      doNotSellDefault: entry.do_not_sell_default === true,
      gpcHonored: entry.gpc_honored === true,
    });
  }
  return out;
}

/**
 * null when the input would be accepted; otherwise the sentence to show.
 * The same two checks the server performs, so a rejection is caught before
 * a cellular round trip — the server remains the authority.
 */
export function regionInputIssue(
  regionCode: string,
  framework: string,
): string | null {
  if (!regionCode.trim()) return "A region code is required.";
  if (!PRIVACY_FRAMEWORKS.includes(framework.trim().toLowerCase() as PrivacyFramework)) {
    return "Pick one of the listed frameworks.";
  }
  return null;
}

/** The one-line obligations summary under a region row. */
export function regionObligationsLine(row: PrivacyRegionRow): string {
  const parts: string[] = [];
  if (row.requiresDoubleOptIn) parts.push("double opt-in");
  if (row.requiresExplicitConsent) parts.push("explicit consent");
  if (row.doNotSellDefault) parts.push("do-not-sell by default");
  if (row.gpcHonored) parts.push("GPC honored");
  return parts.length > 0 ? parts.join(" · ") : "No extra obligations flagged.";
}

/* ------------------------------------------------------------------ *
 * Consent proof summary
 * ------------------------------------------------------------------ */

/** Mirrors privacy_portal.ConsentProofSummary (Go). */
export interface ConsentProofRow {
  source: string;
  count: number;
}

/**
 * Parse `consent_proof_summary` out of the GET /privacy/portal payload.
 * Returns null when the FIELD is absent (an older server — say nothing),
 * and an empty array when it is present but empty (an honest "no proof
 * recorded", which the card must say rather than hide).
 */
export function parseConsentProofSummary(raw: unknown): ConsentProofRow[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.consent_proof_summary)) return null;
  const out: ConsentProofRow[] = [];
  for (const entry of raw.consent_proof_summary) {
    if (!isRecord(entry)) continue;
    const source = str(entry.source);
    if (!source) continue;
    out.push({ source, count: num(entry.count) });
  }
  return out;
}

/** Total receipts across sources — the headline number. */
export function consentProofTotal(rows: readonly ConsentProofRow[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/* ------------------------------------------------------------------ *
 * Double opt-in pending queue
 * ------------------------------------------------------------------ */

/** Mirrors privacy_portal.PendingDoubleOptIn (Go). */
export interface PendingDoubleOptin {
  id: string;
  email: string;
  listId: string;
  sentAt: string;
  expiresAt: string;
}

export interface PendingDoubleOptinPage {
  rows: PendingDoubleOptin[];
  /** Non-empty when the server has more rows than this page. */
  nextCursor: string;
}

/** Parse GET /privacy/portal/double-optin/pending. */
export function parsePendingDoubleOptins(raw: unknown): PendingDoubleOptinPage {
  if (!isRecord(raw) || !Array.isArray(raw.pending)) {
    return { rows: [], nextCursor: "" };
  }
  const rows: PendingDoubleOptin[] = [];
  for (const entry of raw.pending) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    if (!id) continue;
    rows.push({
      id,
      email: str(entry.email),
      listId: str(entry.list_id),
      sentAt: str(entry.sent_at),
      expiresAt: str(entry.expires_at),
    });
  }
  return { rows, nextCursor: str(raw.nextCursor) };
}

/**
 * "expires in 12 days" / "expires today" / "expired 3 days ago" — the fact an
 * operator triages by. An unparseable timestamp yields the timestamp itself
 * rather than a fabricated relative claim.
 */
export function doubleOptinExpiryLabel(expiresAt: string, nowMs: number): string {
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return expiresAt || "no expiry recorded";
  const diffDays = Math.trunc((ts - nowMs) / 86_400_000);
  if (diffDays > 0) return `expires in ${plural(diffDays, "day")}`;
  if (diffDays < 0) return `expired ${plural(-diffDays, "day")} ago`;
  return "expires today";
}

/**
 * The extend verb's honest copy. The endpoint is named "resend" but what it
 * verifiably does is move `sent_at`/`expires_at`; the confirmation email is
 * the consent worker's out-of-band job. Desktop records the same doctrine.
 */
export const DOUBLE_OPTIN_EXTEND_COPY =
  "Extends the confirmation window by 60 days and marks the row re-sent. The confirmation email itself is delivered by the consent worker — this action does not directly send mail.";

export const DOUBLE_OPTIN_CANCEL_COPY =
  "Deletes the pending row. The subscriber stays unconfirmed and will not be mailed; they can opt in again at any time. This cannot be undone from here.";
