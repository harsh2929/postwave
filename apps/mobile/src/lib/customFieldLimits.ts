/**
 * lib/customFieldLimits.ts — the pure half of the custom-field governance card.
 *
 * Desktop's CustomFieldGovernance (apps/desktop/src/components/settings/
 * CustomFieldGovernance.tsx) renders two usage bars against the workspace's
 * effective caps and lets an admin override them. Mobile could create custom
 * fields and be refused at the cap with no way to see how close it was.
 *
 * WIRE SHAPE (apps/api/internal/customfields/limits.go):
 *   GET /api/v1/settings/custom-fields  (viewer) →
 *     { max_custom_fields, max_searchable_fields,
 *       used_custom_fields, used_searchable_fields }
 *     The caps are the EFFECTIVE limits — the per-tenant override row when one
 *     exists, else the tier default — exactly as `effectiveLimits` resolves
 *     them, and the used counts are live (`countFields`).
 *   PUT same path (admin) → body { max_custom_fields?, max_searchable_fields? }
 *     400 no_fields     "at least one of max_custom_fields or
 *                        max_searchable_fields is required"
 *     400 invalid_limit "max_custom_fields must be non-negative"
 *                       "max_searchable_fields must be non-negative"
 *     An omitted cap keeps its current value (UpdateLimits resolves it from
 *     `effectiveLimits` first), so only changed caps are ever sent.
 *
 * Import-free so it runs under node vitest.
 */

export interface CustomFieldLimits {
  maxCustomFields: number;
  maxSearchableFields: number;
  usedCustomFields: number;
  usedSearchableFields: number;
}

export interface CustomFieldLimitsDraft {
  maxCustomFields: string;
  maxSearchableFields: string;
}

export interface CustomFieldLimitsPatchBody {
  max_custom_fields?: number;
  max_searchable_fields?: number;
}

/** Usage fraction at which a bar flips to the "near limit" warning. */
export const CUSTOM_FIELD_WARN_FRACTION = 0.9;

/** ok = room left · near = at or past 90% · at = the cap refuses the next field. */
export type CustomFieldGovernanceState = "ok" | "near" | "at";

function count(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * True for a value already shaped as resolved limits. The card re-validates
 * what the query hands it — a shared cache can hold any shape, and
 * `limits.maxCustomFields` on an array renders "undefined".
 */
export function isCustomFieldLimits(
  value: unknown,
): value is CustomFieldLimits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    count(v.maxCustomFields) !== null &&
    count(v.maxSearchableFields) !== null &&
    count(v.usedCustomFields) !== null &&
    count(v.usedSearchableFields) !== null
  );
}

/**
 * The wire row → resolved limits, or null when any of the four counters is
 * missing or not a non-negative whole number. All four are required: a bar
 * drawn from three of them would state a ratio the server never sent.
 */
export function normalizeCustomFieldLimits(
  payload: unknown,
): CustomFieldLimits | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const raw = payload as Record<string, unknown>;
  const maxCustomFields = count(raw.max_custom_fields);
  const maxSearchableFields = count(raw.max_searchable_fields);
  const usedCustomFields = count(raw.used_custom_fields);
  const usedSearchableFields = count(raw.used_searchable_fields);
  if (
    maxCustomFields === null ||
    maxSearchableFields === null ||
    usedCustomFields === null ||
    usedSearchableFields === null
  ) {
    return null;
  }
  return {
    maxCustomFields,
    maxSearchableFields,
    usedCustomFields,
    usedSearchableFields,
  };
}

/** Bar fill in [0,1]. A zero cap is full the moment anything exists under it. */
export function customFieldUsageFraction(used: number, max: number): number {
  if (max <= 0) return used > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, used / max));
}

/**
 * Which of the three governance states a counter is in. `at` is `used >= max`
 * because that is the exact predicate `checkCreateLimit` refuses on — not
 * `used === max`, which would read "ok" for a workspace already over a
 * lowered cap.
 */
export function customFieldGovernanceState(
  used: number,
  max: number,
): CustomFieldGovernanceState {
  if (used >= max) return "at";
  if (customFieldUsageFraction(used, max) >= CUSTOM_FIELD_WARN_FRACTION) {
    return "near";
  }
  return "ok";
}

