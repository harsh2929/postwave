/**
 * lib/inboundTriggerValidation.ts — the GRAMMAR a trigger rule must satisfy,
 * mirrored from apps/api/internal/inbound_webhooks/trigger_validation.go so
 * the phone can refuse a bad rule before it costs a round trip:
 *
 *   name              1–256 bytes, no control characters
 *   match_jsonpath    ≤512 bytes, the bounded grammar in validateTriggerJsonPath
 *   match_value       required unless `exists`; non-empty for contains/regex;
 *                     ≤4096 bytes; a regex is ≤1024 bytes of RE2
 *   email_jsonpath    same grammar as match_jsonpath
 *   action_target_id  a UUID for sequence/automation; a 1–64 character tag
 *                     name without control characters for add/remove tag
 *
 * The desktop's lib/jsonpath.ts is the model for the JSONPath grammar and the
 * operand wording. lib/inboundTriggerRules.ts owns the rule shapes and copy
 * and re-exports this module, so callers import one thing.
 *
 * No react-native / expo import: vitest runs this in node.
 */

export type TriggerOperator = "equals" | "contains" | "exists" | "regex";
export type TriggerAction =
  | "add_to_sequence"
  | "add_tag"
  | "remove_tag"
  | "start_automation";

/** What the editor holds while a rule is being typed. */
export interface TriggerRuleDraft {
  name: string;
  matchJsonpath: string;
  operator: TriggerOperator;
  matchValue: string;
  emailJsonpath: string;
  actionType: TriggerAction;
  actionTargetId: string;
}

export type TriggerDraftErrors = Partial<Record<keyof TriggerRuleDraft, string>>;

const MAX_NAME_BYTES = 256;
const MAX_JSONPATH_BYTES = 512;
const MAX_MATCH_VALUE_BYTES = 4096;
const MAX_REGEX_BYTES = 1024;
const MAX_TAG_RUNES = 64;
const MAX_TARGET_BYTES = 512;

/**
 * UTF-8 length without TextEncoder, which some RN engines lack. The server
 * measures `len(string)` in Go, which is bytes — so a 256-character name of
 * multi-byte glyphs is over its limit and must be refused here too.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** C0 controls and DEL — what the server refuses in a name or a tag. */
const CONTROL = /[\u0000-\u001f\u007f]/u;

/**
 * One `.name` segment starting at `start` (just past the dot). Returns where
 * the next segment begins and the problem with this one, if any.
 */
