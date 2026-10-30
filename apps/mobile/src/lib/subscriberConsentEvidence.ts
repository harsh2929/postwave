/**
 * subscriberConsentEvidence — the reviewed-evidence envelope a consent GRANT
 * must carry, shared by the profile's Resubscribe review and the per-channel
 * consent card.
 *
 * WHY THIS EXISTS ON MOBILE AT ALL. The phone's Resubscribe used to be a bare
 * `status: enabled` PATCH. The server accepts that — but desktop's identical
 * button routes through SubscriberStatusConsentModal and records WHO decided,
 * on what evidence, under which jurisdiction and policy. So the same tap
 * produced a compliance-strong grant from a desk and a compliance-weak one
 * from a phone, and an auditor reading the ledger could not tell the
 * difference. This module is the phone's half of that contract.
 *
 * The vocabularies MIRROR desktop's `consent-evidence.ts` verbatim — the two
 * clients write into one ledger and a value invented here would be a new
 * provenance category desktop's review tooling has never heard of.
 *
 * The STATUS grant (PATCH /subscribers/{id} with `status:"enabled"`) is
 * narrower than the general envelope: desktop's modal only accepts
 * double_optin / single_optin as the provenance of an email-marketing
 * re-enable, so `CONSENT_RESUBSCRIBE_SOURCES` is that subset.
 *
 * Import-free so every rule is unit-tested in the node vitest run.
 */

export interface ConsentVocabOption {
  value: string;
  label: string;
}

/** Where the evidence came from (full set — channel consents accept all). */
export const CONSENT_EVIDENCE_SOURCES: readonly ConsentVocabOption[] = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
  { value: "preference_center", label: "Preference center" },
  { value: "signed_form", label: "Signed form or contract" },
  { value: "direct_request", label: "Direct subscriber request" },
];

/**
 * The subset a STATUS re-enable accepts. Desktop's SubscriberStatusConsentModal
 * refuses anything but a reviewed opt-in record for an email-marketing grant.
 */
export const CONSENT_RESUBSCRIBE_SOURCES: readonly ConsentVocabOption[] = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
];

/** Where the subscriber's decision was CAPTURED. */
export const CONSENT_EVIDENCE_CHANNELS: readonly ConsentVocabOption[] = [
  { value: "mobile", label: "Mobile app" },
  { value: "desktop", label: "Admin desktop" },
  { value: "web", label: "Web form" },
  { value: "email", label: "Email confirmation" },
  { value: "import", label: "Verified import evidence" },
  { value: "api", label: "Verified API evidence" },
];

export const CONSENT_LEGAL_BASES: readonly ConsentVocabOption[] = [
  { value: "consent", label: "Consent" },
  { value: "contract", label: "Contract" },
  { value: "legitimate_interest", label: "Legitimate interest" },
  { value: "legal_obligation", label: "Legal obligation" },
];

/** Mirrors desktop's JURISDICTION_PATTERN. "EU", "US-CA", "GB", … */
const JURISDICTION_RE = /^[A-Z][A-Z0-9-]{1,31}$/;

export interface ConsentEvidenceDraft {
  /** One of the source vocab values. */
  source: string;
  /** One of the capture-channel vocab values. */
  channel: string;
  /** One of the legal-basis vocab values. */
  legalBasis: string;
  /** ISO timestamp the decision was captured. Seeded to "now" by the sheet. */
  capturedAt: string;
  /** Uppercased jurisdiction code, e.g. "EU" or "US-CA". */
  jurisdiction: string;
  /** Durable evidence reference — ticket id, recording ref, form URL. */
  evidence: string;
  /** Why this change is being recorded. */
  reason: string;
  /** The privacy-policy version in force. */
  policyVersion: string;
}

export function emptyConsentEvidenceDraft(
  now: Date = new Date(),
): ConsentEvidenceDraft {
  return {
    source: "",
    channel: "mobile",
    legalBasis: "",
    capturedAt: now.toISOString(),
    jurisdiction: "",
    evidence: "",
    reason: "",
    policyVersion: "",
  };
}

function inVocab(
  vocab: readonly ConsentVocabOption[],
  value: string,
): boolean {
  const v = value.trim();
  return vocab.some((option) => option.value === v);
}