/** The badge beside a bar, or null when there is nothing to warn about. */
export function customFieldGovernanceBadge(
  state: CustomFieldGovernanceState,
): string | null {
  if (state === "at") return "At limit";
  if (state === "near") return "Near limit";
  return null;
}

/** "12 / 1000 total fields" — desktop's own reading of a bar. */
export function customFieldUsageLine(
  used: number,
  max: number,
  noun: string,
): string {
  return `${used} / ${max} ${noun}`;
}

/**
 * What the cap refuses right now, stated from the handler's own rule: a cap at
 * or below the live count keeps the fields that exist and refuses the next
 * one. Nothing is deleted by lowering a cap.
 */
export function customFieldLimitReadout(limits: CustomFieldLimits): string {
  const fieldsAt = limits.usedCustomFields >= limits.maxCustomFields;
  const searchableAt =
    limits.usedSearchableFields >= limits.maxSearchableFields;
  if (fieldsAt && searchableAt) {
    return "New custom fields and new searchable fields are both being refused at the cap.";
  }
  if (fieldsAt) {
    return "New custom fields are being refused at the cap.";
  }
  if (searchableAt) {
    return "A new field can still be added, but not a searchable one.";
  }
  return "Existing fields are never removed by a cap — a cap only refuses the next one.";
}

/** Resolved limits as the strings the two numeric inputs hold. */
export function customFieldLimitsDraft(
  limits: CustomFieldLimits,
): CustomFieldLimitsDraft {
  return {
    maxCustomFields: String(limits.maxCustomFields),
    maxSearchableFields: String(limits.maxSearchableFields),
  };
}

/**
 * Digits typed into one cap field → a whole number ≥ 0, or null. The server's
 * only bound is non-negativity (`invalid_limit`), so this mirrors exactly that
 * and refuses locally rather than spending a request to be told.
 */
export function parseCustomFieldCap(text: string): number | null {
  const digits = text.replace(/[^0-9]/gu, "");
  if (digits === "") return null;
  const n = parseInt(digits, 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * The PUT body for a draft against the limits it was edited from. Only changed
 * caps are sent — an unchanged cap is omitted so the server leaves it alone —
 * and an unchanged draft yields an empty body the caller treats as "nothing to
 * save" rather than a request the handler would answer 400 no_fields.
 */
export function customFieldLimitsPatch(
  limits: CustomFieldLimits,
  draft: CustomFieldLimitsDraft,
):
  | { ok: true; body: CustomFieldLimitsPatchBody }
  | { ok: false; message: string } {
  const max = parseCustomFieldCap(draft.maxCustomFields);
  if (max === null) {
    return { ok: false, message: "Total fields cap must be a whole number ≥ 0." };
  }
  const searchable = parseCustomFieldCap(draft.maxSearchableFields);
  if (searchable === null) {
    return {
      ok: false,
      message: "Searchable fields cap must be a whole number ≥ 0.",
    };
  }
  const body: CustomFieldLimitsPatchBody = {};
  if (max !== limits.maxCustomFields) body.max_custom_fields = max;
  if (searchable !== limits.maxSearchableFields) {
    body.max_searchable_fields = searchable;
  }
  return { ok: true, body };
}

/** True when the draft differs from the saved caps (or cannot be parsed). */
export function customFieldLimitsDirty(
  limits: CustomFieldLimits,
  draft: CustomFieldLimitsDraft,
): boolean {
  const result = customFieldLimitsPatch(limits, draft);
  return !result.ok || Object.keys(result.body).length > 0;
}

/**
 * The sentence a failed save shows. `no_fields` and `invalid_limit` are
 * operator-safe sentences the handler authored and they name the field at
 * fault, so they are shown verbatim rather than paraphrased.
 */
export function customFieldLimitsSaveError(error: {
  status: number;
  code?: string | undefined;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change custom-field caps.";
  }
  if (error.status === 400 && error.message.trim() !== "") {
    return error.message;
  }
  // A blank message is not a sentence — a whitespace body would render an
  // empty alert row that says nothing failed.
  return error.message.trim() !== ""
    ? error.message
    : "Couldn't save the custom-field caps.";
}