function scanDotSegment(
  value: string,
  start: number,
): { next: number; error: string | null } {
  let index = start;
  while (index < value.length && value[index] !== "." && value[index] !== "[") {
    index += 1;
  }
  const name = value.slice(start, index);
  if (!name || /[\s'"*\\\]]/u.test(name) || CONTROL.test(name)) {
    return {
      next: index,
      error:
        "Use plain dotted property names such as $.customer.email. Recursive descent is not supported, and reserved characters need a quoted bracket key.",
    };
  }
  return { next: index, error: null };
}

/** The inside of one `[...]`: `*`, a non-negative index, or one quoted key. */
function bracketBodyError(body: string): string | null {
  if (body === "*") return null;
  if (/^\d+$/u.test(body)) {
    return Number.isSafeInteger(Number(body)) ? null : "Array index is too large.";
  }
  const quote = body[0];
  if (quote !== "'" && quote !== '"') {
    return "Brackets support a non-negative array index, [*], or a quoted property key.";
  }
  const inner = body.slice(1, -1);
  if (
    body.length < 3 ||
    body[body.length - 1] !== quote ||
    inner.includes(quote) ||
    inner.includes("\\") ||
    CONTROL.test(inner)
  ) {
    return "Quoted property brackets need one non-empty key without escapes or control characters.";
  }
  return null;
}

/**
 * The bounded JSONPath grammar the evaluator supports:
 *
 *   $   $.foo   $.foo.bar   $.foo[0]   $.foo[*]   $['quoted key']
 *
 * Anything else — recursive descent, filters, slices, negative indexes — is
 * refused with the reason, so the phone never green-lights a path the server
 * will 422.
 */
export function validateTriggerJsonPath(path: string): string | null {
  const value = (path ?? "").trim();
  if (!value || value[0] !== "$") {
    return "Path must start at the root with $.";
  }
  if (utf8ByteLength(value) > MAX_JSONPATH_BYTES) {
    return `Path must be ${MAX_JSONPATH_BYTES} bytes or smaller.`;
  }
  let index = 1;
  while (index < value.length) {
    const ch = value[index];
    if (ch === ".") {
      const segment = scanDotSegment(value, index + 1);
      if (segment.error) return segment.error;
      index = segment.next;
    } else if (ch === "[") {
      const close = value.indexOf("]", index + 1);
      if (close < 0) return "Array segment is missing its closing ].";
      const error = bracketBodyError(value.slice(index + 1, close).trim());
      if (error) return error;
      index = close + 1;
    } else {
      return "Every segment after $ must start with a dot or an array bracket.";
    }
  }
  return null;
}

/** The operand rules per operator (normalizeAndValidateMatchValue). */
export function validateMatchOperand(
  operator: TriggerOperator,
  value: string,
): string | null {
  if (operator === "exists") return null;
  if (utf8ByteLength(value) > MAX_MATCH_VALUE_BYTES) {
    return "Comparison value must be 4 KiB or smaller.";
  }
  if (operator === "contains" && value === "") {
    return "Contains needs a non-empty value.";
  }
  if (operator === "regex") {
    if (value === "") return "Regex needs a non-empty pattern.";
    if (utf8ByteLength(value) > MAX_REGEX_BYTES) {
      return `Regex must be ${MAX_REGEX_BYTES} bytes or smaller.`;
    }
    // Go's regexp is RE2: no backreferences, no lookaround. Refuse the
    // JavaScript-only constructs here so the phone cannot accept a pattern
    // the server will reject.
    if (/\\[1-9]|\(\?(?:[=!]|<[=!])/u.test(value)) {
      return "Use RE2 syntax; backreferences and lookaround are not supported.";
    }
    try {
      void new RegExp(value);
    } catch {
      return "Enter a valid regular expression.";
    }
  }
  return null;
}

export function isTriggerTargetUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function validateTarget(action: TriggerAction, raw: string): string | null {
  const target = raw.trim();
  if (!target) return "Choose the target for this action.";
  if (utf8ByteLength(target) > MAX_TARGET_BYTES) {
    return `Target must be ${MAX_TARGET_BYTES} bytes or smaller.`;
  }
  if (action === "add_to_sequence" || action === "start_automation") {
    return isTriggerTargetUUID(target) ? null : "Enter the target's UUID.";
  }
  if (Array.from(target).length > MAX_TAG_RUNES || CONTROL.test(target)) {
    return `Tag name must be 1–${MAX_TAG_RUNES} characters without control characters.`;
  }
  return null;
}

/** Every field's problem at once, keyed by draft field; empty when saveable. */
export function validateTriggerDraft(draft: TriggerRuleDraft): TriggerDraftErrors {
  const errors: TriggerDraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Enter a rule name.";
  else if (utf8ByteLength(name) > MAX_NAME_BYTES) {
    errors.name = `Name must be ${MAX_NAME_BYTES} bytes or smaller.`;
  } else if (CONTROL.test(name)) {
    errors.name = "Name contains unsupported characters.";
  }
  const matchPath = validateTriggerJsonPath(draft.matchJsonpath);
  if (matchPath) errors.matchJsonpath = matchPath;
  const operand = validateMatchOperand(draft.operator, draft.matchValue);
  if (operand) errors.matchValue = operand;
  const emailPath = validateTriggerJsonPath(draft.emailJsonpath);
  if (emailPath) errors.emailJsonpath = emailPath;
  const target = validateTarget(draft.actionType, draft.actionTargetId);
  if (target) errors.actionTargetId = target;
  return errors;
}
