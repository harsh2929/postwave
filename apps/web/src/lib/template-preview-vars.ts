const MAX_TEMPLATE_VARS_BYTES = 64 * 1024;
const MAX_TEMPLATE_VAR_KEYS = 100;
const MAX_TEMPLATE_VAR_KEY_CHARS = 128;
const MAX_TEMPLATE_VAR_VALUE_CHARS = 4096;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export type TemplatePreviewVarsParseResult =
  | { vars: Record<string, string>; error: null }
  | { vars: null; error: string };

export function parseTemplatePreviewVars(
  input: string,
): TemplatePreviewVarsParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { vars: {}, error: null };
  if (utf8ByteLength(trimmed) > MAX_TEMPLATE_VARS_BYTES) {
    return {
      vars: null,
      error: "Variables JSON is too large. Keep it under 64 KB.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (err) {
    return {
      vars: null,
      error: err instanceof Error ? err.message : "Invalid JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { vars: null, error: "vars must be a JSON object" };
  }

  const entries = Object.entries(parsed);
  if (entries.length > MAX_TEMPLATE_VAR_KEYS) {
    return {
      vars: null,
      error: `Variables JSON can include at most ${MAX_TEMPLATE_VAR_KEYS} keys.`,
    };
  }

  const vars: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      !key ||
      key.length > MAX_TEMPLATE_VAR_KEY_CHARS ||
      key.trim() !== key ||
      CONTROL_RE.test(key)
    ) {
      return {
        vars: null,
        error: `Variable names must be 1-${MAX_TEMPLATE_VAR_KEY_CHARS} characters.`,
      };
    }
    const stringValue = value == null ? "" : String(value);
    if (stringValue.length > MAX_TEMPLATE_VAR_VALUE_CHARS) {
      return {
        vars: null,
        error: `Variable "${key}" is too long. Keep values under ${MAX_TEMPLATE_VAR_VALUE_CHARS} characters.`,
      };
    }
    vars[key] = stringValue;
  }

  return { vars, error: null };
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
