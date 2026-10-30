// SPDX-License-Identifier: AGPL-3.0-only
//
// Every migration guide ships a copy-pasteable curl. Six of the eleven sent a
// body the API cannot parse, and the reason is invisible in the source: the
// snippets live in JS template literals, where `\"` is an escape that renders
// as a plain `"`. So
//
//     apiSource: `… -d "{ \"api_key\": \"$KEY\" }"`
//
// reached the page as  -d "{ "api_key": "$KEY" }"  — and bash, seeing adjacent
// quoted segments, concatenates them and strips the quotes, so curl POSTed
//
//     { api_key: abc123 }
//
// Unquoted keys. Invalid JSON, rejected before any credential is even looked
// at, with an error that points nowhere near the docs. Verified against the
// real shell, not reasoned about. Writing `\\"` in the literal is what carries
// a backslash through to the shell.
//
// Two guides had the mirror-image bug: a single-quoted payload containing
// $ACTIVECAMPAIGN_API_TOKEN, which bash does not expand at all, so the literal
// string "$ACTIVECAMPAIGN_API_TOKEN" was sent as the credential.
//
// Both are checked here by processing the payload the way a shell would and
// then parsing it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

interface Snippet {
  slug: string;
  rendered: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * Apply template-literal escape rules to raw source text.
 *
 * Deliberately not `new Function("return \`" + raw + "\`")`: evaluating source
 * to inspect source is both a code-execution footgun and unfaithful, because
 * an interpolation would silently resolve instead of being reported. The
 * escapes that occur here are `\\` → `\` and `\"` → `"`, which is precisely the
 * pair that produced the bug.
 */
function renderTemplateLiteral(raw: string): string {
  return raw.replace(/\\(.)/gs, (_, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

/**
 * Every curl snippet published anywhere in the app, rendered as it reaches the
 * reader.
 *
 * Originally scoped to the migration guides' `apiSource`, which missed the
 * four in the integrations guide's `code:` fields entirely — the same class of
 * under-scoping that let the native-tool count drift in three places. Any
 * backtick literal holding a curl invocation counts.
 */
function snippets(): Snippet[] {
  const out: Snippet[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/`([^`]*?\bcurl\s[^`]*?)`/g)) {
      const raw = m[1]!;
      // An interpolation would mean the rendered snippet depends on runtime
      // values this cannot see, so the checks below would be checking a string
      // no reader ever receives.
      if (/\$\{/.test(raw)) continue;
      out.push({
        slug: file.slice(SRC.length + 1),
        rendered: renderTemplateLiteral(raw),
      });
    }
  }
  return out;
}

/**
 * The `-d` payloads in a snippet, with the quoting style they use.
 *
 * Scoped to curl invocations rather than searched across the whole snippet:
 * the Substack and CSV guides both compute a byte count with
 * `wc -c < file | tr -d ' '`, and a bare search for `-d ` captured tr's
 * delete-characters flag as a curl body — reporting two guides broken that
 * were fine.
 */
function payloads(snippet: string): { quote: '"' | "'"; body: string }[] {
  // Split on curl invocations rather than on newlines: a -d payload may span
  // several raw lines inside its quotes, as the deliverability-provider
  // examples do, and splitting per line truncates the body mid-JSON.
  const commands = snippet
    .replace(/\\\n\s*/g, " ") // join backslash continuations
    .split(/\n(?=curl\s)/)
    .filter((chunk) => chunk.trimStart().startsWith("curl"));

  const out: { quote: '"' | "'"; body: string }[] = [];
  for (const command of commands) {
    for (const m of command.matchAll(
      /\s-d\s+("((?:[^"\\]|\\.)*)"|'([^']*)')/g,
    )) {
      if (m[2] !== undefined) out.push({ quote: '"', body: m[2] });
      else out.push({ quote: "'", body: m[3]! });
    }
  }
  return out;
}

/**
 * What the shell hands curl. Double quotes unescape `\"` and `\\` and expand
 * variables; single quotes pass everything through untouched.
 */
function afterShell(quote: '"' | "'", body: string): string {
  const unescaped = quote === '"' ? body.replace(/\\(["\\$`])/g, "$1") : body;
  // Stand in a value for each expansion so the result can be parsed.
  return quote === '"'
    ? unescaped.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "VALUE")
    : unescaped;
}

describe("published curl payloads", () => {
  const all = snippets();

  it("renders every guide's snippet", () => {
    // Guard the guard: a renamed field would leave nothing to check.
    expect(all.length).toBeGreaterThan(8);
    expect(
      all.filter((s) => payloads(s.rendered).length > 0).length,
    ).toBeGreaterThan(5);
    // Both surfaces that publish curl must be in scope.
    expect(all.some((s) => s.slug.includes("migrations"))).toBe(true);
    expect(all.some((s) => s.slug.includes("integrations"))).toBe(true);
  });

  it("sends a body the API can parse", () => {
    const broken: string[] = [];
    for (const { slug, rendered } of all) {
      for (const { quote, body } of payloads(rendered)) {
        const shellSees = afterShell(quote, body);
        try {
          JSON.parse(shellSees);
        } catch {
          broken.push(`${slug}: ${shellSees.slice(0, 70)}`);
        }
      }
    }
    expect(broken.sort()).toEqual([]);
  });

  it("never puts a shell variable inside single quotes", () => {
    // Single quotes suppress expansion, so the placeholder itself is sent as
    // the credential — a 401 whose cause is nowhere on the page.
    const literal: string[] = [];
    for (const { slug, rendered } of all) {
      for (const { quote, body } of payloads(rendered)) {
        if (quote === "'" && /\$[A-Za-z_]/.test(body)) {
          literal.push(`${slug}: ${body.slice(0, 70)}`);
        }
      }
    }
    expect(literal.sort()).toEqual([]);
  });

  it("keeps the placeholders visible for the reader to replace", () => {
    // Guard the guard the other way: escaping everything into valid JSON would
    // also pass if the values had been replaced by literals. Every credential
    // payload should still name an environment variable.
    const withVars = all.filter(({ rendered }) =>
      payloads(rendered).some(({ body }) => /\$[A-Z_]{4,}/.test(body)),
    );
    expect(withVars.length).toBeGreaterThan(4);
  });
});
