// SPDX-License-Identifier: AGPL-3.0-only
/**
 * lib/custom-field-limits-api.ts — custom-field governance caps (SUB-015).
 *
 *   GET /api/v1/settings/custom-fields   effective caps + live usage
 *   PUT /api/v1/settings/custom-fields   admin-scoped per-workspace override
 *
 * The caps are the EFFECTIVE limits: the per-workspace override when one
 * exists, otherwise the plan default — exactly as the server resolves them
 * (apps/api/internal/customfields/limits.go). The PUT is PATCH-shaped: an
 * omitted cap keeps its current value, so the client sends only what changed,
 * and the server refuses a body that changes nothing (400 no_fields).
 *
 * Caps govern CREATION only. Lowering one below current usage keeps every
 * existing field; new fields are refused (422) until usage drops under it.
 */
import { api } from "@/lib/api";

export interface CustomFieldLimits {
  max_custom_fields: number;
  max_searchable_fields: number;
  used_custom_fields: number;
  used_searchable_fields: number;
}

export interface CustomFieldLimitsUpdate {
  max_custom_fields?: number;
  max_searchable_fields?: number;
}

/** Postgres `integer` ceiling for the override columns. */
export const MAX_CUSTOM_FIELD_CAP = 2_147_483_647;

export class CustomFieldLimitsContractError extends Error {
  readonly code = "custom_field_limits_contract_error";

  constructor(message: string) {
    super(message);
    this.name = "CustomFieldLimitsContractError";
  }
}

export class CustomFieldLimitsInputError extends Error {
  readonly code = "custom_field_limits_input_error";

  constructor(message: string) {
    super(message);
    this.name = "CustomFieldLimitsInputError";
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Runtime boundary: nothing un-validated reaches a usage bar. */
export function parseCustomFieldLimits(value: unknown): CustomFieldLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomFieldLimitsContractError(
      "The server returned invalid custom-field limits.",
    );
  }
  const record = value as Record<string, unknown>;
  const {
    max_custom_fields,
    max_searchable_fields,
    used_custom_fields,
    used_searchable_fields,
  } = record;
  if (
    !isCount(max_custom_fields) ||
    !isCount(max_searchable_fields) ||
    !isCount(used_custom_fields) ||
    !isCount(used_searchable_fields)
  ) {
    throw new CustomFieldLimitsContractError(
      "The server returned invalid custom-field limits.",
    );
  }
  return {
    max_custom_fields,
    max_searchable_fields,
    used_custom_fields,
    used_searchable_fields,
  };
}

export async function getCustomFieldLimits(
  signal?: AbortSignal,
): Promise<CustomFieldLimits> {
  const response = await api.get<unknown>("/api/v1/settings/custom-fields", {
    signal,
  });
  return parseCustomFieldLimits(response);
}

function validCap(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CUSTOM_FIELD_CAP) {
    throw new CustomFieldLimitsInputError(
      `${label} must be a whole number from 0 to ${MAX_CUSTOM_FIELD_CAP.toLocaleString()}.`,
    );
  }
}

export async function updateCustomFieldLimits(
  input: CustomFieldLimitsUpdate,
  options: { signal?: AbortSignal } = {},
): Promise<CustomFieldLimits> {
  if (
    input.max_custom_fields === undefined &&
    input.max_searchable_fields === undefined
  ) {
    throw new CustomFieldLimitsInputError(
      "Change at least one limit before saving.",
    );
  }
  validCap(input.max_custom_fields, "Max total fields");
  validCap(input.max_searchable_fields, "Max searchable fields");
  const body: CustomFieldLimitsUpdate = {};
  if (input.max_custom_fields !== undefined) {
    body.max_custom_fields = input.max_custom_fields;
  }
  if (input.max_searchable_fields !== undefined) {
    body.max_searchable_fields = input.max_searchable_fields;
  }
  const response = await api.put<unknown>(
    "/api/v1/settings/custom-fields",
    body,
    { requireOnline: true, maxAttempts: 1, signal: options.signal },
  );
  return parseCustomFieldLimits(response);
}
