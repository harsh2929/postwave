// SPDX-License-Identifier: AGPL-3.0-only
//
// Small, safe helpers for rendering webhook payloads / transform output in the
// inbound-webhooks UI (INTG-003/004). All output is rendered as escaped text
// inside <pre> — never dangerouslySetInnerHTML — so a hostile payload can never
// inject markup. These helpers only pretty-print and bound the string.

/** Max characters rendered in a payload preview before eliding the tail. */
export const JSON_PREVIEW_MAX = 4000;

/**
 * Pretty-prints a JSON string with 2-space indent. Returns the original string
 * unchanged when it is not valid JSON (e.g. a raw non-JSON webhook body), so the
 * operator still sees exactly what was received.
 */
export function prettyJson(raw: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

/** Pretty-prints an already-decoded value (used for transform-preview output). */
export function prettyJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Bounds a preview string so a giant payload can't blow out the DOM. */
export function boundPreview(text: string, max = JSON_PREVIEW_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** Convenience: pretty-print then bound, for a payload preview block. */
export function payloadPreview(raw: string, max = JSON_PREVIEW_MAX): string {
  return boundPreview(prettyJson(raw), max);
}
