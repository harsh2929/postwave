/**
 * Arrow glyphs must ask for TEXT presentation explicitly.
 *
 * WHY. `↗` (U+2197) and `⤴` (U+2934) are in Unicode's emoji set. iOS's system
 * font does not carry them, so the text stack falls back to Apple Color Emoji
 * and renders a saturated multicolour arrow next to grey 13pt label text. It
 * reads as a pasted emoji rather than an affordance, which is what the runtime
 * walk actually saw on the archive row.
 *
 * U+FE0E, the variation selector for text presentation, suppresses the emoji
 * fallback. The fix is one invisible codepoint -- which is exactly the problem:
 * nothing in review catches its absence, and nothing catches its deletion. Hence
 * a guard rather than a fix alone.
 *
 * Escapes (`↗︎`) rather than literal characters are deliberate. A bare
 * `↗︎` in source is one visible glyph plus one invisible one, and every editor,
 * linter autofix and copy-paste is free to drop the half nobody can see.
 *
 * No react-native imports -- node-run vitest.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Codepoints that fall back to the emoji font on iOS when unqualified. */
const DUAL_PRESENTATION = ["↗", "⤴", "↖", "↘", "↙", "⬆", "⬇"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/u.test(entry)) out.push(full);
  }
  return out;
}

describe("arrow glyphs render as text, not emoji", () => {
  const roots = ["src", "app"].map((r) => join(process.cwd(), r));
  const files = roots.flatMap((r) => sourceFiles(r));

  it("finds source to scan at all", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(400);
  });

  it("never leaves a literal arrow codepoint unqualified", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("textPresentationGlyphs.test.ts")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        // Comments explain the glyph; they are never rendered.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*/u, "");
        for (const glyph of DUAL_PRESENTATION) {
          let at = code.indexOf(glyph);
          while (at !== -1) {
            if (code[at + 1] !== "︎") {
              offenders.push(`${file.replace(process.cwd() + "/", "")}:${index + 1}`);
            }
            at = code.indexOf(glyph, at + 1);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
