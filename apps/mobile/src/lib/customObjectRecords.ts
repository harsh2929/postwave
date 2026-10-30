/**
 * lib/customObjectRecords.ts — reading records whose SHAPE the tenant defined.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER LIST ON THE PHONE. A custom object
 * is a type the workspace invented: `ObjectType` carries a `key`, a `label`, a
 * `primaryKey` and a JSON `schema` (customobjects/types.go:12-22), and every
 * `Record` carries a free-form `properties` object (:29-36). There is no
 * interface to code against — a "booking" in one workspace and an "order" in
 * the next share nothing — so nothing here may assume a field exists, a field's
 * type, or that today's shape is tomorrow's.
 *
 * THEREFORE: NEVER BLANK, NEVER GUESS, ALWAYS SAY WHY. Three failure modes are
 * possible with tenant-defined data and all three are handled by NAMING them
 * rather than by rendering nothing:
 *
 *   - `properties` is not an object (a bare array or string got stored). The
 *     record still renders, with a sentence saying its properties are not a
 *     field map. Skipping it would hide a real record from someone looking it
 *     up on the road.
 *   - a value is nested (an object or array). Printed as compact JSON while it
 *     is short enough to read on a phone, and otherwise announced as what it is
 *     — "3 nested fields" — never truncated into something that looks complete.
 *   - a value is null / undefined. Shown as an em-dash with the key still
 *     present, because "the field exists and is empty" and "the field is not on
 *     this record" are different facts.
 *
 * The server's key spelling is kept exactly as sent. These are the workspace's
 * own field names; title-casing them would rename someone's data.
 *
 * Import-free by construction: node vitest covers all of it.
 */

/** How much nested JSON is still worth reading on a phone. */
const NESTED_INLINE_LIMIT = 120;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export interface CustomObjectType {
  id: string;
  /** The workspace's own key, e.g. "booking". */
  key: string;
  /** The workspace's own label. Falls back to the key, never to a guess. */
  label: string;
  /** Which property is the natural id, per the type definition. */
  primaryKey: string | null;
  /** active | deprecated | disabled — the server's word, whatever it is. */
  status: string | null;
  version: number | null;
}

function parseType(value: unknown): CustomObjectType | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  if (!id) return null;
  const key = text(row.key);
  const label = text(row.label);
  // A type with neither a key nor a label is still a type; it is named by its
  // id rather than dropped, because dropping it would tell the reader the
  // workspace has fewer object types than it does.
  return {
    id,
    key: key ?? id,
    label: label ?? key ?? id,
    primaryKey: text(row.primaryKey),
    status: text(row.status),
    version:
      typeof row.version === "number" && Number.isFinite(row.version)
        ? row.version
        : null,
  };
}

/** `GET /api/v1/custom-objects/types` answers `{ "items": [...] }`. */
export function parseCustomObjectTypes(value: unknown): CustomObjectType[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items
    .map(parseType)
    .filter((row): row is CustomObjectType => row !== null);
}

export type CustomObjectFieldKind =
  | "text"
  | "number"
  | "boolean"
  | "empty"
  | "nested"
  | "unrenderable";

export interface CustomObjectField {
  /** The workspace's own key, verbatim. */
  key: string;
  /** What to print. For `unrenderable`, a sentence describing what is there. */
  value: string;
  kind: CustomObjectFieldKind;
}

function describeNested(value: unknown): CustomObjectField["value"] {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    // Circular structures cannot arrive over JSON, but a caller may hand this
    // function anything; refusing loudly beats throwing inside a render.
    return "A nested value this build cannot display.";
  }
  if (json.length > 0 && json.length <= NESTED_INLINE_LIMIT) return json;
  const size = Array.isArray(value)
    ? `${value.length} ${value.length === 1 ? "entry" : "entries"}`
    : `${Object.keys(value as object).length} nested fields`;
  return `Too long to show here — ${size}. Open it on the web admin.`;
}

/**
 * One record's properties, flattened to printable rows.
 *
 * Sorted by key so two renders of the same record cannot reorder themselves —
 * a JSON object has no guaranteed order, and a list that shuffles between
 * refreshes is unreadable when you are checking one value.
 */
