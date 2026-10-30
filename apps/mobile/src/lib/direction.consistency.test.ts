/**
 * RTL consistency — no directional glyph is baked into rendered copy.
 *
 * React Native mirrors LAYOUT under an RTL locale but cannot mirror a glyph
 * that lives inside a string, so `"enabled → blocklisted"` rendered in a
 * mirrored row puts the "after" value on the left with the arrow still
 * pointing right — the sentence reads backwards. `lib/direction` owns the
 * decision instead (`transitionLabel`, `pathLabel`, `forwardArrow`,
 * `forwardChevron`), so this guard's job is to stop a new literal appearing.
 *
 * SCOPE, STATED HONESTLY. This checks STRING LITERALS in production source —
 * parsed with the TypeScript compiler, so the many doc comments that discuss
 * `a → b` (including this one) are invisible to it, which a grep-based guard
 * could not manage. It does NOT prove the app is RTL-correct: physical
 * `left`/`right` style properties, absolute insets and icon assets are all
 * separate work, and the app does not call `I18nManager.forceRTL` at all
 * (see `localePolicy.deviceIsRTL` for why: mirroring the layout under
 * English-only copy would be a regression). What it does guarantee is that the
 * day the copy IS translated, no arrow is left pointing the wrong way.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const APP_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "src"];

/** The module allowed to spell these out. */
const DIRECTION_MODULE = "src/lib/direction.ts";

/** Arrows and chevrons that carry reading direction. */
const DIRECTIONAL = /[→←›‹»«⟩⟨]/u;

/**
 * Strings that keep a literal arrow, each because it is NOT a UI direction:
 *
 *  - `migrationSources`: long provider-caveat prose where "a stable-ID email
 *    A→B change" names a VALUE transition in the source system, not a
 *    direction on screen. Splitting it through `transitionLabel` would put
 *    spaces inside an identifier-like token and read worse.
 *  - `subscriberFunnel` / other doc-shaped constants are caught by the AST
 *    walker only if they are real string literals; none are today.
 */
const ALLOWLIST = new Set(["src/lib/migrationSources.ts"]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
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
    out.push(abs);
  }
  return out;
}

function scan(abs: string): Violation[] {
  const file = relative(APP_ROOT, abs).split(sep).join("/");
  if (file === DIRECTION_MODULE || ALLOWLIST.has(file)) return [];
  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: Violation[] = [];

  function record(node: ts.Node, text: string): void {
    if (!DIRECTIONAL.test(text)) return;
    found.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: text.trim().slice(0, 60),
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      record(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      record(node, node.text);
    } else if (ts.isTemplateTail(node)) {
      record(node, node.text);
    } else if (ts.isJsxText(node)) {
      record(node, node.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return found;
}

describe("no directional glyph is hardcoded in rendered copy", () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(join(APP_ROOT, dir)));

  it("scans the whole app", () => {
    expect(files.length).toBeGreaterThan(600);
  });

  // An explicit budget, because this assertion TypeScript-parses ~1,300 files
  // and the 5s default is simply the wrong number for a whole-repo AST scan.
  // Under `--coverage` the v8 instrumentation makes it ~10x slower, which was
  // enough to fail the coverage run — and a coverage gate that cannot be run
  // green is a gate nobody ratchets. See vitest.config.ts thresholds.
  it("arrows and chevrons come from lib/direction", { timeout: 60_000 }, () => {
    const violations = files
      .flatMap(scan)
      .map((v) => `${v.file}:${v.line} ${JSON.stringify(v.text)}`);
    expect(
      violations,
      "Use transitionLabel(from, to) for a state change, pathLabel([...]) for " +
        "a navigation path, or forwardArrow()/forwardChevron() directly. A " +
        "literal arrow points the wrong way once the layout mirrors.",
    ).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    for (const allowed of ALLOWLIST) {
      const abs = join(APP_ROOT, allowed);
      expect(
        DIRECTIONAL.test(readFileSync(abs, "utf8")),
        `${allowed} no longer contains a directional glyph; drop it from ALLOWLIST`,
      ).toBe(true);
    }
  });
});
