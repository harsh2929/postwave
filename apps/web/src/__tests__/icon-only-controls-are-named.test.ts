// SPDX-License-Identifier: AGPL-3.0-only
//
// A control whose entire content is an icon has no accessible name unless one
// is supplied. A screen reader announces "link" or "button" and nothing else,
// so the user is told a control exists and not what it does.
//
// Two shipped: the back links on sequences/[id] rendered a bare <ArrowLeft/>
// inside a <Button asChild><Link>. The app has 40+ correct icon controls and
// an IconButton primitive that REQUIRES aria-label, so this was drift, not a
// missing convention.
//
// THREE LEGITIMATE WAYS TO NAME ONE, all of which a naive scan calls a defect.
// Checking the accusations first is why this rule is narrow:
//   1. on the control itself      — <Link aria-label="…">
//   2. on the wrapping control    — <Button aria-label="…" asChild><Link>…
//      Six of the eight candidates were this. `asChild` merges the wrapper's
//      props onto the child, so the name lands on the rendered anchor.
//   3. from the icon's own content — <Link><TemplateThumbnail/></Link>, where
//      the child renders <img alt="Preview of …">. The name comes from
//      inside, and the control is correctly labelled.
//
// So the rule only fires when NO name is available from the control, its
// immediate wrapper, or the rendered child's alt text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** <Link|button|Button …>{single self-closing capitalised child}</…> */
const ICON_ONLY =
  /<(Link|button|Button)\b([^>]*)>\s*(<([A-Z]\w*)\b[^>]*\/>)\s*<\/\1>/g;

function hasName(attrs: string): boolean {
  return (
    /\saria-label(?:ledby)?=/.test(attrs) ||
    /\stitle=/.test(attrs) ||
    /\salt=/.test(attrs)
  );
}

/**
 * The ~600 characters before the control, which is enough to reach an
 * enclosing <Button …> opening tag across a multi-line prop list.
 */
function wrapperIsNamed(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 600), at);
  const lastOpen = before.lastIndexOf("<Button");
  if (lastOpen === -1) return false;
  const between = before.slice(lastOpen);
  // Only trust it if no intervening close tag ended that Button.
  if (/<\/Button>/.test(between)) return false;
  return hasName(between);
}

/** A child component that renders its own alt text names the control. */
function childSuppliesName(text: string, component: string): boolean {
  const decl = new RegExp(
    `function ${component}\\b[\\s\\S]{0,1200}?\\salt=`,
    "m",
  );
  return decl.test(text);
}

const FILES = walk(SRC);

describe("an icon-only control has an accessible name", () => {
  it("scans a non-trivial corpus and finds icon-only controls at all", () => {
    expect(FILES.length).toBeGreaterThan(400);
    let candidates = 0;
    for (const f of FILES) {
      candidates += [...readFileSync(f, "utf8").matchAll(ICON_ONLY)].length;
    }
    // Vacuity floor: if the pattern stopped matching, the rule below is free.
    expect(candidates).toBeGreaterThan(3);
  });

  it("still recognises a name on the wrapping Button", () => {
    // Guard the guard: six of eight candidates were named this way, and a
    // regression here would accuse all of them.
    const sample = `<Button asChild aria-label="Back to campaigns">\n<Link href="/x">\n<ArrowLeft className="h-4 w-4" />\n</Link>\n</Button>`;
    const m = [...sample.matchAll(ICON_ONLY)][0];
    expect(m).toBeDefined();
    expect(wrapperIsNamed(sample, m.index as number)).toBe(true);
  });

  it("names every icon-only link and button", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(ICON_ONLY)) {
        const [, , attrs, , childName] = m;
        if (hasName(attrs)) continue;
        if (/sr-only/.test(m[0])) continue;
        if (wrapperIsNamed(text, m.index as number)) continue;
        if (childSuppliesName(text, childName)) continue;
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${relative(SRC, file)}:${line} <${childName}/>`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});
