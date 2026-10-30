/**
 * lib/aiPiiMasking.ts — the pure half of the "mask from AI models" card.
 *
 * Desktop renders DataPrivacySection (apps/desktop/src/components/settings/
 * DataPrivacySection.tsx) from GET /api/v1/settings/pii-config; mobile had no
 * caller for the route, so which subscriber fields are tokenized before they
 * reach a model was invisible from a phone.
 *
 * WIRE SHAPE, read off the Go handlers (apps/api/internal/subscribers/
 * pii_config.go GetPIIConfig/UpdatePIIConfig + pii_gateway/sanitizer.go
 * FieldSensitivity):
 *   GET / PATCH → { built_in_fields: ["email","phone"],
 *                   fields: [{ field_name, sensitive, built_in }] }
 *   PATCH body  → { fields: [{ field_name, sensitive }] }   (must be non-empty)
 *   503 {code: "pii_gateway_unconfigured"} when the gateway is not wired on
 *   this deployment — a product boundary, not an outage.
 *
 * The built-in identifier fields are "always implied sensitive by the
 * sanitizer and NOT required to have a row" (LoadConfig's doc comment), so the
 * normalizer guarantees a locked-on row for each of them even when the server
 * returns no persisted row — otherwise the card would claim email is exposed.
 *
 * Import-free so it runs under node vitest.
 */

export interface PiiFieldView {
  fieldName: string;
  /** Masked (tokenized) before any model call. */
  sensitive: boolean;
  /** Identifier pseudo-field the sanitizer always masks; toggle is locked on. */
  builtIn: boolean;
}

export interface PiiMaskingConfig {
  builtInFields: string[];
  fields: PiiFieldView[];
}

export interface PiiMaskPatchBody {
  fields: Array<{ field_name: string; sensitive: boolean }>;
}

/** The server's code for "no PII gateway on this deployment". */
export const PII_GATEWAY_UNCONFIGURED = "pii_gateway_unconfigured";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const s = str(entry);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * `{built_in_fields, fields}` → rows a card can render. Built-in identifiers
 * lead the list, locked on; persisted rows follow in server order; a
 * persisted row for a built-in name is folded into the leading one (and stays
 * sensitive whatever the row says — the sanitizer does not consult it).
 */
export function normalizePiiMaskingConfig(payload: unknown): PiiMaskingConfig {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const builtInFields = strList(raw.built_in_fields);
  const builtIn = new Set(builtInFields);
  const fields: PiiFieldView[] = builtInFields.map((fieldName) => ({
    fieldName,
    sensitive: true,
    builtIn: true,
  }));
  const seen = new Set(builtInFields);
  const rows = Array.isArray(raw.fields) ? raw.fields : [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const fieldName = str(r.field_name);
    if (!fieldName || seen.has(fieldName)) continue;
    seen.add(fieldName);
    // A row the server flags built_in that is NOT in built_in_fields still
    // renders locked: the flag is the server's word on that row.
    const isBuiltIn = builtIn.has(fieldName) || r.built_in === true;
    fields.push({
      fieldName,
      sensitive: isBuiltIn ? true : r.sensitive === true,
      builtIn: isBuiltIn,
    });
  }
  return { builtInFields, fields };
}

/**
 * True when the error means "this deployment has no PII gateway" (or the
 * route does not exist here) — the card hides rather than offering a Retry
 * that can never work. A bare 503 without the code is an outage and stays an
 * error.
 */
export function isPiiGatewayUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; code?: unknown };
  if (e.status === 404 || e.status === 501) return true;
  return e.status === 503 && e.code === PII_GATEWAY_UNCONFIGURED;
}

/** One field's toggle as the PATCH body the handler accepts. */
export function piiMaskPatchBody(
  fieldName: string,
  sensitive: boolean,
): PiiMaskPatchBody {
  return { fields: [{ field_name: fieldName, sensitive }] };
}

/** A toggle is locked for built-in identifiers and for anyone below admin. */
export function piiFieldLocked(field: PiiFieldView, canAdmin: boolean): boolean {
  return field.builtIn || !canAdmin;
}

/** "2 of 5 masked" — the card's one number, counted, never fabricated. */
export function piiMaskedSummary(fields: PiiFieldView[]): string {
  const masked = fields.filter((f) => f.sensitive).length;
  return `${masked} of ${fields.length} masked`;
}

/** The sentence a failed toggle shows; the server's own words where it has them. */
export function piiSaveErrorMessage(error: {
  status: number;
  code?: string;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change which fields are masked from AI models.";
  }
  if (isPiiGatewayUnavailable(error)) {
    return "The PII gateway isn't configured on this server.";
  }
  return error.message || "Couldn't update field privacy.";
}
