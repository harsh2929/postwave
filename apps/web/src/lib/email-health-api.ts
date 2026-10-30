// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "./api";

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

export interface EmailHealthBatch {
  results: EmailHealth[];
  summary: Record<EmailHealthGrade, number>;
  total: number;
  duplicates: number;
  model_version: string;
}

const grades = new Set<string>(EMAIL_HEALTH_GRADES);
const recommendations = new Set<string>([
  "send",
  "caution",
  "do_not_send",
  "blocked",
]);
const evidenceKinds = new Set<string>([
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

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactCalendarDate = (
  year: number,
  month: number,
  day: number,
): boolean => {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};
const timestamp = (value: unknown): value is string => {
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
    exactCalendarDate(year, month, day) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};
// Invalid syntax is evidence for grade F, so lookup keys need only match the
// server's bounded, control-free transport contract.
const healthAddress = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 3 &&
  value.length <= 320 &&
  value === value.trim().toLowerCase() &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const safeLine = (value: unknown, max = 128): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}]/u.test(value);
const reasonCode = (value: unknown): value is string =>
  safeLine(value) && /^[a-z0-9][a-z0-9_-]{0,127}$/u.test(value);

/** Fail closed on contradictory safety fields, while allowing new JSON keys. */
export function parseEmailHealth(
  value: unknown,
  expectedEmail?: string,
): EmailHealth | null {
  if (
    !record(value) ||
    !healthAddress(value.email) ||
    (expectedEmail !== undefined &&
      value.email.trim().toLowerCase() !==
        expectedEmail.trim().toLowerCase()) ||
    typeof value.grade !== "string" ||
    !grades.has(value.grade) ||
    typeof value.recommendation !== "string" ||
    !recommendations.has(value.recommendation) ||
    typeof value.hard_stop !== "boolean" ||
    typeof value.send_eligible !== "boolean" ||
    typeof value.evidence_complete !== "boolean" ||
    !Array.isArray(value.reason_codes) ||
    value.reason_codes.length > 64 ||
    !value.reason_codes.every(reasonCode) ||
    new Set(value.reason_codes).size !== value.reason_codes.length ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 512 ||
    !safeLine(value.model_version) ||
    value.model_version.trim().length === 0 ||
    !timestamp(value.computed_at) ||
    !(value.evidence_at === undefined || timestamp(value.evidence_at)) ||
    !(value.checked_at === undefined || timestamp(value.checked_at)) ||
    !(
      value.score === undefined ||
      (Number.isSafeInteger(value.score) &&
        Number(value.score) >= 0 &&
        Number(value.score) <= 10)
    ) ||
    !(value.provider === undefined || safeLine(value.provider, 64)) ||
    !(
      value.status === undefined ||
      (typeof value.status === "string" &&
        verificationStatuses.has(value.status))
    )
  ) {
    return null;
  }

  const evidence: EmailHealthEvidence[] = [];
  for (const item of value.evidence) {
    if (
      !record(item) ||
      typeof item.kind !== "string" ||
      !evidenceKinds.has(item.kind) ||
      !timestamp(item.at) ||
      !safeLine(item.source, 128) ||
      !(
        item.reason_code === "" ||
        item.reason_code === undefined ||
        reasonCode(item.reason_code)
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

  const grade = value.grade as EmailHealthGrade;
  const evidenceComplete = value.evidence_complete;
  const expectedRecommendation: EmailHealthRecommendation = value.hard_stop
    ? "blocked"
    : grade === "A" || grade === "B"
      ? "send"
      : grade === "D"
        ? "do_not_send"
        : grade === "F"
          ? "blocked"
          : "caution";
  if (
    value.recommendation !== expectedRecommendation ||
    value.send_eligible !==
      (evidenceComplete &&
        !value.hard_stop &&
        grade !== "D" &&
        grade !== "F") ||
    (grade === "A" &&
      (value.status !== "valid" ||
        !trustedMailboxProviders.has(String(value.provider)) ||
        !timestamp(value.checked_at))) ||
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
      (grade !== "U" || value.hard_stop || value.recommendation !== "caution"))
  ) {
    return null;
  }

  return {
    email: value.email,
    grade,
    recommendation: value.recommendation as EmailHealthRecommendation,
    hard_stop: value.hard_stop,
    send_eligible: value.send_eligible,
    evidence_complete: evidenceComplete,
    reason_codes: [...value.reason_codes] as string[],
    evidence,
    ...(timestamp(value.evidence_at) ? { evidence_at: value.evidence_at } : {}),
    ...(typeof value.status === "string"
      ? { status: value.status as EmailVerificationStatus }
      : {}),
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(typeof value.provider === "string" ? { provider: value.provider } : {}),
    ...(timestamp(value.checked_at) ? { checked_at: value.checked_at } : {}),
    model_version: value.model_version,
    computed_at: value.computed_at,
  };
}

export async function getEmailHealth(address: string): Promise<EmailHealth> {
  const payload = await api.get<unknown>("/api/v1/verification/health", {
    query: { email: address },
  });
  const parsed = parseEmailHealth(payload, address);
  if (!parsed) throw new Error("Email health response was malformed.");
  return parsed;
}

export async function getEmailHealthBatch(
  emails: string[],
  signal?: AbortSignal,
): Promise<EmailHealthBatch> {
  const payload = await api.post<unknown>(
    "/api/v1/verification/health/batch",
    { emails },
    {
      // This POST is a pure bounded lookup. It must never enter the offline
      // mutation outbox or be replayed as though it changed provider state.
      idempotencyKey: null,
      maxAttempts: 1,
      requireOnline: true,
      ...(signal ? { signal } : {}),
    },
  );
  if (
    !record(payload) ||
    !Array.isArray(payload.results) ||
    payload.results.length > 1_000 ||
    !record(payload.summary) ||
    !Number.isSafeInteger(payload.total) ||
    !Number.isSafeInteger(payload.duplicates) ||
    Number(payload.total) < 0 ||
    Number(payload.duplicates) < 0 ||
    payload.total !== payload.results.length ||
    Number(payload.total) + Number(payload.duplicates) !== emails.length ||
    !safeLine(payload.model_version) ||
    payload.model_version.trim().length === 0
  ) {
    throw new Error("Email health batch response was malformed.");
  }
  const requested = new Set(emails.map((item) => item.trim().toLowerCase()));
  const results = payload.results.map((item) => parseEmailHealth(item));
  if (
    results.some((item) => item === null || !requested.has(item.email)) ||
    new Set(results.map((item) => item?.email)).size !== results.length
  ) {
    throw new Error("Email health batch response was malformed.");
  }
  const summary = {} as Record<EmailHealthGrade, number>;
  let summarized = 0;
  for (const grade of EMAIL_HEALTH_GRADES) {
    const count = payload.summary[grade];
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new Error("Email health batch response was malformed.");
    }
    summary[grade] = Number(count);
    summarized += Number(count);
  }
  if (
    Object.keys(payload.summary).length !== EMAIL_HEALTH_GRADES.length ||
    summarized !== payload.total ||
    results.some((item) => item?.model_version !== payload.model_version)
  ) {
    throw new Error("Email health batch response was malformed.");
  }
  return {
    results: results as EmailHealth[],
    summary,
    total: Number(payload.total),
    duplicates: Number(payload.duplicates),
    model_version: payload.model_version,
  };
}