export function customObjectFields(properties: unknown): CustomObjectField[] {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  const out: CustomObjectField[] = [];
  for (const [key, value] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      out.push({ key, value, kind: value.trim() === "" ? "empty" : "text" });
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ key, value: String(value), kind: "number" });
    } else if (typeof value === "boolean") {
      out.push({ key, value: value ? "true" : "false", kind: "boolean" });
    } else if (value === null || value === undefined) {
      out.push({ key, value: "—", kind: "empty" });
    } else if (typeof value === "object") {
      out.push({ key, value: describeNested(value), kind: "nested" });
    } else {
      out.push({
        key,
        value: `A ${typeof value} value this build cannot display.`,
        kind: "unrenderable",
      });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export interface CustomObjectRecord {
  id: string;
  externalId: string | null;
  updatedAt: string | null;
  fields: CustomObjectField[];
  /**
   * Set when `properties` arrived as something other than a field map. The
   * record still renders; this is the sentence explaining what is missing.
   */
  unreadable: string | null;
}

export interface CustomObjectRecordsPage {
  items: CustomObjectRecord[];
  /** The page size the SERVER applied, not the one we asked for. */
  limit: number | null;
  hasMore: boolean;
}

function parseRecord(value: unknown): CustomObjectRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  if (!id) return null;
  const properties = row.properties;
  const isMap =
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties);
  return {
    id,
    externalId: text(row.externalId),
    updatedAt: text(row.updatedAt) ?? text(row.createdAt),
    fields: isMap ? customObjectFields(properties) : [],
    unreadable:
      properties === undefined || properties === null
        ? "This record carries no properties."
        : isMap
          ? null
          : `This record's properties arrived as ${
              Array.isArray(properties) ? "a list" : `a ${typeof properties}`
            }, not a field map, so its fields can't be listed here.`,
  };
}

export function parseCustomObjectRecords(
  value: unknown,
): CustomObjectRecordsPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { items: [], limit: null, hasMore: false };
  }
  const raw = value as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    items: items
      .map(parseRecord)
      .filter((row): row is CustomObjectRecord => row !== null),
    limit:
      typeof raw.limit === "number" && Number.isFinite(raw.limit)
        ? Math.trunc(raw.limit)
        : null,
    hasMore: raw.hasMore === true,
  };
}

/**
 * What to call a record in a list.
 *
 * The type's own `primaryKey` names the property the workspace considers the
 * natural id, so that value wins when the record carries it; `externalId` is
 * the server's fallback and the id is the last resort. Never a made-up label.
 */
export function customObjectRecordTitle(
  record: CustomObjectRecord,
  type: CustomObjectType | null,
): string {
  const primary = type?.primaryKey
    ? record.fields.find((field) => field.key === type.primaryKey)
    : undefined;
  if (primary && primary.kind !== "empty" && primary.kind !== "nested") {
    return primary.value;
  }
  return record.externalId ?? record.id;
}

/**
 * The sentence under a records list. It always states the DENOMINATOR it read,
 * because the phone asks for one page: "12 records" would be a claim about the
 * type, and this is a claim about the page.
 */
export function customObjectRecordsSummary(
  page: CustomObjectRecordsPage,
): string {
  const n = page.items.length;
  const noun = n === 1 ? "record" : "records";
  if (page.hasMore) {
    return `The ${n} most recent ${noun}. There are more — search or browse the rest on the web admin.`;
  }
  return `${n} ${noun}${n === 0 ? "" : " — that is all of them"}.`;
}

function statusOf(err: unknown): number {
  return err && typeof err === "object" && "status" in err
    ? Number((err as { status: unknown }).status)
    : 0;
}

function codeOf(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code ?? "")
    : "";
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message.trim() : "";
}

/**
 * The read failures these two routes can produce.
 *
 * `unsafe_filter_transport` (handlers.go:198) is worth its own sentence: the
 * server refuses property filters in a URL because the values are customer
 * data, and only the POST search route accepts them. If it is ever seen here it
 * means the phone built a URL it must not build, and the message says so rather
 * than blaming the reader.
 */
export function customObjectsErrorMessage(err: unknown): string {
  const status = statusOf(err);
  const code = codeOf(err);
  if (code === "unsafe_filter_transport") {
    return "Property values can't be sent in a URL. Search these records on the web admin.";
  }
  if (status === 403) {
    return "Reading custom objects needs a workspace session with access to this data.";
  }
  if (status === 404) {
    return "That object type no longer exists. Pull to refresh.";
  }
  if (status === 400 || status === 422) {
    return (
      messageOf(err) ||
      "The server rejected that request for this object type."
    );
  }
  return messageOf(err) || "Couldn't load these records.";
}
