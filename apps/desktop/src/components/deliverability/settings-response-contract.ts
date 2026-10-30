import type {
  BlocklistAutoSuppressState,
  DeliverabilityProviderConfig,
  EQScoreResult,
} from "../../lib/api-client";

const MAX_ROWS = 10_000;
const MAX_TEXT = 16_384;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TEXT &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || isText(value, true);
}

function isFiniteInRange(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

function isBoundedArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length <= MAX_ROWS;
}

export function parseProviderConfigs(
  value: unknown,
): DeliverabilityProviderConfig[] | null {
  if (!isRecord(value) || !isBoundedArray(value.items)) return null;
  if (!value.items.every(isProviderConfig)) return null;
  return value.items as DeliverabilityProviderConfig[];
}

export function parseProviderUpsert(
  value: unknown,
): DeliverabilityProviderConfig | null {
  if (!isRecord(value) || !isProviderConfig(value.item)) return null;
  return value.item as DeliverabilityProviderConfig;
}

function isProviderConfig(value: unknown): boolean {
  return (
    isRecord(value) &&
    isText(value.id) &&
    isText(value.tenant_id) &&
    isText(value.provider) &&
    isOptionalText(value.display_name) &&
    (value.config === undefined || isRecord(value.config)) &&
    typeof value.active === "boolean" &&
    isText(value.created_at) &&
    isText(value.updated_at)
  );
}

export function parseAutoSuppress(value: unknown): boolean | null {
  if (!isRecord(value) || typeof value.auto_suppress !== "boolean") {
    return null;
  }
  return value.auto_suppress;
}

export function parseAutoSuppressState(
  value: unknown,
): BlocklistAutoSuppressState | null {
  if (
    !isRecord(value) ||
    typeof value.auto_suppress !== "boolean" ||
    typeof value.eligible_now !== "number" ||
    !Number.isSafeInteger(value.eligible_now) ||
    value.eligible_now < 0 ||
    typeof value.active_suppressions !== "number" ||
    !Number.isSafeInteger(value.active_suppressions) ||
    value.active_suppressions < 0 ||
    !isText(value.observed_at) ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.observed_at)
  ) {
    return null;
  }
  return {
    auto_suppress: value.auto_suppress,
    eligible_now: value.eligible_now,
    active_suppressions: value.active_suppressions,
    observed_at: value.observed_at,
  };
}

export function parseMutationOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

export function parseEqScoreResult(value: unknown): EQScoreResult | null {
  if (
    !isRecord(value) ||
    !isFiniteInRange(value.score, 0, 100) ||
    !["A+", "A", "B", "C", "D", "F"].includes(String(value.grade)) ||
    !isSubScore(value.content) ||
    !isSubScore(value.auth) ||
    !isSubScore(value.reputation) ||
    !isReasonArray(value.reasons) ||
    !isBoundedArray(value.skippedSubScores) ||
    !value.skippedSubScores.every((item) => isText(item))
  ) {
    return null;
  }
  return value as unknown as EQScoreResult;
}

function isSubScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteInRange(value.score, 0, 100) &&
    isFiniteInRange(value.weight, 0, 1) &&
    isReasonArray(value.reasons)
  );
}

function isReasonArray(value: unknown): boolean {
  if (!isBoundedArray(value)) return false;
  return value.every(
    (reason) =>
      isRecord(reason) &&
      isText(reason.code) &&
      isText(reason.message, true) &&
      isText(reason.severity) &&
      isText(reason.bucket),
  );
}
