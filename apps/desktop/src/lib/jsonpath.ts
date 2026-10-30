/**
 * Tiny JSONPath evaluator for the trigger editor's live preview.
 * Refined Webhooks PR 2 — pure frontend, no third-party dep.
 *
 * Supported syntax (covers the inbound trigger matcher's needs):
 *
 *   $              the root value
 *   $.foo          object property
 *   $.foo.bar      dotted path
 *   $.foo[0]       array index (non-negative only)
 *   $.foo[*]       glob — resolves to the FIRST array element only
 *
 * Unsupported syntax is rejected rather than normalised. This matters because
 * a definitive preview must never green-light a rule the server will reject:
 * recursive descent, negative indexes, filters, slices, unions, and partial
 * paths are outside this bounded grammar. Quoted bracket properties are
 * accepted under the server's deliberately narrow no-escape rules.
 */

export function evaluateJSONPath(root: unknown, path: string): unknown[] {
  const result = inspectJSONPath(root, path);
  return result.valid ? result.matches : [];
}

type Token =
  | { kind: "prop"; name: string }
  | { kind: "index"; idx: number }
  | { kind: "wildcard" };

export type JSONPathInspection =
  | { valid: true; matches: unknown[] }
  | { valid: false; matches: []; error: string };

const MAX_JSONPATH_BYTES = 512;

function parseJSONPath(path: string): { tokens: Token[] } | { error: string } {
  const value = (path ?? "").trim();
  if (!value || value[0] !== "$") {
    return { error: "Path must start at the root with $." };
  }
  if (new TextEncoder().encode(value).length > MAX_JSONPATH_BYTES) {
    return { error: `Path must be ${MAX_JSONPATH_BYTES} bytes or smaller.` };
  }
  if (value === "$") return { tokens: [] };

  const tokens: Token[] = [];
  let index = 1;
  while (index < value.length) {
    if (value[index] === ".") {
      index += 1;
      const start = index;
      while (
        index < value.length &&
        value[index] !== "." &&
        value[index] !== "["
      ) {
        index += 1;
      }
      const name = value.slice(start, index);
      if (!name || /[\s\u0000-\u001f\u007f'"*\\\]]/.test(name)) {
        return {
          error:
            "Use plain dotted property names such as $.customer.email. Recursive descent is not supported, and reserved JSONPath characters require a safely quoted bracket key.",
        };
      }
      tokens.push({ kind: "prop", name });
      continue;
    }
    if (value[index] === "[") {
      const close = value.indexOf("]", index + 1);
      if (close < 0) {
        return { error: "Array segment is missing its closing ]." };
      }
      const body = value.slice(index + 1, close).trim();
      if (body === "*") {
        tokens.push({ kind: "wildcard" });
      } else if (/^\d+$/.test(body)) {
        const parsed = Number(body);
        if (!Number.isSafeInteger(parsed)) {
          return { error: "Array index is too large." };
        }
        tokens.push({ kind: "index", idx: parsed });
      } else if (body[0] === "'" || body[0] === '"') {
        const quote = body[0];
        if (
          body.length < 3 ||
          body.at(-1) !== quote ||
          body.slice(1, -1).includes(quote) ||
          body.slice(1, -1).includes("\\") ||
          /[\u0000-\u001f\u007f]/.test(body.slice(1, -1))
        ) {
          return {
            error:
              "Quoted property brackets require one non-empty key without escapes or control characters.",
          };
        }
        tokens.push({ kind: "prop", name: body.slice(1, -1) });
      } else {
        return {
          error:
            "Brackets support a non-negative array index, [*], or a safely quoted property key.",
        };
      }
      index = close + 1;
      continue;
    }
    return {
      error: "Every segment after $ must start with a dot or array bracket.",
    };
  }
  return { tokens };
}

export function validateJSONPath(path: string): string | null {
  const parsed = parseJSONPath(path);
  return "error" in parsed ? parsed.error : null;
}

export function inspectJSONPath(
  root: unknown,
  path: string,
): JSONPathInspection {
  const parsed = parseJSONPath(path);
  if ("error" in parsed) {
    return { valid: false, matches: [], error: parsed.error };
  }
  return {
    valid: true,
    matches: walk([root], parsed.tokens, 0),
  };
}

function walk(values: unknown[], tokens: Token[], i: number): unknown[] {
  if (i >= tokens.length) return values;
  const t = tokens[i];
  const next: unknown[] = [];
  for (const v of values) {
    switch (t.kind) {
      case "prop":
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const obj = v as Record<string, unknown>;
          if (Object.prototype.hasOwnProperty.call(obj, t.name)) {
            next.push(obj[t.name]);
          }
        }
        break;
      case "index":
        // D12-comms-webhooks#8: mirror the server — a negative index never
        // matches (it does not resolve from the end of the array).
        if (Array.isArray(v) && t.idx >= 0 && t.idx < v.length) {
          next.push(v[t.idx]);
        }
        break;
      case "wildcard":
        // D12-comms-webhooks#8: the server's `[*]` glob resolves to the
        // FIRST array element only, and does not fan out over object values.
        if (Array.isArray(v) && v.length > 0) {
          next.push(v[0]);
        }
        break;
    }
  }
  return walk(next, tokens, i + 1);
}

