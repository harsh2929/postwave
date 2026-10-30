/**
 * NATIVE#42 / LOVE#21 — every `<Text>` in the app carries a scale ceiling.
 *
 * The audit found "no Dynamic Type support anywhere": zero
 * `maxFontSizeMultiplier`, fixed pixel sizes throughout. An uncapped `<Text>`
 * at the largest accessibility text size overflows its container, clips, or
 * shoulders a sibling off-screen — and the failure is invisible to anyone
 * developing at the default size, which is why it survived so long.
 *
 * The fix was `lib/typeScale.ts` plus a sweep of ~1,000 text nodes. A sweep is
 * a moment in time; THIS is what keeps it true. Without a test, the next screen
 * someone writes reintroduces the problem one `<Text>` at a time and nothing
 * says a word.
 *
 * A node counts as capped when its own opening tag carries `typeCap(...)`, a
 * literal `maxFontSizeMultiplier`, or an explicit `allowFontScaling={false}`
 * (legitimate ONLY for a decorative glyph standing in for an icon) — or when
 * it is NESTED inside another Text run, which inherits the parent's ceiling.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCANNED = ["src", "app"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The props of one JSX element — from `<Text` to the `>` that closes its
 * OPENING tag.
 *
 * A fixed line window was the obvious approach and it is wrong in both
 * directions: too short and a well-commented element (ScreenHeader's title
 * carries an 8-line note about the VoiceOver rotor before its cap) reads as
 * uncapped; too long and a cap belonging to the NEXT element counts for this
 * one. Bounding by the tag itself is exact.
 */
function openingTag(lines: readonly string[], start: number): string {
  const out: string[] = [];
  let depth = 0;
  for (let i = start; i < lines.length && i < start + 60; i += 1) {
    const line = lines[i] ?? "";
    out.push(line);
    // Track braces so a `>` inside `style={{ ... }}` does not end the tag.
    for (const ch of line) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth <= 0 && /(?:^|[^=!<>])>\s*$/.test(line.trimEnd())) break;
  }
  return out.join("\n");
}

/**
 * Is this `<Text` nested inside another `<Text` run?
 *
 * React Native inherits `maxFontSizeMultiplier` down a Text run, so a nested
 * node is already capped by its parent — and re-declaring it on the child is
 * not merely redundant, it mis-centres the inline run on Android. Detecting
 * the nesting is better than exempting the FILE, which would also excuse a
 * genuinely uncapped node elsewhere in the same component.
 */
function nestedInsideText(lines: readonly string[], index: number): boolean {
  // Strip comment lines so prose about `<Text>` never opens a run.
  const prefix = lines
    .slice(0, index)
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join("\n");

  let depth = 0;
  // Walk opening tags, closing tags and self-closing tags in document order.
  // A self-closing <Text … /> must not leave the run open, which is the bug a
  // naive open/close counter makes.
  const token = /<Text(?=[\s/>])[^>]*?(\/?)>|<\/Text\s*>/g;
  for (const m of prefix.matchAll(token)) {
    if (m[0].startsWith("</")) depth -= 1;
    else if (m[1] === "/") continue;
    else depth += 1;
  }
  return depth > 0;
}

interface Uncapped {
  file: string;
  line: number;
}

function uncappedTextNodes(): { total: number; uncapped: Uncapped[] } {
  const uncapped: Uncapped[] = [];
  let total = 0;
  for (const dir of SCANNED) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        // A real JSX opening, not a generic like `useRef<Text>` and not prose
        // inside a comment.
        if (!/<Text(\s*$|\s+[a-zA-Z{])/.test(line)) continue;
        if (/\w<Text/.test(line)) continue;
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        total += 1;
        const window = openingTag(lines, i);
        const capped =
          window.includes("typeCap(") ||
          window.includes("maxFontSizeMultiplier") ||
          window.includes("allowFontScaling={false}");
        if (!capped && !nestedInsideText(lines, i)) {
          uncapped.push({ file: rel, line: i + 1 });
        }
      }
    }
  }
  return { total, uncapped };
}

describe("Dynamic Type coverage", () => {
  const { total, uncapped } = uncappedTextNodes();

  it("scans a realistic number of text nodes", () => {
    // Guards the scanner itself: a regex that silently stops matching would
    // otherwise make this whole file pass by finding nothing to check.
    expect(total).toBeGreaterThan(1_000);
  });

  it("caps every <Text> in the app", () => {
    expect(
      uncapped,
      uncapped.length
        ? `Uncapped <Text> nodes — add {...typeCap("role")} (spread on the ELEMENT, ` +
          `not inside the style object, where it silently does nothing):\n` +
          uncapped.map((u) => `  ${u.file}:${u.line}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("does not excuse a top-level node by calling it nested", () => {
    // Guards the nesting detector: if it started returning true everywhere,
    // the suite above would pass by excusing everything.
    const lines = [
      "<View>",
      "  <Text>",
      "</Text>",
      "  <Text>",
    ];
    expect(nestedInsideText(lines, 1)).toBe(false);
    expect(nestedInsideText(lines, 3)).toBe(false);
    expect(nestedInsideText(["<Text>", "  <Text>"], 1)).toBe(true);
  });
});
