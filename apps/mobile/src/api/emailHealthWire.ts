/**
 * emailHealth wire codec — the response contract for one recipient's derived
 * health, and nothing else.
 *
 * Split out of `api/emailHealth.ts` so the validation surface stays free of
 * the SDK transport: every rule below decides whether a server payload is
 * trusted, and none of them needs a client to be exercised.
 */
export const EMAIL_HEALTH_GRADES = ["A", "B", "C", "D", "F", "U"] as const;
export type EmailHealthGrade = (typeof EMAIL_HEALTH_GRADES)[number];
export type EmailHealthRecommendation =
  | "send"
  | "caution"
  | "do_not_send"
  | "blocked";
export type EmailVerificationStatus =
  | "valid"
  | "invalid"
  | "catch_all"
  | "spamtrap"
  | "abuse"
  | "do_not_mail"
  | "unknown";
export type EmailHealthEvidenceKind =
  | "hard_bounce"
  | "complaint"
  | "soft_bounce"
  | "ambiguous_negative"
  | "vendor_activity"
  | "reply"
  | "click"
  | "delivered"
  | "open"
  | "hard_stop";

export interface EmailHealthEvidence {
  kind: EmailHealthEvidenceKind;
  at: string;
  source: string;
  reason_code: string;
}

export interface EmailHealth {
  email: string;
  grade: EmailHealthGrade;
  recommendation: EmailHealthRecommendation;
  hard_stop: boolean;
  send_eligible: boolean;
  evidence_complete: boolean;
  reason_codes: string[];
  evidence: EmailHealthEvidence[];
  evidence_at?: string;
  status?: EmailVerificationStatus;
  score?: number;
  provider?: string;
  checked_at?: string;
  model_version: string;
  computed_at: string;
}

export interface EmailHealthBatchResponse {
  results: EmailHealth[];
  summary: Record<EmailHealthGrade, number>;
  total: number;
  duplicates: number;
  model_version: string;
}

const gradeSet = new Set<string>(EMAIL_HEALTH_GRADES);
const recommendationSet = new Set<string>([
  "send",
  "caution",
  "do_not_send",
  "blocked",
]);
const evidenceSet = new Set<string>([
  "hard_bounce",
  "complaint",
  "soft_bounce",
  "ambiguous_negative",
  "vendor_activity",
  "reply",
  "click",
  "delivered",
  "open",
  "hard_stop",
]);
const verificationStatuses = new Set<string>([
  "valid",
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
]);
const trustedMailboxProviders = new Set<string>(["zerobounce", "kickbox"]);

/** Also used by the batch envelope check in `api/emailHealth.ts`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    isExactCalendarDate(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function isExactCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Also used by the batch envelope check in `api/emailHealth.ts`. */
export function isSafeLine(value: unknown, max = 128): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function isReasonCode(value: unknown): value is string {
  return isSafeLine(value) && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value);
}

