// SPDX-License-Identifier: AGPL-3.0-only
//
// NativeWind v4 silently drops a Pressable's layout when `style` is a
// function.
//
//     style={({ pressed }) => ({ borderWidth: 1, padding: 12, opacity: … })}
//
// buys the pressed opacity and pays with every other property in the object.
// Nothing throws, nothing warns, and the control renders as bare text. This
// was the root cause of widespread UI breakage on this stack once already,
// which is why 33 files now carry a hand-written comment about it and
// scripts/fix-pressable-style.mjs exists to repair it.
//
// A comment in 33 files is a convention maintained by memory. This is the same
// convention maintained by CI — the codemod could FIX the pattern but nothing
// DETECTED it, so the one live instance
// (SubscriberEmailHealthCard's "Retry email health" button, which rendered
// with no border, radius, padding or top margin) survived every review.
//
// Comments are stripped before matching. Most files that mention this pattern
// only warn about it, and a sweep that counted those would report 33
// violations and be turned off within a day.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

/** Source with comments removed, so a warning about the pattern is not a use. */
function visibleCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("Pressable style props are static objects", () => {
  const files = tsxFiles(SRC);

  it("scans the component tree", () => {
    // Guard the guard: an empty scan passes silently, and a silently-empty
    // check for a silent failure mode is the worst possible combination.
    expect(files.length).toBeGreaterThan(300);
    expect(
      files.some((f) => /<Pressable/.test(readFileSync(f, "utf8"))),
      "no Pressable found at all",
    ).toBe(true);
  });

  it("uses no function-style style prop", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = visibleCode(readFileSync(file, "utf8"));
      // style={({ pressed }) => …} in any spacing, including multi-line.
      if (/style=\{\s*\(\s*\{[^}]*\bpressed\b[^}]*\}\s*\)\s*=>/.test(code)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it("does not treat a warning comment as a use", () => {
    // 33 files document this gotcha in prose. If stripping comments ever
    // regresses, this check starts reporting them and the whole guard becomes
    // noise — so assert the stripper works on the real corpus.
    const documented = files.filter((f) =>
      /pressed\b[^\n]*=>/.test(readFileSync(f, "utf8")),
    );
    expect(documented.length).toBeGreaterThan(5);
    for (const file of documented) {
      const code = visibleCode(readFileSync(file, "utf8"));
      expect(
        /style=\{\s*\(\s*\{[^}]*\bpressed\b[^}]*\}\s*\)\s*=>/.test(code),
        `${file.slice(SRC.length + 1)} should be comment-only`,
      ).toBe(false);
    }
  });

  it("keeps press feedback available without the function form", () => {
    // The function form is usually reached for to get pressed-opacity. The
    // house alternative is android_ripple with a static style; if that
    // disappeared, the rule above would be pushing people toward controls with
    // no press affordance at all.
    const rippled = files.filter((f) =>
      /android_ripple=/.test(visibleCode(readFileSync(f, "utf8"))),
    );
    expect(rippled.length).toBeGreaterThan(0);
  });
});
