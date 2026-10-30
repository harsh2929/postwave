import type {
  PIIDecisionReason,
  PIIDetectionType,
  PIIFingerprintScheme,
  PIIFindingStatus,
  PIIReceiptReason,
} from "../../lib/api/pii-findings";
import type { ApiErr } from "../../lib/api/result";

export const PII_TYPE_OPTIONS: ReadonlyArray<{
  value: PIIDetectionType;
  label: string;
}> = [
  { value: "ssn", label: "SSN" },
  { value: "credit_card", label: "Credit card" },
  { value: "date_of_birth", label: "Date of birth" },
  { value: "passport", label: "Passport" },
  { value: "drivers_license", label: "Driver's license" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "ip_address", label: "IP address" },
  { value: "iban", label: "IBAN" },
  { value: "other", label: "Other" },
];

const TYPE_LABEL = new Map(PII_TYPE_OPTIONS.map(({ value, label }) => [value, label]));

export function piiTypeLabel(type: PIIDetectionType): string {
  return TYPE_LABEL.get(type) ?? type;
}

export function piiStatusLabel(status: PIIFindingStatus): string {
  if (status === "pending") return "Needs review";
  if (status === "reviewed") return "Reviewed";
  return "Dismissed";
}

export function piiStatusClass(status: PIIFindingStatus): string {
  if (status === "pending") return "is-pending";
  if (status === "reviewed") return "is-reviewed";
  return "is-dismissed";
}

export const REVIEW_REASONS: ReadonlyArray<{
  value: PIIDecisionReason;
  label: string;
  description: string;
}> = [
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

export const DISMISS_REASONS: ReadonlyArray<{
  value: PIIDecisionReason;
  label: string;
  description: string;
}> = [
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

export function piiReasonLabel(reason: PIIReceiptReason): string {
  if (reason === "legacy_migrated") {
    return "Legacy decision — original rationale unavailable";
  }
  return (
    [...REVIEW_REASONS, ...DISMISS_REASONS].find(
      (option) => option.value === reason,
    )?.label ?? reason
  );
}

export type PIISurfaceFailureKind =
  | "admin_required"
  | "unavailable"
  | "service_unavailable"
  | "error";

export interface PIISurfaceFailure {
  kind: PIISurfaceFailureKind;
  title: string;
  message: string;
}

export function describePIIFailure(
  error: ApiErr["error"],
): PIISurfaceFailure {
  if (error.status === 401 || error.status === 403) {
    return {
      kind: "admin_required",
      title: "Admin access required",
      message:
        "Shadow-PII evidence is restricted to workspace administrators. Ask an admin to review this queue.",
    };
  }
  if (
    error.status === 404 ||
    error.status === 501 ||
    error.code === "not_found" ||
    error.code === "capability_unavailable"
  ) {
    return {
      kind: "unavailable",
      title: "Scanner capability unavailable",
      message:
        "This deployment does not expose the Shadow-PII review service. No review state is being inferred.",
    };
  }
  if (
    error.kind === "network" ||
    error.kind === "timeout" ||
    (error.status !== undefined && error.status >= 500)
  ) {
    return {
      kind: "service_unavailable",
      title: "Scanner service unavailable",
      message:
        "The last verified queue is preserved. Reconnect or retry when the service is healthy.",
    };
  }
  return {
    kind: "error",
    title: "Couldn’t verify scanner state",
    message: error.message || "Retry the request to verify the review queue.",
  };
}

export function piiFingerprintLabel(scheme: PIIFingerprintScheme): string {
  return scheme === "hmac-sha256-v1"
    ? "Protected HMAC fingerprint"
    : "Legacy redacted token";
}

export function piiFingerprintDetail(
  scheme: PIIFingerprintScheme,
  keyVersion: string,
): string {
  return scheme === "hmac-sha256-v1"
    ? `HMAC-SHA256 · key ${keyVersion}`
    : "Random migration token · not searchable";
}

export function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 12)}…${fingerprint.slice(-10)}`;
}
