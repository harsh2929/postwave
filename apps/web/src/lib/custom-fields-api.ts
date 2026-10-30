// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export type CustomFieldType = "string" | "number" | "boolean" | "date";

/** Backend: customfields.FieldConfig. The richer per-field policy attributes
 * (SETC-052). `pii_flag` / `data_classification` drive masking + export;
 * `options` enumerates enum choices. */
export interface CustomFieldConfig {
  options?: string[];
  pii_flag?: boolean;
  data_classification?: string;
  /** Mandatory-field intent (SETC-052). */
  required?: boolean;
  /** Default value pre-filled when absent (SETC-052); JSON value. */
  default?: unknown;
  pattern?: string;
}

export interface CustomField {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  config?: CustomFieldConfig | null;
  created_at: string;
  updated_at: string;
}

export type CustomFieldsValidatorMode = "strict" | "auto" | "off";

export interface CustomFieldsModeResponse {
  custom_fields_mode?: CustomFieldsValidatorMode;
}

export function listCustomFields(signal?: AbortSignal): Promise<CustomField[]> {
  return api.get<CustomField[]>("/api/v1/custom-fields", { signal });
}

export function createCustomField(
  input: {
    key: string;
    label: string;
    type: CustomFieldType;
    config?: CustomFieldConfig;
  },
  signal?: AbortSignal,
): Promise<CustomField> {
  return api.post<CustomField>("/api/v1/custom-fields", input, {
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
}

/**
 * Edits a field's label / config in place (SETC-042). Key + type are immutable
 * server-side — changing them would orphan stored subscriber values — so only
 * label + config are sent. PATCH /api/v1/custom-fields/{id} (SUB-006).
 */
export function updateCustomField(
  id: string,
  input: { label?: string; config?: CustomFieldConfig },
  signal?: AbortSignal,
): Promise<CustomField> {
  return api.patch<CustomField>(
    `/api/v1/custom-fields/${encodeURIComponent(id)}`,
    input,
    { signal, requireOnline: true, maxAttempts: 1 },
  );
}

export function deleteCustomField(
  id: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return api.delete(`/api/v1/custom-fields/${encodeURIComponent(id)}`, {
    signal,
    requireOnline: true,
    maxAttempts: 1,
  });
}

export function getCustomFieldsMode(
  signal?: AbortSignal,
): Promise<CustomFieldsModeResponse> {
  return api.get<CustomFieldsModeResponse>("/api/v1/custom-fields/mode", {
    signal,
  });
}

export function updateCustomFieldsMode(
  customFieldsMode: CustomFieldsValidatorMode,
  signal?: AbortSignal,
): Promise<CustomFieldsModeResponse> {
  return api.patch<CustomFieldsModeResponse>(
    "/api/v1/custom-fields/mode",
    { custom_fields_mode: customFieldsMode },
    { signal, requireOnline: true, maxAttempts: 1 },
  );
}

/** One field's fill rate across the tenant's subscribers (SETC-043). */
export interface FieldFillRate {
  key: string;
  label: string;
  /** Subscribers carrying a non-empty value for this field. */
  filled: number;
  /** filled / total_subscribers, in [0,1]. */
  rate: number;
}

export interface FieldUsageReport {
  total_subscribers: number;
  fields: FieldFillRate[];
}

/** Per-field fill rate across subscribers — surfaces dead/under-populated
 * fields on the custom-fields settings page (SETC-043). */
export function getCustomFieldUsage(
  signal?: AbortSignal,
): Promise<FieldUsageReport> {
  return api.get<FieldUsageReport>("/api/v1/settings/custom-fields/usage", {
    signal,
  });
}

/** One object (segment/flow/form) that references a custom field (SETC-032). */
export interface CustomFieldReference {
  id: string;
  name: string;
}

export interface CustomFieldReferences {
  segments: CustomFieldReference[];
  flows: CustomFieldReference[];
  forms: CustomFieldReference[];
}

/** Where-used lookup so the delete dialog can warn about downstream
 * segments/flows/forms before a field is removed (SETC-032). */
export function getCustomFieldReferences(
  id: string,
  signal?: AbortSignal,
): Promise<CustomFieldReferences> {
  return api.get<CustomFieldReferences>(
    `/api/v1/custom-fields/${encodeURIComponent(id)}/references`,
    { signal },
  );
}
