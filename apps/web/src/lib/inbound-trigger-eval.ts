// SPDX-License-Identifier: AGPL-3.0-only
//
// Client-side trigger simulation for the inbound-webhooks triggers page
// (INTG-023). Mirrors the backend's JSONPath resolver + operator semantics
// (apps/api/internal/inbound_webhooks/triggers.go) so an operator can test a
// match rule against a sample payload BEFORE shipping it — without a round-trip
// and without executing any side-effect. Kept pure (no JSX / no fetch) so it is
// unit-tested under the node vitest environment against the Go implementation's
// behaviour.

import type { TriggerOperator } from "./inbound-webhooks-api";

type Segment =
  | { kind: "key"; key: string }
  | { kind: "index"; idx: number }
  | { kind: "glob" };

// Splits a path body like "user.items[0].name" / "answers[*].email" into
// key / index / glob segments, detaching bracket groups from the preceding key.
function parseSegments(body: string): Segment[] {
  const out: Segment[] = [];
  let p = body;
  while (p.length > 0) {
    const end = (() => {
      const dot = p.indexOf(".");
      const bracket = p.indexOf("[");
      if (dot === -1) return bracket;
      if (bracket === -1) return dot;
      return Math.min(dot, bracket);
    })();
    if (end === -1) {
      out.push({ kind: "key", key: p });
      return out;
    }
    if (end > 0) out.push({ kind: "key", key: p.slice(0, end) });
    const ch = p[end];
    p = p.slice(end + 1);
    if (ch === ".") continue;
    // '[' — read until ']'
    const close = p.indexOf("]");
    if (close === -1) return out;
    const inner = p.slice(0, close).trim();
    p = p.slice(close + 1);
    if (inner === "*") {
      out.push({ kind: "glob" });
    } else {
      const idx = Number.parseInt(inner, 10);
      if (Number.isNaN(idx)) return out;
      out.push({ kind: "index", idx });
    }
    // A following '.' before the next key is consumed here.
    if (p.startsWith(".")) p = p.slice(1);
  }
  return out;
}

function step(cur: unknown, seg: Segment): { value: unknown; ok: boolean } {
  switch (seg.kind) {
    case "key": {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        const rec = cur as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(rec, seg.key)) {
          return { value: rec[seg.key], ok: true };
        }
      }
      return { value: undefined, ok: false };
    }
    case "index": {
      if (Array.isArray(cur) && seg.idx >= 0 && seg.idx < cur.length) {
        return { value: cur[seg.idx], ok: true };
      }
      return { value: undefined, ok: false };
    }
    case "glob": {
      // "[*]" resolves to the first element (matches the Go v1 behaviour).
      if (Array.isArray(cur) && cur.length > 0) {
        return { value: cur[0], ok: true };
      }
      return { value: undefined, ok: false };
    }
  }
}

/**
 * Resolves a `$.a.b[0].c` JSONPath against a decoded JSON value. Returns
 * `found:false` when any segment misses (mirrors QueryJSONPath in Go).
 */
export function queryJsonPath(
  value: unknown,
  path: string,
): { value: unknown; found: boolean } {
  const p = path.trim();
  if (!p.startsWith("$")) return { value: undefined, found: false };
  let body = p.slice(1);
  if (body.startsWith(".")) body = body.slice(1);
  if (body === "") return { value, found: true };
  let cur: unknown = value;
  for (const seg of parseSegments(body)) {
    const r = step(cur, seg);
    if (!r.ok) return { value: undefined, found: false };
    cur = r.value;
  }
  return { value: cur, found: true };
}

/** Renders a resolved value to the comparable string the backend uses. */
export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Mirrors operatorMatches() in the Go trigger evaluator. */
export function operatorMatches(
  op: TriggerOperator,
  actual: unknown,
  found: boolean,
  expected: string | null | undefined,
): boolean {
  switch (op) {
    case "exists":
      return found;
    case "equals":
      if (!found || expected == null) return false;
      return stringify(actual) === expected;
    case "contains":
      if (!found || expected == null) return false;
      return stringify(actual).includes(expected);
    case "regex":
      if (!found || expected == null) return false;
      try {
        return new RegExp(expected).test(stringify(actual));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export interface TriggerRule {
  match_jsonpath: string;
  match_operator: TriggerOperator;
  match_value?: string | null;
  email_jsonpath: string;
}

export interface TriggerSimulation {
  matched: boolean;
  matchedValue?: unknown;
  resolvedEmail: string | null;
  emailValid: boolean;
  /** Operator-safe explanation when the rule matched but email failed. */
  note: string | null;
}

/** Evaluates a rule against an already-decoded payload (no side effects). */
export function evaluateTriggerMatch(
  payload: unknown,
  rule: TriggerRule,
): TriggerSimulation {
  const { value: matchedValue, found } = queryJsonPath(
    payload,
    rule.match_jsonpath,
  );
  const matched = operatorMatches(
    rule.match_operator,
    matchedValue,
    found,
    rule.match_value,
  );
  if (!matched) {
    return { matched: false, resolvedEmail: null, emailValid: false, note: null };
  }
  const email = queryJsonPath(payload, rule.email_jsonpath);
  if (!email.found) {
    return {
      matched: true,
      matchedValue,
      resolvedEmail: null,
      emailValid: false,
      note: `Matched, but email JSONPath "${rule.email_jsonpath}" did not resolve.`,
    };
  }
  const resolved = stringify(email.value).trim();
  const emailValid = resolved !== "" && resolved.includes("@");
  return {
    matched: true,
    matchedValue,
    resolvedEmail: resolved || null,
    emailValid,
    note: emailValid
      ? null
      : `Matched, but resolved value "${resolved}" is not a valid email address.`,
  };
}

export interface TriggerSimulationResult extends TriggerSimulation {
  parseError: string | null;
}

/** Parses raw JSON text then evaluates the rule; surfaces JSON errors. */
export function simulateTrigger(
  rawJson: string,
  rule: TriggerRule,
): TriggerSimulationResult {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch (e) {
    return {
      matched: false,
      resolvedEmail: null,
      emailValid: false,
      note: null,
      parseError: e instanceof Error ? e.message : "Invalid JSON",
    };
  }
  return { ...evaluateTriggerMatch(payload, rule), parseError: null };
}
