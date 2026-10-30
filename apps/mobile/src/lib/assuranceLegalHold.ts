/**
 * lib/assuranceLegalHold.ts — the control that stops evidence being destroyed.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * ASSURE#6 / VERB#8: `POST /api/v1/assurance/legal-holds`, its list, and
 * `.../{holdID}/release` are mounted (assurancelegalholdapi/handlers.go:61-63) and
 * have NO CLIENT ON ANY SURFACE — not mobile, not desktop, not web. A compliance
 * control shipped with a route and no screen, so placing a hold required a direct
 * API call and releasing one required knowing an id nobody could list.
 *
 * A legal hold suspends the retention sweeps that would otherwise delete assurance
 * evidence. That makes it the one verb here whose absence is IRREVERSIBLE: every
 * other gap in this audit costs time or money, and this one loses evidence that
 * cannot be recreated once a sweep has run.
 *
 * Mobile's existing `legal_hold` code is a DIFFERENT subsystem — privacy-request
 * holds (`setPrivacyLegalHold`, api/settingsExtras.ts) and audit-row badges. Same
 * words, unrelated tables. This module is only about assurance evidence.
 *
 * ── SCOPE IS THE THING NOT TO MISREAD ──────────────────────────────────────
 * `campaign_id` is OPTIONAL, and omitting it places a TENANT-WIDE hold. The server
 * derives a `scope` field rather than leaving a reader to infer it from an empty
 * id, and its own comment says why: "'this hold covers everything' is exactly the
 * fact an operator must not misread during an incident" (handlers.go:78-80). So
 * the client renders the server's derived scope and never re-derives it.
 *
 * Import-free of react-native, so every rule is node-tested.
 */

export type LegalHoldScope = "tenant" | "campaign";

export interface AssuranceLegalHold {
  id: string;
  campaignId: string;
  scope: LegalHoldScope;
  reason: string;
  placedAt: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read a hold off the wire.
 *
 * The scope is taken from the server's own field. It is only re-derived when the
 * field is absent or unrecognised, and then it fails toward `tenant` — the WIDER
 * reading. Understating a hold's blast radius is the dangerous direction: an
 * operator who believes a hold covers one campaign may release it and destroy
 * evidence across the whole tenant.
 */
export function parseAssuranceLegalHold(
  raw: Record<string, unknown>,
): AssuranceLegalHold | null {
  const id = str(raw.id);
  if (!id) return null;
  const campaignId = str(raw.campaign_id);
  const declared = str(raw.scope).toLowerCase();
  const scope: LegalHoldScope =
    declared === "campaign" || declared === "tenant"
      ? (declared as LegalHoldScope)
      : campaignId
        ? "campaign"
        : "tenant";
  return {
    id,
    campaignId,
    scope,
    reason: str(raw.reason),
    placedAt: str(raw.placed_at),
  };
}

export function parseAssuranceLegalHolds(payload: unknown): AssuranceLegalHold[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { items?: unknown }).items)
      ? ((payload as { items: unknown[] }).items)
      : [];
  const out: AssuranceLegalHold[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const hold = parseAssuranceLegalHold(raw as Record<string, unknown>);
    if (hold) out.push(hold);
  }
  return out;
}

/** A reason is mandatory on BOTH place and release (handlers.go:144, :179 → 422). */
export function legalHoldReasonUsable(reason: string): boolean {
  return reason.trim().length > 0;
}

/** What a hold covers, said plainly enough that it cannot be skimmed wrong. */
export function legalHoldScopeSummary(hold: AssuranceLegalHold): string {
  return hold.scope === "tenant"
    ? "Covers EVERY campaign in this workspace. Assurance evidence is preserved workspace-wide until this is released."
    : `Covers campaign ${hold.campaignId}. Evidence for other campaigns is still swept normally.`;
}

/** The confirmation shown before releasing, which is the destructive direction. */
export function legalHoldReleaseCopy(hold: AssuranceLegalHold): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  return {
    title: "Release this legal hold?",
    body:
      hold.scope === "tenant"
        ? "Retention sweeps resume for EVERY campaign in this workspace. Evidence they delete cannot be recovered."
        : "Retention sweeps resume for this campaign. Evidence they delete cannot be recovered.",
    confirmLabel: "Release hold",
  };
}

export function legalHoldErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case "reason_required":
      return "A reason is required — it is the record of why evidence was preserved.";
    case "not_found":
      return "That hold no longer exists; it may have been released elsewhere.";
    default:
      return fallback;
  }
}
