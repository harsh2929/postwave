/**
 * subscriberPiiFindings — the Shadow-PII review queue's rules, phone-side.
 *
 * SUB-071: the scanner records undeclared personal data it finds in custom
 * fields as FINDINGS; an admin reviews each one and the decision commits an
 * immutable receipt. Desktop has the whole surface (PIIFindingsModal +
 * PIIFindingsPanel); mobile had only the masking labels, so the admin paged
 * about a finding could not even read it from the phone.
 *
 * Everything here MIRRORS a server or desktop contract, never invents one:
 *  - vocabularies mirror desktop's pii-findings-ui.ts verbatim (labels an
 *    auditor has already learned);
 *  - `piiDecisionProblem` mirrors UpdateFindingInput.NormalizeAndValidate
 *    (pii_scanner/types.go:356) — status-specific reason taxonomy, 1–2000
 *    char comment, typed evidence reference, and the STRONG-PII refUSAL: a
 *    comment carrying a card-number/IP shape is rejected on the phone with
 *    the same rule the server enforces, because a rejected receipt that
 *    already left the device is itself a PII incident;
 *  - `expected_updated_at` is the finding row's own updated_at — the server
 *    refuses a decision made against a stale row, and this module refuses to
 *    build a body without it.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface PiiVocabOption {
  value: string;
  label: string;
  description?: string;
}

/** Mirrors desktop PII_TYPE_OPTIONS. */
const TYPE_LABELS: Record<string, string> = {
  ssn: "SSN",
  credit_card: "Credit card",
  date_of_birth: "Date of birth",
  passport: "Passport",
  drivers_license: "Driver's license",
  email: "Email",
  phone: "Phone",
  ip_address: "IP address",
  iban: "IBAN",
  other: "Other",
};

export function piiTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** Mirrors desktop piiStatusLabel: pending is a to-do, not a state of shame. */
export function piiStatusLabel(status: string): string {
  if (status === "pending") return "Needs review";
  if (status === "reviewed") return "Reviewed";
  if (status === "dismissed") return "Dismissed";
  return status;
}

/** Reasons a REVIEWED decision accepts (desktop REVIEW_REASONS, verbatim). */
export const PII_REVIEW_REASONS: readonly PiiVocabOption[] = [
  {
    value: "confirmed_pii",
    label: "Confirmed personal data",
    description: "The detector is correct and the field needs governance.",
  },
  {
    value: "remediated",
    label: "Remediated",
    description: "The exposure was corrected and evidence is attached.",
  },
  {
    value: "accepted_risk",
    label: "Accepted risk",
    description: "An authorized owner accepted the documented residual risk.",
  },
];

/** Reasons a DISMISSED decision accepts (desktop DISMISS_REASONS, verbatim). */
export const PII_DISMISS_REASONS: readonly PiiVocabOption[] = [
  {
    value: "false_positive",
    label: "False positive",
    description: "The value matches a pattern but is not personal data.",
  },
  {
    value: "duplicate",
    label: "Duplicate finding",
    description: "The same exposure is already tracked by another finding.",
  },
  {
    value: "test_data",
    label: "Test data",
    description: "The value is verified non-production fixture data.",
  },
  {
    value: "not_personal_data",
    label: "Not personal data",
    description: "The value does not identify or relate to a natural person.",
  },
];

export function piiReasonsFor(
  outcome: "reviewed" | "dismissed",
): readonly PiiVocabOption[] {
  return outcome === "reviewed" ? PII_REVIEW_REASONS : PII_DISMISS_REASONS;
}

export function piiReasonLabel(reason: string): string {
  if (reason === "legacy_migrated") {
    return "Legacy decision — original rationale unavailable";
  }
  return (
    [...PII_REVIEW_REASONS, ...PII_DISMISS_REASONS].find(
      (o) => o.value === reason,
    )?.label ?? reason
  );
}

