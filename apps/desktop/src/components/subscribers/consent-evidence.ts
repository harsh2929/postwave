export const CONSENT_PROVENANCE_SOURCES = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
  { value: "preference_center", label: "Preference center" },
  { value: "signed_form", label: "Signed form or contract" },
  { value: "direct_request", label: "Direct subscriber request" },
] as const;

export const CONSENT_EVIDENCE_CHANNELS = [
  { value: "desktop", label: "Admin desktop" },
  { value: "web", label: "Web form" },
  { value: "mobile", label: "Mobile app" },
  { value: "email", label: "Email confirmation" },
  { value: "import", label: "Verified import evidence" },
  { value: "api", label: "Verified API evidence" },
] as const;

export const CONSENT_LEGAL_BASES = [
  { value: "consent", label: "Consent" },
  { value: "contract", label: "Contract" },
  { value: "legitimate_interest", label: "Legitimate interest" },
  { value: "legal_obligation", label: "Legal obligation" },
] as const;

export interface ConsentEvidenceDraft {
  source: string;
  channel: string;
  legalBasis: string;
  occurredAt: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policyVersion: string;
  scopeAcknowledged: boolean;
  confirmation: string;
}

export interface ConsentEvidencePayload {
  source: string;
  channel: string;
  legal_basis: string;
  occurred_at: string;
  jurisdiction: string;
  evidence: string;
  reason: string;
  policy_version: string;
}

export function emptyConsentEvidenceDraft(): ConsentEvidenceDraft {
  return {
    source: "",
    channel: "",
    legalBasis: "",
    occurredAt: "",
    jurisdiction: "",
    evidence: "",
    reason: "",
    policyVersion: "",
    scopeAcknowledged: false,
    confirmation: "",
  };
}

export function consentEvidencePayload(
  draft: ConsentEvidenceDraft,
): ConsentEvidencePayload | null {
  const parsed = new Date(draft.occurredAt);
  if (!Number.isFinite(parsed.getTime())) return null;
  return {
    source: draft.source.trim(),
    channel: draft.channel.trim(),
    legal_basis: draft.legalBasis.trim(),
    occurred_at: parsed.toISOString(),
    jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    evidence: draft.evidence.trim(),
    reason: draft.reason.trim(),
    policy_version: draft.policyVersion.trim(),
  };
}

