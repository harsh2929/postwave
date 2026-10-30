/**
 * lib/portableConsentReceipt.ts — the ISO 27560 / Kantara CR v1.1 receipt a
 * data subject is actually owed, parsed for a phone.
 *
 * WHY THIS IS NOT THE CONSENT LEDGER ALREADY ON THE PROFILE.
 * `lib/subscriberRecordHistory` parses `GET /api/v1/consent/receipts/by-email`
 * — our internal append-only change log, which answers "can we prove they
 * opted in". This module parses a different document:
 *
 *   GET /api/v1/subscribers/{id}/consent-receipt.json
 *       apps/api/internal/subscribers/consent_receipt_export.go:75, mounted
 *       behind apikeys.RequireScope(apikeys.ScopeAdmin) — which is NOT in
 *       `readOnlyScopes` (apikeys/middleware.go:331-336), so on a session
 *       cookie it is a hard owner|admin ROLE check. A viewer or editor gets a
 *       403 and the UI must not offer the action at all.
 *
 * That document is the PORTABLE artefact: a Kantara Consent Receipt v1.1
 * (`ConsentReceiptJSON`, subscribers/types.go:768-792) that an identity wallet
 * — or a person exercising a subject-access right — can ingest without a
 * custom mapping. Handing it over IS the per-subject half of a DSAR.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not create a DSAR
 * lifecycle record. `POST /api/v1/privacy/export-requests` takes a body of
 * exactly `{region, notes}` (`workflowRequest`, privacy/handlers.go:41-44) and
 * inserts the row with `subject_type` hardcoded to `'tenant_admin'`
 * (`insertPrivacyRequest`, :403). There is no field on that endpoint for a
 * subscriber id or a subject email, so a "request a DSAR for this person"
 * button on a profile would file a TENANT-WIDE export that names nobody — a
 * record that looks like it tracks Ada's request and does not. The honest
 * per-profile action is the one that hands over a real document, which is
 * this one, and the tenant queue stays where it already lives (Settings →
 * Privacy, `PrivacyRequestQueue`).
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** One consent purpose and its current state-of-record. */
export interface ReceiptPurpose {
  /** Machine key: email_marketing, sms_marketing, profiling, … */
  purpose: string;
  /** Human label derived from the key; the key itself when unrecognised. */
  label: string;
  /** Kantara consent basis, e.g. "EXPLICIT". "" when the server omitted it. */
  consentType: string;
  active: boolean;
  /** ISO grant timestamp; "" when the purpose was never granted. */
  grantedAt: string;
}

export interface PortableConsentReceipt {
  /** Schema id, e.g. "KI-CR-v1.1". "" when the server omitted it. */
  version: string;
  jurisdiction: string;
  /** Stable per-receipt identifier. "" when absent — never a fabricated id. */
  receiptId: string;
  /** ISO generation timestamp; "" when unparseable. */
  generatedAt: string;
  /** The data subject's email, as the server spelled it. */
  subjectEmail: string;
  subjectProfileId: string;
  controllerName: string;
  controllerContact: string;
  policyUri: string;
  purposes: ReceiptPurpose[];
  /** How many entries the append-only history block carried. */
  historyCount: number;
}

const PURPOSE_LABELS: Record<string, string> = {
  email_marketing: "Email marketing",
  sms_marketing: "SMS marketing",
  profiling: "Profiling",
  targeted_ads: "Targeted ads",
  ai_processing: "AI processing",
};

/**
 * A human label for a purpose key.
 *
 * An unrecognised key is returned VERBATIM rather than prettified. These keys
 * are a regulatory vocabulary; inventing "Some Other Purpose" from
 * `some_other_purpose` would put words into a compliance document.
 */
export function purposeLabel(key: string): string {
  return PURPOSE_LABELS[key] ?? key;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoOf(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  return Number.isNaN(Date.parse(raw)) ? "" : raw;
}

/**
 * Parse the receipt document.
 *
 * Returns null — not an empty receipt — when the payload is not an object or
 * carries no subject. A blank receipt rendered as if it were real is the one
 * outcome a compliance surface must never produce.
 */
export function parsePortableReceipt(
  payload: unknown,
): PortableConsentReceipt | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const subjectEmail = str(raw.piiPrincipalId);
  const receiptId = str(raw.consentReceiptID);
  if (!subjectEmail && !receiptId) return null;

  const controller =
    raw.piiController && typeof raw.piiController === "object"
      ? (raw.piiController as Record<string, unknown>)
      : {};
  const services = Array.isArray(raw.services) ? raw.services : [];
  const history = Array.isArray(raw.history) ? raw.history : [];

  const purposes: ReceiptPurpose[] = [];
  for (const entry of services) {
    if (!entry || typeof entry !== "object") continue;
    const service = entry as Record<string, unknown>;
    const purpose = str(service.purpose);
    if (!purpose) continue;
    purposes.push({
      purpose,
      label: purposeLabel(purpose),
      consentType: str(service.consentType),
      active: service.active === true,
      grantedAt: isoOf(service.grantedAt),
    });
  }

  return {
    version: str(raw.version),
    jurisdiction: str(raw.jurisdiction),
    receiptId,
    generatedAt: isoOf(raw.consentTimestamp),
    subjectEmail,
    subjectProfileId: str(raw.subjectProfileId),
    controllerName: str(controller.piiControllerName),
    controllerContact: str(controller.contact),
    policyUri: str(raw.policyUri),
    purposes,
    historyCount: history.length,
  };
}

/** How many purposes currently carry a grant. */
export function activePurposeCount(receipt: PortableConsentReceipt): number {
  return receipt.purposes.reduce(
    (total, purpose) => (purpose.active ? total + 1 : total),
    0,
  );
}

/**
 * The one-line description of what is about to be handed over.
 *
 * States the two counts a person exercising a subject-access right will
 * compare against their own memory: how many purposes they are recorded as
 * having agreed to, and how many recorded changes sit behind that. Says "no
 * purposes recorded" rather than "0 of 0" so an empty vector reads as a fact
 * rather than as a broken render.
 */
export function receiptSummary(receipt: PortableConsentReceipt): string {
  if (receipt.purposes.length === 0) {
    return "No consent purposes are recorded for this person.";
  }
  const active = activePurposeCount(receipt);
  const purposes = `${active} of ${receipt.purposes.length} ${
    receipt.purposes.length === 1 ? "purpose" : "purposes"
  } currently granted`;
  const changes =
    receipt.historyCount === 0
      ? "no recorded changes"
      : `${receipt.historyCount} recorded ${
          receipt.historyCount === 1 ? "change" : "changes"
        }`;
  return `${purposes}, ${changes}.`;
}

/**
 * A stable filename for the handed-over document.
 *
 * Mirrors the server's own ZIP naming
 * (`subscriber-%s-consent-receipt-%s.zip`,
 * consent_receipt_export.go:118) so a receipt copied from the phone and one
 * downloaded from the web admin are recognisably the same artefact.
 */
export function receiptFilename(
  receipt: PortableConsentReceipt,
  subscriberId: string,
): string {
  const day = (receipt.generatedAt || new Date().toISOString()).slice(0, 10);
  const id = (subscriberId || receipt.receiptId || "unknown").trim();
  return `subscriber-${id}-consent-receipt-${day}.json`;
}