export interface PiiFindingRow {
  id: string;
  subscriberId: string;
  fieldName: string;
  detectedType: string;
  confidence: number;
  status: string;
  createdAt: string;
  /** The concurrency token a decision must echo as expected_updated_at. */
  updatedAt: string;
  receipt: { reason: string; comment: string } | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** One page of findings from either list route ({items,total,page,per_page}). */
export function parsePiiFindingPage(payload: unknown): {
  items: PiiFindingRow[];
  total: number;
} {
  const body =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items: PiiFindingRow[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const id = str(rec.id);
    if (!id) continue;
    const receipt =
      rec.review_receipt && typeof rec.review_receipt === "object"
        ? (rec.review_receipt as Record<string, unknown>)
        : null;
    items.push({
      id,
      subscriberId: str(rec.subscriber_id),
      fieldName: str(rec.field_name),
      detectedType: str(rec.detected_type),
      confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
      status: str(rec.status),
      createdAt: str(rec.created_at),
      updatedAt: str(rec.updated_at),
      receipt: receipt
        ? { reason: str(receipt.reason), comment: str(receipt.comment) }
        : null,
    });
  }
  const total = typeof body.total === "number" ? body.total : items.length;
  return { items, total };
}

export interface PiiDecisionDraft {
  outcome: "reviewed" | "dismissed";
  reason: string;
  comment: string;
  /** Typed reference like "ticket:DPO-123" — never the matched value. */
  evidenceReference: string;
}

/** Mirrors the server's evidenceReferenceRE (pii_scanner/types.go:343). */
const EVIDENCE_REFERENCE_RE =
  /^[A-Za-z][A-Za-z0-9._-]{1,31}:[A-Za-z0-9][A-Za-z0-9._/#-]{1,255}$/;

// The strong-PII comment shapes the server refuses (containsStrongPII).
const LONG_NUMERIC_RE = /\b(?:[0-9][ -]?){12,18}[0-9]\b/;
const IPV4_RE = /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/;
const IPV6_RE = /\b[0-9A-F]{1,4}(?::[0-9A-F]{0,4}){2,7}\b/i;

/**
 * First blocking problem with a decision, or null when it is submittable.
 * One sentence at a time — a phone form, not an error summary.
 */
export function piiDecisionProblem(draft: PiiDecisionDraft): string | null {
  const reasons = piiReasonsFor(draft.outcome);
  if (!reasons.some((r) => r.value === draft.reason.trim())) {
    return draft.outcome === "reviewed"
      ? "Choose why this finding is being confirmed."
      : "Choose why this finding is being dismissed.";
  }
  const comment = draft.comment.trim();
  if (comment.length < 1) return "Explain the decision in a sentence.";
  if ([...comment].length > 2000) {
    return "The comment must be 2,000 characters or fewer.";
  }
  if (
    LONG_NUMERIC_RE.test(comment) ||
    IPV4_RE.test(comment) ||
    IPV6_RE.test(comment)
  ) {
    return "The comment must not contain raw personal data — cite the evidence reference instead.";
  }
  const ref = draft.evidenceReference.trim();
  if (
    [...ref].length < 3 ||
    [...ref].length > 288 ||
    !EVIDENCE_REFERENCE_RE.test(ref)
  ) {
    return "Enter a typed evidence reference like ticket:DPO-123 (never the value itself).";
  }
  return null;
}

/**
 * The PATCH /api/v1/pii-findings/{id} body, or null exactly when
 * `piiDecisionProblem` names a problem or the row's concurrency token is
 * missing — a decision against an unknown row version must not leave the
 * phone.
 */
export function buildPiiDecisionBody(
  draft: PiiDecisionDraft,
  expectedUpdatedAt: string,
): Record<string, string> | null {
  if (piiDecisionProblem(draft)) return null;
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return null;
  }
  return {
    status: draft.outcome,
    reason: draft.reason.trim(),
    comment: draft.comment.trim(),
    evidence_reference: draft.evidenceReference.trim(),
    expected_updated_at: expectedUpdatedAt,
  };
}

/**
 * Failure copy per desktop's describePIIFailure / mutationMessage: a 403 is a
 * PERMISSION RULE, a 409/412 is a concurrency fact, and neither is "an error
 * occurred".
 */
export function piiFailureMessage(status: number | undefined): string {
  if (status === 401 || status === 403) {
    return "Shadow-PII evidence is restricted to workspace administrators. Ask an admin to review this queue.";
  }
  if (status === 409 || status === 412) {
    return "This finding changed or was already decided in another session. Refresh the queue before deciding again.";
  }
  if (status === 404 || status === 501) {
    return "This deployment does not expose the Shadow-PII review service.";
  }
  return "The review service did not accept this decision. No decision was assumed.";
}
