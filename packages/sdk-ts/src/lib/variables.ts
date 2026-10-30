// SPDX-License-Identifier: MIT
//
// Variable convention helper.
//
// Moosewave's MJML / HTML body templates use Jinja-style placeholders
// (`{{first_name}}`). When pasting into JS template-literal code or a
// Go-template snippet, the convention shifts. This helper translates
// between the three.
//
//   Jinja:        {{first_name}}
//   JS (literal): ${firstName}
//   Go template:  {{ .FirstName }}
//
// Translation is purely textual — we do not attempt to evaluate the
// template. Variable names are normalized through snake_case as the
// canonical form.

export type VariableConvention = "jinja" | "js" | "go-template";

interface ParsedVar {
  /** Original text we matched (used to splice back in). */
  match: string;
  /** Variable name in canonical snake_case. */
  name: string;
  /** Position the match starts at. */
  index: number;
}

const JINJA_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const JS_RE = /\$\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}/g;
// Go-template: {{ .FirstName }} — leading dot is required.
const GO_RE = /\{\{\s*\.([A-Z][A-Za-z0-9_]*)\s*\}\}/g;

function snakeFromCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function snakeFromPascal(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/^_/, "").toLowerCase();
}
function camelFromSnake(s: string): string {
  return s
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}
function pascalFromSnake(s: string): string {
  const camel = camelFromSnake(s);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function parse(input: string, from: VariableConvention): ParsedVar[] {
  const out: ParsedVar[] = [];
  let re: RegExp;
  let normalize: (raw: string) => string;
  if (from === "jinja") {
    re = new RegExp(JINJA_RE.source, "g");
    normalize = (raw) => raw.toLowerCase();
  } else if (from === "js") {
    re = new RegExp(JS_RE.source, "g");
    normalize = (raw) => snakeFromCamel(raw);
  } else {
    re = new RegExp(GO_RE.source, "g");
    normalize = (raw) => snakeFromPascal(raw);
  }
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    out.push({ match: m[0], name: normalize(raw), index: m.index });
  }
  return out;
}

function emit(name: string, to: VariableConvention): string {
  if (to === "jinja") return `{{${name}}}`;
  if (to === "js") return `\${${camelFromSnake(name)}}`;
  return `{{ .${pascalFromSnake(name)} }}`;
}

/**
 * Translate template variable placeholders in `input` from one
 * convention to another. Surrounding text is preserved verbatim.
 */
export function translateVariables(
  input: string,
  from: VariableConvention,
  to: VariableConvention,
): string {
  if (from === to) return input;
  const found = parse(input, from);
  if (found.length === 0) return input;
  let out = "";
  let cursor = 0;
  for (const v of found) {
    out += input.slice(cursor, v.index);
    out += emit(v.name, to);
    cursor = v.index + v.match.length;
  }
  out += input.slice(cursor);
  return out;
}
