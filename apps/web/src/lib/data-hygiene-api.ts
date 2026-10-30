// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Typed client for the mounted desktop data-hygiene controls.
 *
 * Reads and writes deliberately share the same parsers. A malformed setting
 * must fail as an unavailable setting; silently coercing it to a valid-looking
 * default could cause an operator to save a policy they never actually read.
 */
import { api } from "@/lib/api";

export interface DataHygieneRequestOptions {
  signal?: AbortSignal;
  requireOnline?: boolean;
  maxAttempts?: number;
  idempotencyKey?: string | null;
}

export interface IdentifierTransforms {
  /** Treat a.b@ and ab@ as the same address (Gmail semantics). */
  email_normalize_dots: boolean;
  /** Treat a+tag@ and a@ as the same address. */
  email_normalize_plus: boolean;
  phone_e164_format: boolean;
  phone_default_region: string;
}

export interface IdentifierTransformPhonePreview {
  key: string;
  input: string;
  output: string;
  changed: boolean;
}

export interface IdentifierTransformPreviewResult {
  config: IdentifierTransforms;
  email_input: string;
  email_output: string;
  email_changed: boolean;
  phones: IdentifierTransformPhonePreview[];
}

export interface IdentifierTransformPreviewInput {
  email?: string;
  merge_fields?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  overrides?: IdentifierTransforms;
}

export const IDENTIFIER_TRANSFORM_PHONE_REGIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "None (international numbers only)" },
  { value: "US", label: "United States (+1)" },
  { value: "CA", label: "Canada (+1)" },
  { value: "GB", label: "United Kingdom (+44)" },
  { value: "IE", label: "Ireland (+353)" },
  { value: "AU", label: "Australia (+61)" },
  { value: "NZ", label: "New Zealand (+64)" },
  { value: "DE", label: "Germany (+49)" },
  { value: "FR", label: "France (+33)" },
  { value: "ES", label: "Spain (+34)" },
  { value: "IT", label: "Italy (+39)" },
  { value: "NL", label: "Netherlands (+31)" },
  { value: "SE", label: "Sweden (+46)" },
  { value: "NO", label: "Norway (+47)" },
  { value: "DK", label: "Denmark (+45)" },
  { value: "FI", label: "Finland (+358)" },
  { value: "IN", label: "India (+91)" },
  { value: "SG", label: "Singapore (+65)" },
  { value: "JP", label: "Japan (+81)" },
  { value: "BR", label: "Brazil (+55)" },
  { value: "MX", label: "Mexico (+52)" },
  { value: "ZA", label: "South Africa (+27)" },
  { value: "AE", label: "United Arab Emirates (+971)" },
  { value: "CH", label: "Switzerland (+41)" },
  { value: "AT", label: "Austria (+43)" },
  { value: "BE", label: "Belgium (+32)" },
  { value: "PT", label: "Portugal (+351)" },
  { value: "PL", label: "Poland (+48)" },
  { value: "CZ", label: "Czechia (+420)" },
] as const;

export interface DeduplicationSettings {
  /** 0–1. Lowering it merges more aggressively — a data-loss decision. */
  merge_confidence_threshold: number;
}

export interface PiiFieldSensitivity {
  field_name: string;
  /** null is an incomplete legacy read and must never be presented as off. */
  sensitive: boolean | null;
  built_in: boolean;
}

export interface PiiConfig {
  /** Always personal data; cannot be removed. */
  built_in_fields: string[];
  /** Persisted field-level decisions for this workspace. */
  fields: PiiFieldSensitivity[];
}

export interface PiiFieldUpdate {
  field_name: string;
  sensitive: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function malformed(surface: string): never {
  throw new Error(`${surface} response was malformed.`);
}

export function normalizeIdentifierTransforms(
  raw: unknown,
): IdentifierTransforms {
  if (
    !isRecord(raw) ||
    typeof raw.email_normalize_dots !== "boolean" ||
    typeof raw.email_normalize_plus !== "boolean" ||
    typeof raw.phone_e164_format !== "boolean" ||
    typeof raw.phone_default_region !== "string"
  ) {
    return malformed("Identifier transforms");
  }
  const region = raw.phone_default_region.trim().toUpperCase();
  if (
    !IDENTIFIER_TRANSFORM_PHONE_REGIONS.some((item) => item.value === region)
  ) {
    return malformed("Identifier transforms");
  }
  return {
    email_normalize_dots: raw.email_normalize_dots,
    email_normalize_plus: raw.email_normalize_plus,
    phone_e164_format: raw.phone_e164_format,
    phone_default_region: region,
  };
}

export function normalizeDeduplicationSettings(
  raw: unknown,
): DeduplicationSettings {
  if (!isRecord(raw)) return malformed("Deduplication settings");
  const threshold = raw.merge_confidence_threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    return malformed("Deduplication settings");
  }
  return { merge_confidence_threshold: threshold };
}

