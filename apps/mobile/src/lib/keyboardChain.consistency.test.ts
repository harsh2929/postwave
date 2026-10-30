/**
 * Keyboard-submit consistency — the executable half of `lib/keyboardChain`.
 *
 * WHY THIS TEST EXISTS. The audit counted every `TextInput` in the app:
 * `returnKeyType` on 15 of 53, `onSubmitEditing` on 8, `blurOnSubmit` /
 * `submitBehavior` on none. So most fields rendered a return key that did
 * nothing, and every multi-field form — API connection, account deletion,
 * outbound webhooks, the sign-in credential fields, the sequence step editor —
 * had to be filled by dismissing the keyboard and tapping the next field.
 * That is not a defect any single diff introduces; it is one that accumulates
 * one unremarkable field at a time, which is exactly what a guard is for.
 *
 * THE INVARIANT. Every SINGLE-LINE `TextInput` declares what its return key
 * does. Three declarations count: a `keyboardChain(...)` / `keyboardDismiss()`
 * spread (the contract), an explicit `returnKeyType`, or a `{...rest}` /
 * `{...props}` pass-through on a wrapper whose caller decides (`PasswordField`,
 * `SettingsTextInput`, `CampaignFieldInput`).
 *
 * MULTILINE FIELDS ARE EXEMPT, and deliberately so: React Native's default
 * submit behaviour for a multiline input is "newline", which is the correct
 * behaviour for a body field. A multiline field that DOES want a return-key
 * action has to opt in via `keyboardChain({ multiline: true })`, because
 * without an explicit `submitBehavior` its `onSubmitEditing` would never fire
 * at all — the subtlety this module exists to stop people rediscovering.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

const APP_ROOT = join(__dirname, "..", "..");
const SCANNED_DIRS = ["app", "src"];

const INPUT_TAGS = new Set(["TextInput", "Animated.TextInput"]);

/** Any of these on the element means the return key's job is declared. */
const DECLARES_RETURN_KEY =
  /keyboardChain\(|keyboardDismiss\(|returnKeyType|\{\.\.\.rest\}|\{\.\.\.props\}/u;

interface Violation {
  readonly file: string;
  readonly line: number;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      sourceFiles(abs, out);
      continue;
    }
    if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
    out.push(abs);
  }
  return out;
}

function scan(abs: string): { total: number; violations: Violation[] } {
  const file = relative(APP_ROOT, abs).split(sep).join("/");
  const source = ts.createSourceFile(
    abs,
    readFileSync(abs, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: Violation[] = [];
  let total = 0;

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (INPUT_TAGS.has(node.tagName.getText(source))) {
        total += 1;
        const attrs = node.attributes.getText(source);
        // `multiline` (bare or `={true}`) keeps RN's newline default.
        const multiline = /\bmultiline\b(?!=\{false\})/u.test(attrs);
        if (!multiline && !DECLARES_RETURN_KEY.test(attrs)) {
          violations.push({
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return { total, violations };
}

describe("every single-line TextInput declares its return key", () => {
  const results = SCANNED_DIRS.flatMap((dir) =>
    sourceFiles(join(APP_ROOT, dir)),
  ).map(scan);

  it("finds the app's text inputs (guards against an empty scan)", () => {
    const total = results.reduce((sum, r) => sum + r.total, 0);
    expect(total).toBeGreaterThan(40);
  });

  it("no single-line input leaves the return key doing nothing", () => {
    const violations = results
      .flatMap((r) => r.violations)
      .map((v) => `${v.file}:${v.line}`);
    expect(
      violations,
      "Spread keyboardChain({ next: someRef }) to advance to the next field, " +
        "keyboardChain({ onSubmit }) for the last field in a form, or " +
        "keyboardDismiss() when the return key should only close the keyboard.",
    ).toEqual([]);
  });
});
