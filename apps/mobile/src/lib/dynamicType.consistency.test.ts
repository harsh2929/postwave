/**
 * Dynamic Type consistency — the executable half of `lib/typeScale`.
 *
 * WHY THIS TEST EXISTS. React Native scales every `Text` and `TextInput` with
 * the OS text-size setting, and at the largest accessibility sizes that
 * multiplier is roughly 3x. A node with no ceiling therefore grows until it
 * overflows whatever geometry holds it — a list row with a fixed height, a
 * status pill with a `maxWidth`, a button whose label pushes past its own
 * edge. `lib/typeScale` fixes that by pairing the size and the ceiling in one
 * ROLE, but a contract nothing enforces decays: the audit that produced this
 * file found ~14 hardcoded pixel sizes and four different hand-picked
 * multipliers (1.3 / 1.4 / 1.6 / 1.8) chosen independently per call site, with
 * most nodes carrying no ceiling at all.
 *
 * The two invariants below are what "Dynamic Type is supported" means for
 * this app, expressed so they cannot silently regress:
 *
 *   1. EVERY text-rendering node declares a ceiling. Three forms count, and
 *      the third is not a loophole:
 *        - `{...typeCap("role")}` — the contract, a role's ceiling;
 *        - an explicit `maxFontSizeMultiplier` — allowed only via a role (see
 *          invariant 2), which is what makes this form rare;
 *        - `allowFontScaling={false}` — for a DECORATIVE GLYPH standing in
 *          for an icon (a "×" close affordance, a padlock, a checkmark) whose
 *          meaning already reaches VoiceOver through the parent control's
 *          label. Icons do not scale with Dynamic Type on iOS either; letting
 *          one grow to 3x inside a 44pt target is a rendering bug, not an
 *          accommodation.
 *      A NESTED `<Text>` run inherits its parent's ceiling, so it is exempt —
 *      and must be, because an explicit size or leading on a nested run
 *      mis-centres it on Android.
 *
 *   2. NO HAND-PICKED CEILING. `maxFontSizeMultiplier` may only be produced
 *      by `typeCap()` or read off the `TYPE` table. A bare literal is the
 *      original defect: it decides "how far may this grow" in a different
 *      place from "how big is this", so the two drift.
 *
 * Import-free by construction: it reads source text off disk and parses it
 * with the TypeScript compiler, so it runs in the node vitest environment
 * even though every file it inspects imports react-native.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const APP_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "src"];

/** Nodes whose rendered text scales with the OS setting. */
const TEXT_TAGS = new Set([
  "Text",
  "Animated.Text",
  "TextInput",
  "Animated.TextInput",
]);

const CEILING_ATTR =
  /typeCap\(|maxFontSizeMultiplier|allowFontScaling=\{false\}/u;

/**
 * A bare numeric ceiling: `maxFontSizeMultiplier={1.6}`. Ceilings sourced from
 * the scale (`typeCap("body")`, `TYPE.label.maxFontSizeMultiplier`) are the
 * supported forms and are deliberately NOT matched here.
 */
const HAND_PICKED_CEILING = /maxFontSizeMultiplier=\{\s*[0-9]/u;

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly tag: string;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      sourceFiles(abs, out);
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    if (entry.endsWith(".test.tsx")) continue;
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

function parse(abs: string): ts.SourceFile {
  return ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function uncappedTextNodes(abs: string): Violation[] {
  const source = parse(abs);
  const file = relPath(abs);
  const found: Violation[] = [];

  /**
   * Returns whether an element's CHILDREN inherit a ceiling, recording a
   * violation when the element itself needed one and had none.
   *
   * `inherited` is true once we are inside a Text that declares a ceiling: RN
   * propagates `maxFontSizeMultiplier` / `allowFontScaling` to nested runs,
   * which is why a nested <Text> must NOT restate it (an explicit size or
   * leading on a nested run mis-centres it on Android).
   */
  function inspectTag(
    tagName: string,
    attributes: ts.JsxAttributes,
    at: ts.Node,
    inherited: boolean,
  ): boolean {
    if (!TEXT_TAGS.has(tagName)) return inherited;
    if (CEILING_ATTR.test(attributes.getText(source))) return true;
    if (!inherited) {
      found.push({ file, line: lineOf(source, at), tag: tagName });
    }
    return inherited;
  }

  function visit(node: ts.Node, inherited: boolean): void {
    if (ts.isJsxElement(node)) {
      const open = node.openingElement;
      const childInherits = inspectTag(
        open.tagName.getText(source),
        open.attributes,
        open,
        inherited,
      );
      // Attributes are evaluated OUTSIDE this element's text tree — a
      // `ListHeaderComponent={<Text …/>}` does not inherit its host's
      // ceiling — so they keep the enclosing value.
      visit(open.attributes, inherited);
      for (const child of node.children) visit(child, childInherits);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      inspectTag(
        node.tagName.getText(source),
        node.attributes,
        node,
        inherited,
      );
      visit(node.attributes, inherited);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inherited));
  }

  visit(source, false);
  return found;
}

function handPickedCeilings(abs: string): Violation[] {
  const source = parse(abs);
  const file = relPath(abs);
  const found: Violation[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === "maxFontSizeMultiplier" &&
      HAND_PICKED_CEILING.test(node.getText(source))
    ) {
      found.push({ file, line: lineOf(source, node), tag: "literal ceiling" });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function describeAll(violations: readonly Violation[]): string[] {
  return violations.map((v) => `${v.file}:${v.line} <${v.tag}>`);
}

describe("Dynamic Type — every text node declares a ceiling", () => {
  const files = allSourceFiles();

  it("scans the whole app (guards against the walker silently finding nothing)", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  // A whole-repo AST scan; 5s is the wrong budget for it even before
  // `--coverage` adds ~10x of v8 instrumentation overhead. A coverage gate that
  // cannot be run green is a gate nobody ever ratchets — see vitest.config.ts.
  it("no <Text>/<TextInput> renders without a Dynamic Type ceiling", { timeout: 60_000 }, () => {
    const violations = files.flatMap(uncappedTextNodes);
    expect(
      describeAll(violations),
      "Spread {...typeCap(\"role\")} on the ELEMENT (inside a style object it " +
        "silently does nothing), or allowFontScaling={false} when the node is " +
        "a decorative glyph standing in for an icon.",
    ).toEqual([]);
  });

  // A whole-repo AST scan; 5s is the wrong budget for it even before
  // `--coverage` adds ~10x of v8 instrumentation overhead. A coverage gate that
  // cannot be run green is a gate nobody ever ratchets — see vitest.config.ts.
  it("no ceiling is a hand-picked number — every one comes from a role", { timeout: 60_000 }, () => {
    const violations = files.flatMap(handPickedCeilings);
    expect(
      describeAll(violations),
      'Replace maxFontSizeMultiplier={1.6} with {...typeCap("role")} so the ' +
        "size and its ceiling are decided in one place (lib/typeScale).",
    ).toEqual([]);
  });
});
