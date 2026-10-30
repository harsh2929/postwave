/**
 * Pure helpers for the Data Platform → Custom objects section (#36).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire notes (WIRING-WRAPPERS.md #36): camelCase wire (tenantId,
 * primaryKey, externalId…); record upserts return 422 whose error
 * envelope carries `fields: [{field, code, message}]` on schema
 * violations (verified in apps/api/internal/customobjects).
 *
 * The schema column is the small JSON-Schema subset from
 * customobjects/validator.go: type / properties / required / enum /
 * minLength / maxLength / minimum / maximum / items. The editor
 * round-trips the common flat shape (object with typed properties +
 * required flags); anything richer falls back to raw-JSON editing so
 * no constraint is silently dropped.
 */

import type { CustomObjectType } from "../../lib/api-client";

export const PROPERTY_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export interface PropertyRow {
  name: string;
  type: PropertyType;
  required: boolean;
}

/* ---------- schema ↔ rows ---------- */

interface FlatSchemaShape {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  [k: string]: unknown;
}

/**
 * True when the schema is the flat shape the row editor can round-trip
 * WITHOUT losing information: top-level `{type:"object", properties,
 * required}` where every property is a bare `{type}`. Extra constraint
 * keys (enum, minLength, nested properties, …) force raw-JSON mode.
 */