// Invalid syntax is grade evidence, not a response-schema failure. Bound the
// server-normalized lookup key without requiring a syntactically valid email.
function isHealthAddress(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 320 &&
    value === value.trim().toLowerCase() &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

/**
 * The wire shape a health payload must have before any of it is read. The
 * fields the response is required to carry are narrowed to their real types;
 * the optional ones stay `unknown` because each is checked at the point of
 * use, and an absent field is not the same as a malformed one.
 */
interface EmailHealthWire {
  email: string;
  grade: EmailHealthGrade;
  recommendation: EmailHealthRecommendation;
  hard_stop: boolean;
  send_eligible: boolean;
  evidence_complete: boolean;
  reason_codes: unknown[];
  evidence: unknown[];
  model_version: string;
  computed_at: string;
  evidence_at?: unknown;
  checked_at?: unknown;
  score?: unknown;
  provider?: unknown;
  status?: unknown;
}

/** The address, the verdict fields, and that the verdict is one we know. */
function hasEmailHealthIdentity(
  value: Record<string, unknown>,
  expectedEmail: string | undefined,
): boolean {
  return (
    isHealthAddress(value.email) &&
    (expectedEmail === undefined ||
      value.email.trim().toLowerCase() ===
        expectedEmail.trim().toLowerCase()) &&
    typeof value.grade === "string" &&
    gradeSet.has(value.grade) &&
    typeof value.recommendation === "string" &&
    recommendationSet.has(value.recommendation) &&
    typeof value.hard_stop === "boolean" &&
    typeof value.send_eligible === "boolean" &&
    typeof value.evidence_complete === "boolean"
  );
}

/** The bounded collections and the model stamp that dates the verdict. */
function hasEmailHealthPayload(value: Record<string, unknown>): boolean {
  return (
    Array.isArray(value.reason_codes) &&
    value.reason_codes.length <= 64 &&
    value.reason_codes.every(isReasonCode) &&
    new Set(value.reason_codes).size === value.reason_codes.length &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= 512 &&
    isSafeLine(value.model_version) &&
    value.model_version.trim().length > 0 &&
    isTimestamp(value.computed_at)
  );
}

/**
 * The optional fields. Each is valid when absent OR well-formed — a missing
 * `score` is a server that did not compute one, a malformed `score` is a
 * response to reject, and collapsing the two would render a lie.
 */
function hasEmailHealthOptionals(value: Record<string, unknown>): boolean {
  return (
    (value.evidence_at === undefined || isTimestamp(value.evidence_at)) &&
    (value.checked_at === undefined || isTimestamp(value.checked_at)) &&
    (value.score === undefined ||
      (Number.isSafeInteger(value.score) &&
        Number(value.score) >= 0 &&
        Number(value.score) <= 10)) &&
    (value.provider === undefined || isSafeLine(value.provider, 64)) &&
    (value.status === undefined ||
      (typeof value.status === "string" &&
        verificationStatuses.has(value.status)))
  );
}

function isEmailHealthWire(
  value: unknown,
  expectedEmail: string | undefined,
): value is EmailHealthWire {
  return (
    isRecord(value) &&
    hasEmailHealthIdentity(value, expectedEmail) &&
    hasEmailHealthPayload(value) &&
    hasEmailHealthOptionals(value)
  );
}

/** One malformed evidence row rejects the whole payload, not just the row. */
function parseEmailHealthEvidence(
  rows: unknown[],
): EmailHealthEvidence[] | null {
  const evidence: EmailHealthEvidence[] = [];
  for (const item of rows) {
    if (
      !isRecord(item) ||
      typeof item.kind !== "string" ||
      !evidenceSet.has(item.kind) ||
      !isTimestamp(item.at) ||
      !isSafeLine(item.source) ||
      !(
        item.reason_code === "" ||
        item.reason_code === undefined ||
        isReasonCode(item.reason_code)
      )
    ) {
      return null;
    }
    evidence.push({
      kind: item.kind as EmailHealthEvidenceKind,
      at: item.at,
      source: item.source,
      reason_code: typeof item.reason_code === "string" ? item.reason_code : "",
    });
  }
  return evidence;
}

function expectedRecommendationFor(
  grade: EmailHealthGrade,
  hardStop: boolean,
): EmailHealthRecommendation {
  if (hardStop) return "blocked";
  if (grade === "A" || grade === "B") return "send";
  if (grade === "D") return "do_not_send";
  if (grade === "F") return "blocked";
  return "caution";
}

/**
 * The grade, the recommendation and the evidence have to agree before any of
 * them is shown. An "A" without a trusted mailbox verification, or a "send"
 * on a hard stop, is not a payload to render with a caveat — it is a payload
 * to reject.
 */
function isEmailHealthSelfConsistent(
  value: EmailHealthWire,
  evidence: EmailHealthEvidence[],
): boolean {
  const grade = value.grade;
  const recommendation = value.recommendation;
  const evidenceComplete = value.evidence_complete;
  const expectedRecommendation = expectedRecommendationFor(
    grade,
    value.hard_stop,
  );
  if (
    recommendation !== expectedRecommendation ||
    value.send_eligible !==
      (evidenceComplete &&
        !value.hard_stop &&
        grade !== "D" &&
        grade !== "F") ||
    (grade === "A" &&
      (value.status !== "valid" ||
        !trustedMailboxProviders.has(String(value.provider)) ||
        !isTimestamp(value.checked_at))) ||
    (grade === "C" &&
      (value.status !== "catch_all" ||
        !trustedMailboxProviders.has(String(value.provider)))) ||
    (grade === "B" &&
      !evidence.some(
        (item) =>
          item.kind === "delivered" ||
          item.kind === "click" ||
          item.kind === "reply",
      )) ||
    (!evidenceComplete &&
      (grade !== "U" || value.hard_stop || recommendation !== "caution"))
  ) {
    return false;
  }
  return true;
}

export function parseEmailHealth(
  value: unknown,
  expectedEmail?: string,
): EmailHealth | null {
  if (!isEmailHealthWire(value, expectedEmail)) return null;

  const evidence = parseEmailHealthEvidence(value.evidence);
  if (evidence === null) return null;
  if (!isEmailHealthSelfConsistent(value, evidence)) return null;

  return {
    email: value.email,
    grade: value.grade,
    recommendation: value.recommendation,
    hard_stop: value.hard_stop,
    send_eligible: value.send_eligible,
    evidence_complete: value.evidence_complete,
    reason_codes: [...value.reason_codes] as string[],
    evidence,
    ...(isTimestamp(value.evidence_at)
      ? { evidence_at: value.evidence_at }
      : {}),
    ...(typeof value.status === "string"
      ? { status: value.status as EmailVerificationStatus }
      : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(isTimestamp(value.checked_at) ? { checked_at: value.checked_at } : {}),
    model_version: value.model_version,
    computed_at: value.computed_at,
  };
}