export function normalizePiiConfig(raw: unknown): PiiConfig {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.built_in_fields) ||
    !Array.isArray(raw.fields) ||
    !raw.built_in_fields.every(
      (field) => typeof field === "string" && field.trim().length > 0,
    )
  ) {
    return malformed("PII configuration");
  }
  const builtIn = Array.from(
    new Set(
      raw.built_in_fields.map((field) =>
        (field as string).trim().toLowerCase(),
      ),
    ),
  );
  const fields = raw.fields.map((value): PiiFieldSensitivity => {
    if (!isRecord(value)) return malformed("PII configuration");
    // `key` is accepted for the legacy web fixture/response shape. The mounted
    // server contract uses field_name; all writes use only that canonical key.
    const nameValue = value.field_name ?? value.key;
    if (typeof nameValue !== "string" || !nameValue.trim()) {
      return malformed("PII configuration");
    }
    const fieldName = nameValue.trim().toLowerCase();
    if (value.sensitive !== undefined && typeof value.sensitive !== "boolean") {
      return malformed("PII configuration");
    }
    if (value.built_in !== undefined && typeof value.built_in !== "boolean") {
      return malformed("PII configuration");
    }
    const isBuiltIn = value.built_in === true || builtIn.includes(fieldName);
    return {
      field_name: fieldName,
      sensitive: isBuiltIn
        ? true
        : typeof value.sensitive === "boolean"
          ? value.sensitive
          : null,
      built_in: isBuiltIn,
    };
  });
  return { built_in_fields: builtIn, fields };
}

export function normalizeIdentifierTransformPreview(
  raw: unknown,
): IdentifierTransformPreviewResult {
  if (
    !isRecord(raw) ||
    typeof raw.email_input !== "string" ||
    typeof raw.email_output !== "string" ||
    typeof raw.email_changed !== "boolean" ||
    !Array.isArray(raw.phones)
  ) {
    return malformed("Identifier preview");
  }
  const phones = raw.phones.map((value): IdentifierTransformPhonePreview => {
    if (
      !isRecord(value) ||
      typeof value.key !== "string" ||
      typeof value.input !== "string" ||
      typeof value.output !== "string" ||
      typeof value.changed !== "boolean"
    ) {
      return malformed("Identifier preview");
    }
    return {
      key: value.key,
      input: value.input,
      output: value.output,
      changed: value.changed,
    };
  });
  return {
    config: normalizeIdentifierTransforms(raw.config),
    email_input: raw.email_input,
    email_output: raw.email_output,
    email_changed: raw.email_changed,
    phones,
  };
}

export async function getIdentifierTransforms(): Promise<IdentifierTransforms> {
  return normalizeIdentifierTransforms(
    await api.get<unknown>("/api/v1/settings/identifier-transforms"),
  );
}

export async function updateIdentifierTransforms(
  input: IdentifierTransforms,
  options?: DataHygieneRequestOptions,
): Promise<IdentifierTransforms> {
  // Validate before sending so an unrepresentable region never reaches the
  // workspace policy endpoint.
  const body = normalizeIdentifierTransforms(input);
  return normalizeIdentifierTransforms(
    await api.patch<unknown>("/api/v1/settings/identifier-transforms", body, {
      ...options,
      requireOnline: true,
      maxAttempts: 1,
    }),
  );
}

export async function previewIdentifierTransforms(
  input: IdentifierTransformPreviewInput,
): Promise<IdentifierTransformPreviewResult> {
  return normalizeIdentifierTransformPreview(
    await api.post<unknown>("/api/v1/subscribers/preview-transforms", input, {
      // This POST is a dry-run. Never mint/queue a mutation idempotency record.
      idempotencyKey: null,
      requireOnline: true,
    }),
  );
}

export async function getDeduplicationSettings(): Promise<DeduplicationSettings> {
  return normalizeDeduplicationSettings(
    await api.get<unknown>("/api/v1/settings/deduplication"),
  );
}

export async function updateDeduplicationSettings(
  mergeConfidenceThreshold: number,
  options?: DataHygieneRequestOptions,
): Promise<DeduplicationSettings> {
  const body = normalizeDeduplicationSettings({
    merge_confidence_threshold: mergeConfidenceThreshold,
  });
  return normalizeDeduplicationSettings(
    await api.put<unknown>("/api/v1/settings/deduplication", body, {
      ...options,
      requireOnline: true,
      maxAttempts: 1,
    }),
  );
}

export async function getPiiConfig(): Promise<PiiConfig> {
  return normalizePiiConfig(
    await api.get<unknown>("/api/v1/settings/pii-config"),
  );
}

export async function updatePiiFields(
  fields: PiiFieldUpdate[],
  options?: DataHygieneRequestOptions,
): Promise<PiiConfig> {
  if (
    fields.length === 0 ||
    fields.some(
      (field) =>
        !field.field_name.trim() || typeof field.sensitive !== "boolean",
    )
  ) {
    throw new Error("At least one valid PII field update is required.");
  }
  return normalizePiiConfig(
    await api.patch<unknown>(
      "/api/v1/settings/pii-config",
      {
        fields: fields.map((field) => ({
          field_name: field.field_name.trim().toLowerCase(),
          sensitive: field.sensitive,
        })),
      },
      { ...options, requireOnline: true, maxAttempts: 1 },
    ),
  );
}