export function isSimpleObjectSchema(schema: unknown): boolean {
  if (schema == null) return true;
  if (typeof schema !== "object" || Array.isArray(schema)) return false;
  const s = schema as FlatSchemaShape;
  const keys = Object.keys(s);
  if (keys.length === 0) return true;
  for (const k of keys) {
    if (!["type", "properties", "required"].includes(k)) return false;
  }
  if (s.type !== undefined && s.type !== "object") return false;
  if (s.required !== undefined) {
    if (!Array.isArray(s.required)) return false;
    if (!s.required.every((r) => typeof r === "string")) return false;
  }
  if (s.properties !== undefined) {
    if (
      !s.properties ||
      typeof s.properties !== "object" ||
      Array.isArray(s.properties)
    ) {
      return false;
    }
    for (const v of Object.values(s.properties as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const p = v as Record<string, unknown>;
      const pk = Object.keys(p);
      if (pk.length !== 1 || pk[0] !== "type") return false;
      if (!PROPERTY_TYPES.includes(p.type as PropertyType)) return false;
    }
  }
  return true;
}

export function schemaToRows(schema: unknown): PropertyRow[] {
  if (!isSimpleObjectSchema(schema) || schema == null) return [];
  const s = schema as FlatSchemaShape;
  const required = new Set(
    Array.isArray(s.required) ? (s.required as string[]) : [],
  );
  const props = (s.properties ?? {}) as Record<string, { type?: unknown }>;
  return Object.entries(props).map(([name, def]) => ({
    name,
    type: (def?.type as PropertyType) ?? "string",
    required: required.has(name),
  }));
}

export function rowsToSchema(rows: PropertyRow[]): Record<string, unknown> {
  const clean = rows.filter((r) => r.name.trim());
  const properties: Record<string, { type: PropertyType }> = {};
  for (const r of clean) {
    Object.defineProperty(properties, r.name.trim(), {
      value: { type: r.type },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const required = clean.filter((r) => r.required).map((r) => r.name.trim());
  const out: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) out.required = required;
  return out;
}

export function propertyRowErrors(rows: PropertyRow[]): string | null {
  const names = rows.map((r) => r.name.trim()).filter(Boolean);
  if (names.length !== new Set(names).size) {
    return "Property names must be unique";
  }
  return null;
}

/* ---------- type editor draft ---------- */

export interface TypeDraft {
  key: string;
  label: string;
  primaryKey: string;
  status: "active" | "deprecated" | "disabled";
  /** Row editor state — authoritative when rawSchemaText is null. */
  rows: PropertyRow[];
  /** Raw JSON mode for non-simple schemas. */
  rawSchemaText: string | null;
}

export function typeDraftFrom(t?: CustomObjectType | null): TypeDraft {
  const simple = isSimpleObjectSchema(t?.schema ?? null);
  return {
    key: t?.key ?? "",
    label: t?.label ?? "",
    primaryKey: t?.primaryKey ?? "",
    status: t?.status ?? "active",
    rows: simple ? schemaToRows(t?.schema ?? null) : [],
    rawSchemaText:
      t && !simple ? JSON.stringify(t.schema ?? {}, null, 2) : null,
  };
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;

export function typeDraftErrors(
  d: TypeDraft,
  mode: "create" | "edit",
): Record<string, string> {
  const e: Record<string, string> = {};
  if (mode === "create") {
    if (!d.key.trim()) e.key = "Key is required";
    else if (!KEY_RE.test(d.key.trim())) {
      e.key =
        "Lowercase letters, digits, underscores; must start with a letter";
    }
  }
  if (!d.label.trim()) e.label = "Label is required";
  if (d.rawSchemaText != null) {
    try {
      const parsed: unknown = JSON.parse(d.rawSchemaText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        e.schema = "Schema must be a JSON object";
      }
    } catch {
      e.schema = "Schema is not valid JSON";
    }
  } else {
    const rowErr = propertyRowErrors(d.rows);
    if (rowErr) e.schema = rowErr;
  }
  return e;
}

export function typeDraftSchema(d: TypeDraft): Record<string, unknown> {
  if (d.rawSchemaText != null) {
    try {
      const parsed: unknown = JSON.parse(d.rawSchemaText);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* validated upstream */
    }
    return {};
  }
  return rowsToSchema(d.rows);
}

/* ---------- record helpers ---------- */

export interface RecordViolation {
  field: string;
  code: string;
  message: string;
}

const MAX_RECORD_VIOLATIONS = 12;
const MAX_VIOLATION_FIELD_LENGTH = 96;
const SAFE_VIOLATION_FIELD =
  /^(?:\$|\$schema|\$properties|[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?)*)$/;

const RECORD_VIOLATION_COPY = {
  schema_parse_error: "The saved validation schema could not be read.",
  properties_parse_error: "The submitted properties could not be validated.",
  type_mismatch: "Use the value type required by this field.",
  enum_violation: "Choose one of the values allowed by this field.",
  min_length: "Enter a longer value.",
  max_length: "Enter a shorter value.",
  minimum: "Enter a value at or above the allowed minimum.",
  maximum: "Enter a value at or below the allowed maximum.",
  required: "Add this required field.",
  additional_property: "Remove this field; the schema does not allow it.",
} as const;

type RecordViolationCode = keyof typeof RECORD_VIOLATION_COPY;

function safeViolationField(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_VIOLATION_FIELD_LENGTH ||
    !SAFE_VIOLATION_FIELD.test(value)
  ) {
    return "Record";
  }
  if (value === "$schema") return "Schema";
  if (value === "$properties" || value === "$") return "Record";
  return value;
}

function safeViolationCode(value: unknown): RecordViolationCode | null {
  if (typeof value !== "string" || value.length > 32) return null;
  return Object.hasOwn(RECORD_VIOLATION_COPY, value)
    ? (value as RecordViolationCode)
    : null;
}

/**
 * Recover the structured violations from a 422 upsert failure. The Go
 * handler writes `{error: {code, message, fields: [...]}}`; the client
 * core lifts unknown envelope keys into res.error.details, so the
 * list arrives as details.fields.
 */
export function recordViolations(
  details: Record<string, unknown> | undefined,
): RecordViolation[] {
  const fields = details?.fields;
  if (!Array.isArray(fields)) return [];
  const out: RecordViolation[] = [];
  for (const f of fields) {
    if (out.length >= MAX_RECORD_VIOLATIONS) break;
    if (!f || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    const knownCode = safeViolationCode(o.code);
    out.push({
      field: safeViolationField(o.field),
      code: knownCode ?? "schema_violation",
      message: knownCode
        ? RECORD_VIOLATION_COPY[knownCode]
        : "This field did not satisfy the saved schema.",
    });
  }
  return out;
}

export interface ParsedJsonObject {
  value: Record<string, unknown> | null;
  error: string | null;
}

/** Parse a record's properties textarea. Empty text = `{}`. */
export function parseJsonObject(text: string): ParsedJsonObject {
  const trimmed = text.trim();
  if (!trimmed) return { value: {}, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      value: null,
      error: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: null, error: "Expected a JSON object" };
  }
  return { value: parsed as Record<string, unknown>, error: null };
}

/** Compact one-line preview of a record's properties for table rows. */
export function propertiesPreview(
  props: Record<string, unknown> | null | undefined,
  maxKeys = 4,
): string {
  if (!props || typeof props !== "object") return "—";
  const keys = Object.keys(props);
  if (keys.length === 0) return "—";
  const parts = keys.slice(0, maxKeys).map((k) => {
    const v = props[k];
    let display: string;
    if (v == null) display = "null";
    else if (typeof v === "string")
      display = v.length > 24 ? `${v.slice(0, 24)}…` : v;
    else if (typeof v === "number" || typeof v === "boolean")
      display = String(v);
    else display = "{…}";
    return `${k}=${display}`;
  });
  let s = parts.join(", ");
  if (keys.length > maxKeys) s += `, +${keys.length - maxKeys} more`;
  return s;
}