export function consentEvidenceError(
  draft: ConsentEvidenceDraft,
  options: { requireEvidence: boolean; requireScope: boolean },
): string | null {
  const payload = consentEvidencePayload(draft);
  if (
    !CONSENT_PROVENANCE_SOURCES.some(
      (option) => option.value === draft.source.trim(),
    )
  ) {
    return "Select where the evidence came from.";
  }
  if (
    !CONSENT_EVIDENCE_CHANNELS.some(
      (option) => option.value === draft.channel.trim(),
    )
  ) {
    return "Select the capture channel.";
  }
  if (
    !CONSENT_LEGAL_BASES.some(
      (option) => option.value === draft.legalBasis.trim(),
    )
  ) {
    return "Select the legal basis.";
  }
  if (!payload) return "Enter the date and time the decision was captured.";
  if (new Date(payload.occurred_at).getTime() > Date.now() + 5 * 60_000) {
    return "The captured time cannot be in the future.";
  }
  if (!payload.jurisdiction) return "Enter the governing jurisdiction.";
  if (payload.jurisdiction.length > 32) {
    return "Jurisdiction must be 32 characters or fewer.";
  }
  if (options.requireEvidence && !payload.evidence) {
    return "Enter a durable evidence reference.";
  }
  if (payload.evidence.length > 2_048) {
    return "Evidence reference must be 2,048 characters or fewer.";
  }
  if (!payload.reason) return "Explain why this change is being recorded.";
  if (payload.reason.length > 500) {
    return "Reason must be 500 characters or fewer.";
  }
  if (!payload.policy_version) return "Enter the policy version in force.";
  if (payload.policy_version.length > 100) {
    return "Policy version must be 100 characters or fewer.";
  }
  if (options.requireScope && !draft.scopeAcknowledged) {
    return "Review and acknowledge the exact scope before continuing.";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Subscriber CSV import: positive-consent proof is a narrower contract. */
/* ------------------------------------------------------------------ */

export const IMPORT_CONSENT_SCOPE = "email_marketing" as const;
export const IMPORT_CONSENT_CONTRACT_VERSION =
  "subscriber-import-consent/v1" as const;
export const IMPORT_CONSENT_CONFIRMATION = "EMAIL MARKETING";

export const IMPORT_CONSENT_SOURCES = [
  { value: "double_optin", label: "Double opt-in confirmation" },
  { value: "single_optin", label: "Single opt-in record" },
  { value: "signed_form", label: "Signed form or contract" },
  { value: "preference_center", label: "Preference center" },
  { value: "direct_request", label: "Direct subscriber request" },
] as const;

export type ImportConsentSource = (typeof IMPORT_CONSENT_SOURCES)[number]["value"];
export type ImportConsentMode = "none" | "verified";

export interface ImportConsentDraft {
  mode: ImportConsentMode;
  source: "" | ImportConsentSource;
  sourceUrl: string;
  capturedAtLocal: string;
  jurisdiction: string;
  reason: string;
  policyVersion: string;
  evidenceReference: string;
  scopeAcknowledged: boolean;
  typedConfirmation: string;
}

export interface ImportConsentPatch {
  consent_scope_acknowledged: boolean;
  consent_source?: ImportConsentSource;
  consent_source_url?: string;
  consent_captured_at?: string;
  consent_legal_basis?: "consent";
  consent_jurisdiction?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  consent_evidence_reference?: string;
  consent_scope?: typeof IMPORT_CONSENT_SCOPE;
}

export type ImportConsentField =
  | "source"
  | "sourceUrl"
  | "capturedAtLocal"
  | "jurisdiction"
  | "reason"
  | "policyVersion"
  | "evidenceReference"
  | "scopeAcknowledged"
  | "typedConfirmation";

export type ImportConsentErrors = Partial<Record<ImportConsentField, string>>;

const IMPORT_CONSENT_URL_MAX = 2_048;
const IMPORT_CONSENT_REASON_MAX = 500;
const IMPORT_CONSENT_POLICY_MAX = 100;
const IMPORT_CONSENT_EVIDENCE_MAX = 288;
const IMPORT_JURISDICTION_RE = /^[A-Z][A-Z0-9-]{1,31}$/;
const IMPORT_EVIDENCE_RE =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;
const UNSAFE_SECRET_RE =
  /(?:bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|secret=|signature=|x-amz-signature|sk-[a-z0-9_-]{8,})/i;
const UNSAFE_QUERY_KEY_RE =
  /(?:^|_)(?:key|token|secret|password|passwd|signature|sig|code|credential)(?:$|_)/i;
const UNSAFE_PII_RE =
  /([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}|\b[0-9]{3}[- ][0-9]{2}[- ][0-9]{4}\b|\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|\b(?:[0-9][ -]?){12,18}[0-9]\b)/i;

export function emptyImportConsentDraft(): ImportConsentDraft {
  return {
    mode: "none",
    source: "",
    sourceUrl: "",
    capturedAtLocal: "",
    jurisdiction: "",
    reason: "",
    policyVersion: "",
    evidenceReference: "",
    scopeAcknowledged: false,
    typedConfirmation: "",
  };
}

export function clearImportConsentFields(
  mode: ImportConsentMode = "none",
): ImportConsentDraft {
  return { ...emptyImportConsentDraft(), mode };
}

function importConsentTimestamp(raw: string): string | null {
  if (raw.trim() === "") return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function safeConsentUrl(raw: string): boolean {
  if (raw.length < 1 || raw.length > IMPORT_CONSENT_URL_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.host === "" || url.username || url.password) {
    return false;
  }
  if ([...url.searchParams.keys()].some((key) => UNSAFE_QUERY_KEY_RE.test(key))) {
    return false;
  }
  return !UNSAFE_SECRET_RE.test(raw);
}

export function validateImportConsentDraft(
  draft: ImportConsentDraft,
  now = Date.now(),
): ImportConsentErrors {
  if (draft.mode === "none") return {};
  const errors: ImportConsentErrors = {};
  const source = draft.source.trim();
  if (!IMPORT_CONSENT_SOURCES.some((option) => option.value === source)) {
    errors.source = "Choose the first-party record that proves this grant.";
  }
  const sourceUrl = draft.sourceUrl.trim();
  if (!safeConsentUrl(sourceUrl)) {
    errors.sourceUrl =
      "Use an absolute HTTPS evidence URL without credentials or secret-bearing query parameters.";
  }
  const capturedAt = importConsentTimestamp(draft.capturedAtLocal);
  if (!capturedAt) {
    errors.capturedAtLocal = "Enter when this consent was actually captured.";
  } else if (Date.parse(capturedAt) > now) {
    errors.capturedAtLocal = "The captured time cannot be in the future.";
  }
  const jurisdiction = draft.jurisdiction.trim().toUpperCase();
  if (!IMPORT_JURISDICTION_RE.test(jurisdiction)) {
    errors.jurisdiction =
      "Use a 2–32 character jurisdiction code such as GB, EU, or US-CA.";
  }
  const reason = draft.reason.trim();
  if (reason.length < 1 || reason.length > IMPORT_CONSENT_REASON_MAX) {
    errors.reason = `Give a ${IMPORT_CONSENT_REASON_MAX}-character-or-shorter audit reason.`;
  } else if (UNSAFE_SECRET_RE.test(reason) || UNSAFE_PII_RE.test(reason)) {
    errors.reason =
      "Do not place personal data or secrets here; cite the typed evidence reference instead.";
  }
  const policyVersion = draft.policyVersion.trim();
  if (
    policyVersion.length < 1 ||
    policyVersion.length > IMPORT_CONSENT_POLICY_MAX ||
    UNSAFE_SECRET_RE.test(policyVersion)
  ) {
    errors.policyVersion =
      "Enter the non-secret policy version that governed this decision.";
  }
  const evidence = draft.evidenceReference.trim();
  if (
    evidence.length > IMPORT_CONSENT_EVIDENCE_MAX ||
    !IMPORT_EVIDENCE_RE.test(evidence) ||
    UNSAFE_SECRET_RE.test(evidence)
  ) {
    errors.evidenceReference =
      "Use a safe typed reference such as receipt:CONSENT-123 (not the evidence contents).";
  }
  if (!draft.scopeAcknowledged) {
    errors.scopeAcknowledged =
      "Acknowledge that this proof applies only to email marketing.";
  }
  if (draft.typedConfirmation.trim() !== IMPORT_CONSENT_CONFIRMATION) {
    errors.typedConfirmation = `Type ${IMPORT_CONSENT_CONFIRMATION} exactly to confirm the scope.`;
  }
  return errors;
}

export function buildImportConsentPatch(
  draft: ImportConsentDraft,
  now = Date.now(),
): ImportConsentPatch | null {
  if (draft.mode === "none") return { consent_scope_acknowledged: false };
  if (Object.keys(validateImportConsentDraft(draft, now)).length > 0) return null;
  const capturedAt = importConsentTimestamp(draft.capturedAtLocal);
  if (!capturedAt || draft.source === "") return null;
  return {
    consent_scope_acknowledged: true,
    consent_source: draft.source,
    consent_source_url: draft.sourceUrl.trim(),
    consent_captured_at: capturedAt,
    consent_legal_basis: "consent",
    consent_jurisdiction: draft.jurisdiction.trim().toUpperCase(),
    consent_reason: draft.reason.trim(),
    consent_policy_version: draft.policyVersion.trim(),
    consent_evidence_reference: draft.evidenceReference.trim(),
    consent_scope: IMPORT_CONSENT_SCOPE,
  };
}

export function importConsentDraftFromContract(source: {
  consent_contract_state?: string;
  consent_source?: string;
  consent_source_url?: string;
  consent_captured_at?: string;
  consent_jurisdiction?: string;
  consent_reason?: string;
  consent_policy_version?: string;
  consent_evidence_reference?: string;
}): ImportConsentDraft {
  const reviewedSource = IMPORT_CONSENT_SOURCES.find(
    (option) => option.value === source.consent_source,
  )?.value;
  const captured = source.consent_captured_at
    ? new Date(source.consent_captured_at)
    : null;
  if (
    source.consent_contract_state !== "complete" ||
    !reviewedSource ||
    !captured ||
    !Number.isFinite(captured.getTime())
  ) {
    // Partial legacy metadata is never promoted to a positive grant. Saving
    // this repair draft atomically clears it through the no-proof contract.
    return emptyImportConsentDraft();
  }
  const local = new Date(
    captured.getTime() - captured.getTimezoneOffset() * 60_000,
  )
    .toISOString()
    .slice(0, 19);
  return {
    mode: "verified",
    source: reviewedSource,
    sourceUrl: source.consent_source_url ?? "",
    capturedAtLocal: local,
    jurisdiction: source.consent_jurisdiction ?? "",
    reason: source.consent_reason ?? "",
    policyVersion: source.consent_policy_version ?? "",
    evidenceReference: source.consent_evidence_reference ?? "",
    scopeAcknowledged: true,
    typedConfirmation: IMPORT_CONSENT_CONFIRMATION,
  };
}
