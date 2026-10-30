/**
 * lib/queuedBodyEditor.ts — editing a queued write's body before it retries.
 *
 * The mobile port of apps/desktop/src/components/queued-mutation-editor-
 * helpers.ts, with the same contract: a flat JSON object of string / number /
 * boolean values edits as per-field inputs with each field's ORIGINAL type
 * preserved on rebuild (a number edited as text parses back to a number,
 * never silently a string); anything else falls back to a validated raw-JSON
 * box. Key order follows the original body.
 *
 * What differs from desktop is VALIDATION, because mobile's queue is not one
 * table of routes: the generic entity write is re-checked against
 * lib/offlineQueueSafety exactly as the replay executor will check it, while
 * the two bespoke executors (campaign authoring, sequence create) have their
 * own field vocabularies, enforced in lib/queuedWriteDetail's rebuild. An
 * edit that would only be quarantined at replay time is refused here, with
 * the reason, while the person can still fix it.
 */
import { isQueueableMutation } from "./offlineQueueSafety";
import type { QueuedWriteDetail } from "./queuedWriteDetail";

export type FlatFieldType = "string" | "number" | "boolean";

export interface FlatField {
  key: string;
  /** Original JSON type — preserved when the body is rebuilt on save. */
  type: FlatFieldType;
  /** Strings and numbers edit as text; booleans as a real boolean. */
  raw: string | boolean;
}

export type BodyBuildResult =
  | { ok: true; body: unknown }
  | { ok: false; error: string };

/**
 * Per-field rows, or null when the body is not a non-empty flat object of
 * string/number/boolean values — callers fall back to raw JSON for those.
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
      return null;
    }
  }
  return fields;
}

/** Rebuild the body from edited fields, keeping each field's original type. */
export function buildBodyFromFields(fields: readonly FlatField[]): BodyBuildResult {
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
          error: `"${field.key}" must be a number (got "${text}").`,
        };
      }
      body[field.key] = parsed;
      continue;
    }
    body[field.key] = text;
  }
  return { ok: true, body };
}

/** The raw-JSON fallback. Blank means "no body"; invalid JSON is an honest error. */
export function parseRawBody(text: string): BodyBuildResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(trimmed) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Pretty-print a body for the raw-JSON seed. */
export function stringifyBody(body: unknown): string {
  if (body === undefined) return "";
  try {
    return JSON.stringify(body, null, 2) ?? "";
  } catch {
    return "";
  }
}

/**
 * Would this body still be allowed to replay? Null when it would; otherwise
 * the reason, in the words the person needs to fix it.
 *
 * Only the generic entity write consults the route table — the bespoke
 * executors are not on it and are validated by their own rebuild instead.
 */
export function validateEditedBody(
  detail: Pick<QueuedWriteDetail, "kind" | "method" | "path">,
  body: unknown,
): string | null {
  if (detail.kind !== "entity_write") return null;
  if (isQueueableMutation(detail.method, detail.path, body)) return null;
  return "This body can't replay offline — it matches an online-only action (scheduling or sending a campaign, publishing a form, changing a subscriber's consent). Revert those fields and try again.";
}
