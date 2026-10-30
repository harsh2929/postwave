// SPDX-License-Identifier: AGPL-3.0-only
//
// A horizontally scrolling region has to be able to take focus, or a
// keyboard-only visitor cannot scroll it at all (WCAG 2.1.1). Code samples and
// wide tables are exactly the content that overflows and exactly the content
// with nothing focusable inside to scroll it into view.
//
// This is also a lesson about detector shape. The first sweep looked for
// `<pre …overflow-x-auto>` and reported 18 offenders. The docs CodeBlock puts
// the scroll on the *div* wrapping Shiki's <pre>, and every wide table puts it
// on the div wrapping the <table> — 43 of the 60 scroll containers in this app
// are divs, so the real figure was three times what was reported. The parser
// below walks back to whichever JSX tag actually owns the className.
//
// The remaining offenders are mostly in surfaces the audit has not read yet,
// so this is a ratchet, not a clean bill of health: it fails when a NEW
// unfocusable scroll region appears, or when a file listed here is fixed
// without being removed from the list.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * The JSX opening tag that owns the className at `at` — scan back to its `<`,
 * forward to the `>` that closes it, counting braces so a `className={cn(…)}`
 * or an arrow function in an earlier prop cannot end the tag early.
 */
function owningTag(text: string, at: number): string {
  let start = at;
  while (start > 0 && text[start] !== "<") start--;
  let end = at;
  let depth = 0;
  for (; end < text.length; end++) {
    const c = text[end];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) break;
  }
  return text.slice(start, end + 1);
}

/** repo-relative file → number of unfocusable horizontal scroll containers. */
function unfocusableScrollRegions(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /className="[^"]*overflow-x-(?:auto|scroll)[^"]*"/g,
    )) {
      if (/tabIndex/.test(owningTag(text, m.index!))) continue;
      const key = file.slice(SRC.length + 1);
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

/**
 * Scroll containers that are NOT defects, with the reason each was cleared.
 *
 * A scroll region only fails WCAG 2.1.1 when a keyboard user has no way to
 * scroll it. Focusable children give them one — moving focus scrolls the
 * container — so a strip of tabs or links needs no tabIndex of its own, and
 * adding one inserts a redundant stop immediately before the control the user
 * actually wants.
 */
const NOT_DEFECTS: Record<string, string> = {
  // Radix TabsTrigger children are buttons with a roving tabindex.
  "app/(dashboard)/app/sms/sms-workspace.tsx": "wraps a focusable tab list",
  // SectionNav renders anchor links.
  "app/(marketing)/security/page.tsx": "wraps in-page anchor links",
  // The compatibility scroll-spy is a strip of named in-page anchor links.
  "app/(dashboard)/app/compatibility/compatibility-detail-sections.tsx":
    "wraps focusable in-page anchor links",
  // The child iframe is focusable and capped at maxWidth: 100%, so the
  // wrapper cannot overflow in the first place.
  "components/campaigns/email-preview.tsx":
    "wraps a focusable, width-capped iframe",
  // TerminalTypeOn applies tabIndex/role/aria-label on its own scrolling div,
  // which a call-site scan cannot see.
  "app/forge/page.tsx": "scroll + focus handled inside TerminalTypeOn",
  // The responsive Forge navigation strips both contain focusable links.
  "app/forge/layout.tsx": "wraps focusable navigation links",
  "app/forge/docs/_components/sidebar-nav.tsx":
    "wraps focusable in-page anchor links",
};

describe("scrollable regions are keyboard reachable", () => {
  const found = unfocusableScrollRegions();

  it("parses scroll containers on the tag that owns them", () => {
    // Guard the guard: the div-shaped case is the one the first sweep missed,
    // and these are fixed — if the parser regressed to matching only <pre>, or
    // stopped seeing tabIndex, this catches it.
    expect(found.has("components/docs/CodeBlock.tsx")).toBe(false);
    expect(found.has("components/marketing/comparison-page.tsx")).toBe(false);
    expect(found.has("components/marketing/copyable-pre.tsx")).toBe(false);
    expect(found.has("app/(dashboard)/app/suppressions/page.tsx")).toBe(false);
  });

  it("leaves only regions cleared for a stated reason", () => {
    // This began as a ratchet over 49 unfocusable regions. All of them are
    // either fixed or explicitly cleared, so the list below is reasons, not
    // debt — and anything new fails immediately.
    const unexplained = [...found.keys()]
      .filter((file) => !(file in NOT_DEFECTS))
      .sort();
    expect(unexplained).toEqual([]);
  });

  it("keeps every stated exception real", () => {
    // An exception for a file that no longer has a scroll region is a comment
    // pretending to be a decision.
    const stale = Object.keys(NOT_DEFECTS)
      .filter((file) => !found.has(file))
      .sort();
    expect(stale).toEqual([]);
  });
});
