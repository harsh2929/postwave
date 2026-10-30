/**
 * Pure helpers for QueuedMutationEditor — extracted (same pattern as
 * notifications-panel-helpers.ts) so the flat-object field derivation
 * and body rebuilding are unit-testable without a DOM.
 *
 * Contract:
 *   - deriveFlatFields() decides which editor the modal renders: a flat
 *     JSON object whose values are all string/number/boolean gets
 *     per-field inputs; anything else (nested objects, arrays, nulls,
 *     non-objects, empty objects) returns null and the modal falls back
 *     to a validated raw-JSON textarea.
 *   - buildBodyFromFields() rebuilds the body from edited fields,
 *     PRESERVING each field's original JSON type (a number edited as
 *     text is parsed back to a number, never silently stringified) and
 *     the object's original key order.
 *   - parseRawBody() validates the textarea fallback.
 */

export type FlatFieldType = "string" | "number" | "boolean";

export interface FlatField {
  key: string;
  /** Original JSON type — preserved when the body is rebuilt on save. */
  type: FlatFieldType;
  /**
   * Editor state: strings and numbers edit as text (numbers are parsed
   * back on save); booleans edit as a real boolean (checkbox).
   */
  raw: string | boolean;
}

export type BodyBuildResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string };

/**
 * Derive per-field editor rows from a queued mutation body. Returns
 * null when the body is not a non-empty flat JSON object of
 * string/number/boolean values — callers fall back to the raw-JSON
 * textarea for those.
 */
export function deriveFlatFields(body: unknown): FlatField[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) return null;
  const fields: FlatField[] = [];
  for (const [key, value] of entries) {
    if (typeof value === "string") {
      fields.push({ key, type: "string", raw: value });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      fields.push({ key, type: "number", raw: String(value) });
    } else if (typeof value === "boolean") {
      fields.push({ key, type: "boolean", raw: value });
    } else {
      // null / nested object / array / non-finite number → not flat.
      return null;
    }
  }
  return fields;
}

/**
 * Rebuild the JSON body from edited flat fields. Key order and value
 * types follow the original body; a number field whose text no longer
 * parses is an honest per-field error, not a silent string.
 */
export function buildBodyFromFields(fields: FlatField[]): BodyBuildResult {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "boolean") {
      body[field.key] = field.raw === true;
      continue;
    }
    const text = typeof field.raw === "string" ? field.raw : "";
    if (field.type === "number") {
      const trimmed = text.trim();
      const parsed = trimmed === "" ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(parsed)) {
        return {
          ok: false,
          error: `Field "${field.key}" must be a number (got "${text}").`,
        };
      }
      body[field.key] = parsed;
      continue;
    }
    body[field.key] = text;
  }
  return { ok: true, body };
}

/**
 * Parse the raw-JSON textarea fallback. Empty / whitespace-only input
 * means "no body" (body: undefined); invalid JSON is an honest error
 * carrying the parser's message.
 */
export function parseRawBody(text: string): BodyBuildResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(trimmed) as unknown };
  } catch (err) {
    return {
      ok: false,
      error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Pretty-print a body for the textarea seed. */
export function stringifyBody(body: unknown): string {
  if (body === undefined) return "";
  try {
    return JSON.stringify(body, null, 2) ?? "";
  } catch {
    return "";
  }
}
