export interface NativeProviderFieldDefinition {
  key: string;
  label: string;
  required?: boolean;
}

export interface NativeProviderDraftValidation {
  cleaned: Record<string, string>;
  errors: Record<string, string>;
  firstInvalidKey: string | null;
}

export const CREDENTIAL_REFERENCE_HELP =
  "Enter the identifier of an existing secret in your secure credential vault, such as vault://crm/hubspot or cred_hubspot_prod. Never paste an API key, OAuth token, password, private key, or secret JSON here.";

export const RAW_CREDENTIAL_REFERENCE_ERROR =
  "This looks like raw credential material. Enter only an existing secure-vault reference; Moosewave will verify the reference again when connecting.";

const RAW_CREDENTIAL_PREFIXES = [
  "bearer ",
  "basic ",
  "sk_live_",
  "sk_test_",
  "rk_live_",
  "pk_live_",
  "shpat_",
  "xoxb-",
  "xoxp-",
  "ya29.",
  "ghp_",
  "gho_",
  "github_pat_",
  "glpat-",
  "pat-",
] as const;

const MAX_PROVIDER_REGISTRY_ITEMS = 256;
const MAX_PROVIDER_FIELDS = 64;
const MAX_PROVIDER_TOKENS = 128;
const MAX_PROVIDER_TEXT = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, required = true): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROVIDER_TEXT &&
    (!required || value.trim().length > 0) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isUniqueTextArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PROVIDER_TOKENS &&
    value.every((entry) => isBoundedText(entry)) &&
    new Set(value).size === value.length
  );
}

function isProviderField(
  value: unknown,
): value is NativeProviderFieldDefinition {
  return (
    isRecord(value) &&
    isBoundedText(value.key) &&
    isBoundedText(value.label) &&
    (value.required === undefined || typeof value.required === "boolean") &&
    (value.secret === undefined || typeof value.secret === "boolean") &&
    (value.help === undefined || isBoundedText(value.help, false))
  );
}

function isProviderFieldArray(
  value: unknown,
): value is NativeProviderFieldDefinition[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_PROVIDER_FIELDS &&
    value.every(isProviderField) &&
    new Set(value.map((field) => field.key)).size === value.length
  );
}

function isProviderSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isBoundedText(value.provider) ||
    !isBoundedText(value.name) ||
    !isBoundedText(value.auth_mode) ||
    !isBoundedText(value.runtime_status) ||
    typeof value.managed !== "boolean" ||
    !isUniqueTextArray(value.capabilities) ||
    !isProviderFieldArray(value.required_settings) ||
    (value.optional_settings !== undefined &&
      !isProviderFieldArray(value.optional_settings)) ||
    !isUniqueTextArray(value.sync_objects) ||
    !isBoundedText(value.docs_url)
  ) {
    return false;
  }
  if (
    (value.category !== undefined && !isBoundedText(value.category)) ||
    (value.sync_model !== undefined && !isBoundedText(value.sync_model)) ||
    (value.verification_mode !== undefined &&
      !isBoundedText(value.verification_mode)) ||
    (value.scopes !== undefined && !isUniqueTextArray(value.scopes)) ||
    (value.webhook_topics !== undefined &&
      !isUniqueTextArray(value.webhook_topics))
  ) {
    return false;
  }
  const allFields = [
    ...(value.required_settings as NativeProviderFieldDefinition[]),
    ...((value.optional_settings ?? []) as NativeProviderFieldDefinition[]),
  ];
  return new Set(allFields.map((field) => field.key)).size === allFields.length;
}

/**
 * Validate dynamic provider metadata before it becomes form structure. The
 * generic return preserves each domain's generated type while the runtime
 * checks prevent malformed registries from creating unbounded or duplicate
 * fields in the renderer.
 */
export function parseNativeProviderRegistry<T>(value: unknown): T[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  if (
    value.items.length > MAX_PROVIDER_REGISTRY_ITEMS ||
    !value.items.every(isProviderSpec)
  ) {
    return null;
  }
  const providers = value.items as Array<Record<string, unknown>>;
  if (
    new Set(providers.map((provider) => provider.provider)).size !==
    providers.length
  ) {
    return null;
  }
  return value.items as T[];
}

/**
 * A deliberately conservative client-side tripwire for common pasted secrets.
 * The server and credential vault remain authoritative; reference formats are
 * otherwise left open so customer-specific vault identifiers keep working.
 */
export function looksLikeObviousRawCredential(value: string): boolean {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return false;

  if (/-----begin [^-]+private key-----/i.test(trimmed)) return true;
  if (/^[{[]/.test(trimmed)) return true;
  if (/\r|\n/.test(trimmed)) return true;
  if (/^(?:aws_)?(?:access_key_id|secret_access_key)\s*=/i.test(trimmed)) {
    return true;
  }
  if (RAW_CREDENTIAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  if (/^eyj[^\s.]+\.[^\s.]+\.[^\s.]+$/i.test(trimmed)) return true;

  return (
    trimmed.length >= 80 && !trimmed.includes("://") && !trimmed.includes(":")
  );
}

export function validateNativeProviderDraft(
  fields: readonly NativeProviderFieldDefinition[],
  values: Readonly<Record<string, string>>,
): NativeProviderDraftValidation {
  const cleaned: Record<string, string> = {};
  const errors: Record<string, string> = {};
  let firstInvalidKey: string | null = null;

  for (const field of fields) {
    const value = (values[field.key] ?? "").trim();
    if (value) cleaned[field.key] = value;

    let message: string | null = null;
    if (field.required && !value) {
      message = `${field.label} is required.`;
    } else if (
      field.key === "credentials_ref" &&
      looksLikeObviousRawCredential(value)
    ) {
      message = RAW_CREDENTIAL_REFERENCE_ERROR;
    }

    if (!message) continue;
    errors[field.key] = message;
    firstInvalidKey ??= field.key;
  }

  return { cleaned, errors, firstInvalidKey };
}
