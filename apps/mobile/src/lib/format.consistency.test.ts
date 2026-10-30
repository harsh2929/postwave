/**
 * Formatting consistency — the executable half of `lib/format`.
 *
 * WHY THIS TEST EXISTS. `lib/format` was written to be the app's single
 * formatting vocabulary, and for a long time almost nothing used it: screens
 * kept calling `n.toLocaleString()` in one place and `String(n)` in another,
 * four hand-rolled `timeAgo` implementations disagreed about what "2 days" is
 * called, `new Date(x).toLocaleDateString()` rendered "Invalid Date" for the
 * empty strings this API returns, and "1 subscribers" shipped. None of those
 * is a bug on its own; together they are the texture that makes an app feel
 * unfinished — and none of them is visible in review, because each call site
 * looks reasonable in isolation.
 *
 * Two invariants, both about WHERE a format decision may be made:
 *
 *   1. NO `toLocale*` OUTSIDE `lib/format`. `toLocaleString()` is the exact
 *      call the module replaces. It ignores `setFormatLocale()`, renders
 *      `NaN` for an absent measurement where the contract is an em-dash, and
 *      pins nothing about grouping or precision, so two screens showing the
 *      same figure can disagree.
 *   2. NO RAW `Intl` FORMATTER outside `lib/format` and a short, reasoned
 *      allowlist. The allowlisted modules are not doing presentation: they
 *      are doing TIMEZONE ARITHMETIC (reading an instant's wall clock in a
 *      named zone via `formatToParts`), PROVING A LOCALE TAG is usable, or
 *      SELECTING A GRAMMATICAL CATEGORY. All three genuinely need the
 *      constructor, and none of them renders a value the user reads as a
 *      number or a date.
 *
 * A NOTE ON WHAT THIS DOES NOT CLAIM. Passing does not mean every string in
 * the app is well formatted; it means no NEW call site can quietly re-open
 * the split. That is the property that decayed last time.
 *
 * Import-free by construction: it parses source off disk with the TypeScript
 * compiler, so it runs in the node vitest environment. Using the AST rather
 * than a text scan matters — half the surviving mentions of `toLocaleString`
 * in this repo are inside doc comments explaining why it was removed, and a
 * grep-based guard would fail on its own commit message.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const APP_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "src"];

/** The module every formatting decision is allowed to live in. */
const FORMAT_MODULE = "src/lib/format.ts";

const LOCALE_METHODS = new Set([
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
]);

/**
 * Modules that may construct an `Intl` formatter directly, each because it is
 * NOT formatting for display:
 *
 *  - `smsPolicies` / `sendingForm`: read an instant's wall clock in a named
 *    IANA zone with `formatToParts`, which is the only portable way to do
 *    zone arithmetic in JS, and validate that a zone string is one the engine
 *    knows. Quiet-hours correctness depends on it.
 *  - `localePolicy`: proves a locale TAG by constructing both formatters and
 *    catching — a shape check is not sufficient, because `Intl.NumberFormat`
 *    and `Intl.DateTimeFormat` do not always agree about what they accept.
 *  - `i18n`: constructs `Intl.PluralRules`, which is NOT a formatter — it
 *    emits no text at all. It answers "which CLDR category does this count
 *    fall in" ("one" / "few" / "many" / …), and that token selects which
 *    catalogue SENTENCE to render. `lib/format` cannot own it because the
 *    thing being selected is a message, not a number: `format.plural` still
 *    exists for the `n === 1` English case, and the whole point of the i18n
 *    seam is that Polish has four categories and Japanese has one. Feature-
 *    detected there, because a reduced-ICU Hermes build has no PluralRules
 *    and a missing Intl API must degrade, never throw inside a count line.
 */
const INTL_ALLOWLIST = new Set([
  FORMAT_MODULE,
  "src/lib/smsPolicies.ts",
  "src/lib/sendingForm.ts",
  "src/lib/localePolicy.ts",
  "src/lib/i18n.ts",
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      sourceFiles(abs, out);
      continue;
    }
    if (!/\.tsx?$/u.test(entry)) continue;
    if (/\.test\.tsx?$/u.test(entry)) continue;
    if (entry.endsWith(".d.ts")) continue;
    out.push(abs);
  }
  return out;
}

function allSourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));
}

function relPath(abs: string): string {
  return relative(APP_ROOT, abs).split(sep).join("/");
}

function scan(abs: string): {
  locale: Violation[];
  intl: Violation[];
} {
  const file = relPath(abs);
  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const locale: Violation[] = [];
  const intl: Violation[] = [];

  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      LOCALE_METHODS.has(node.name.text) &&
      file !== FORMAT_MODULE
    ) {
      locale.push({ file, line: lineOf(node), what: `.${node.name.text}()` });
    }
    if (ts.isNewExpression(node) && !INTL_ALLOWLIST.has(file)) {
      const callee = node.expression.getText(source);
      if (/^Intl\./u.test(callee)) {
        intl.push({ file, line: lineOf(node), what: `new ${callee}` });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return { locale, intl };
}

function render(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line} ${v.what}`);
}

describe("formatting goes through lib/format", () => {
  const files = allSourceFiles();
  const results = files.map(scan);

  it("scans the whole app (guards against the walker finding nothing)", () => {
    expect(files.length).toBeGreaterThan(600);
  });

  it("no screen, component or lib module calls toLocale* directly", () => {
    expect(
      render(results.flatMap((r) => r.locale)),
      "Use lib/format instead: num / compactNum / percent / money / plural " +
        "for figures, date / dateTime / time / calendarDate / relativeTime " +
        "for instants. They guard NaN and Invalid Date and honour " +
        "setFormatLocale().",
    ).toEqual([]);
  });

  it("no module builds its own Intl formatter outside the allowlist", () => {
    expect(
      render(results.flatMap((r) => r.intl)),
      "lib/format owns the cached formatters. Add a helper there rather than " +
        "a second formatter here; the allowlist is only for timezone " +
        "arithmetic and locale-tag validation.",
    ).toEqual([]);
  });

  it("the Intl allowlist has no stale entries", () => {
    const withIntl = new Set(
      files
        .filter((abs) => /new Intl\./u.test(readFileSync(abs, "utf8")))
        .map(relPath),
    );
    for (const allowed of INTL_ALLOWLIST) {
      expect(
        withIntl.has(allowed),
        `${allowed} no longer constructs an Intl formatter; drop it from INTL_ALLOWLIST`,
      ).toBe(true);
    }
  });
});