/** Match operators mirror inbound_webhooks.Trigger.match_operator. */
export type MatchOperator = "equals" | "contains" | "exists" | "regex";

const MAX_REGEX_PATTERN_BYTES = 1024;
/**
 * Apply a match operator to a list of JSONPath matches + an
 * (optional) expected value. Mirrors EvaluateTriggers semantics on
 * the backend so the editor preview accurately predicts whether a
 * trigger will fire.
 */
export function matchOperator(
  op: MatchOperator,
  matches: unknown[],
  expected?: string | null,
): boolean {
  if (op === "exists") return matches.length > 0;
  if (matches.length === 0) return false;
  const want = expected ?? "";
  // Bound the user-supplied pattern: this runs on the render path, and
  // an oversized pattern amplifies catastrophic-backtracking risk.
  if (
    op === "regex" &&
    new TextEncoder().encode(want).length > MAX_REGEX_PATTERN_BYTES
  ) {
    return false;
  }
  for (const m of matches) {
    const s = typeof m === "string" ? m : JSON.stringify(m);
    switch (op) {
      case "equals":
        if (s === want) return true;
        break;
      case "contains":
        if (want !== "" && s.includes(want)) return true;
        break;
      case "regex":
        // Deliberately never execute a user-supplied regex in the renderer.
        // Go's bounded RE2 evaluator is authoritative after save.
        void s;
        break;
    }
  }
  return false;
}

/** Mirrors the server's required/forbidden operand rules before preview/save. */
export function validateMatchOperand(
  operator: MatchOperator,
  expected?: string | null,
): string | null {
  if (operator === "exists") return null;
  if (expected === undefined || expected === null) {
    return "This operator requires a comparison value.";
  }
  if (new TextEncoder().encode(expected).length > 4096) {
    return "Comparison value must be 4 KiB or smaller.";
  }
  if (operator === "contains" && expected === "") {
    return "Contains requires a non-empty value.";
  }
  if (operator === "regex") {
    if (expected === "") return "Regex requires a non-empty pattern.";
    if (new TextEncoder().encode(expected).length > MAX_REGEX_PATTERN_BYTES) {
      return `Regex must be ${MAX_REGEX_PATTERN_BYTES} bytes or smaller.`;
    }
    // Go's regexp package is RE2. Reject common JavaScript-only constructs so
    // the local preview cannot accept a pattern the server will reject.
    if (/\\[1-9]|\(\?(?:[=!]|<[=!])/.test(expected)) {
      return "Use RE2 syntax; backreferences and lookaround are not supported.";
    }
    try {
      void new RegExp(expected);
    } catch {
      return "Enter a valid regular expression.";
    }
  }
  return null;
}