/**
 * First blocking problem with the draft, or null when it is submittable.
 * One sentence at a time — the sheet is a phone form, not a desktop error
 * summary, and the first unmet requirement is the one the thumb should fix.
 */
export function consentEvidenceProblem(
  draft: ConsentEvidenceDraft,
  options: {
    /** Restrict `source` to the status-grant subset. */
    sources?: readonly ConsentVocabOption[];
    /** A GRANT needs a durable evidence reference; a revoke does not. */
    requireEvidence: boolean;
  },
  now: number = Date.now(),
): string | null {
  const sources = options.sources ?? CONSENT_EVIDENCE_SOURCES;
  if (!inVocab(sources, draft.source)) {
    return "Choose the reviewed opt-in record that proves this decision.";
  }
  if (!inVocab(CONSENT_EVIDENCE_CHANNELS, draft.channel)) {
    return "Choose where the decision was captured.";
  }
  if (!inVocab(CONSENT_LEGAL_BASES, draft.legalBasis)) {
    return "Choose the legal basis.";
  }
  const captured = Date.parse(draft.capturedAt);
  if (!Number.isFinite(captured)) {
    return "The captured time is not a readable date.";
  }
  if (captured > now + 5 * 60_000) {
    return "The captured time cannot be in the future.";
  }
  const jurisdiction = draft.jurisdiction.trim().toUpperCase();
  if (!JURISDICTION_RE.test(jurisdiction)) {
    return "Enter the governing jurisdiction as a code like EU, GB, or US-CA.";
  }
  const evidence = draft.evidence.trim();
  if (options.requireEvidence && !evidence) {
    return "Enter a durable evidence reference — a ticket, recording, or form.";
  }
  if (evidence.length > 2048) {
    return "The evidence reference must be 2,048 characters or fewer.";
  }
  const reason = draft.reason.trim();
  if (!reason) return "Explain why this change is being recorded.";
  if (reason.length > 500) {
    return "The reason must be 500 characters or fewer.";
  }
  const policy = draft.policyVersion.trim();
  if (!policy) return "Enter the policy version in force.";
  if (policy.length > 100) {
    return "The policy version must be 100 characters or fewer.";
  }
  return null;
}

/**
 * The PATCH /api/v1/subscribers/{id} body that re-enables WITH evidence —
 * desktop's `SubscriberEnableConsentInput`, key for key. Null when the draft
 * is not submittable, so a caller can never post half an envelope.
 */
export function buildResubscribeConsentPatch(
  draft: ConsentEvidenceDraft,
  now: number = Date.now(),
): Record<string, string> | null {
  if (
    consentEvidenceProblem(
      draft,
      { sources: CONSENT_RESUBSCRIBE_SOURCES, requireEvidence: true },
      now,
    )
  ) {
    return null;
  }
  return {
    status: "enabled",
    consent_source: draft.source.trim(),
    consent_timestamp: new Date(Date.parse(draft.capturedAt)).toISOString(),
    consent_channel: draft.channel.trim(),
    consent_legal_basis: draft.legalBasis.trim(),
    consent_jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    consent_evidence: draft.evidence.trim(),
    consent_reason: draft.reason.trim(),
    consent_policy_version: draft.policyVersion.trim(),
  };
}

/**
 * The PATCH /subscribers/{id}/channel-consents/{channel} body — the server's
 * `UpdateChannelConsentInput`, key for key. `nextStatus` is opted_in or
 * opted_out; a revoke still carries the envelope (who decided, on what
 * grounds) but does not demand a durable opt-in artifact.
 */
export function buildChannelConsentBody(
  draft: ConsentEvidenceDraft,
  nextStatus: "opted_in" | "opted_out",
  now: number = Date.now(),
): Record<string, string> | null {
  if (
    consentEvidenceProblem(
      draft,
      { requireEvidence: nextStatus === "opted_in" },
      now,
    )
  ) {
    return null;
  }
  return {
    status: nextStatus,
    consent_source: draft.source.trim(),
    consent_timestamp: new Date(Date.parse(draft.capturedAt)).toISOString(),
    evidence_channel: draft.channel.trim(),
    legal_basis: draft.legalBasis.trim(),
    evidence: draft.evidence.trim(),
    jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    reason: draft.reason.trim(),
    policy_version: draft.policyVersion.trim(),
  };
}
