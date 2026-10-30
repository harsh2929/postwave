// SPDX-License-Identifier: AGPL-3.0-only
//
// Two keyboard defects in the docs ⌘K palette, both in the paths that make it
// a palette rather than a search box.
//
// 1. The Cmd/Ctrl+K handler bailed out whenever the event target was an input,
//    textarea, select, or contenteditable — a correct guard against stealing
//    the shortcut while someone is typing on the page. But once the dialog is
//    open, focus is in its OWN search input, which is an HTMLInputElement, so
//    the guard swallowed the keystroke and the advertised toggle could never
//    close what it had just opened. Escape worked; ⌘K, the thing on the
//    trigger's own <kbd>, did not.
//
// 2. Arrow keys moved the highlight and aria-activedescendant but nothing ever
//    scrolled. The listbox is capped at max-h-[60vh] and routinely holds more
//    than fits — 12 search hits, or 5 recent searches plus 8 popular links —
//    so past the fourth or fifth row the reader was steering a selection they
//    could no longer see, with Enter about to navigate somewhere unknown.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { POPULAR } from "@/lib/docs/popular";
import { visibleCode } from "./helpers/visible-code";

const SRC = resolve(process.cwd(), "src");
const SOURCE = readFileSync(join(SRC, "components/docs/SearchBar.tsx"), "utf8");

/** The body of the Cmd/Ctrl+K branch, comments stripped. */
function shortcutBranch(): string {
  const code = visibleCode(SOURCE);
  const start = code.indexOf('e.key.toLowerCase() === "k"');
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf('e.key === "Escape"', start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("docs ⌘K shortcut", () => {
  const branch = shortcutBranch();

  it("reads the handler", () => {
    // Guard the guard: a renamed handler would otherwise make both checks
    // below pass against an empty string.
    expect(branch).toContain("openSearch");
    expect(branch).toContain("closeSearch");
  });

  it("closes before it consults the typing guard", () => {
    // The close path has to come first, or the dialog's own input re-triggers
    // the guard that exists to protect other people's inputs.
    const closesAt = branch.indexOf("closeSearch()");
    const guardAt = branch.indexOf("HTMLInputElement");
    expect(closesAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(closesAt).toBeLessThan(guardAt);
  });

  it("still refuses to steal the shortcut while opening", () => {
    // The guard must survive — ⌘K in the sidebar filter or any page field
    // belongs to that field.
    for (const kind of [
      "isContentEditable",
      "HTMLInputElement",
      "HTMLTextAreaElement",
      "HTMLSelectElement",
    ]) {
      expect(branch).toContain(kind);
    }
    const guardAt = branch.indexOf("HTMLInputElement");
    expect(branch.indexOf("openSearch()")).toBeGreaterThan(guardAt);
  });
});

describe("docs ⌘K highlight", () => {
  it("scrolls the active option into view", () => {
    expect(SOURCE).toMatch(/getElementById\(optionId\(activeIndex\)\)/);
    // "nearest" so an option already on screen does not jump the list.
    expect(SOURCE).toMatch(/scrollIntoView\?\.\(\{ block: "nearest" \}\)/);
  });

  it("reacts to the highlight moving, not just to opening", () => {
    const at = SOURCE.indexOf("scrollIntoView");
    const deps = SOURCE.slice(at, at + 200);
    expect(deps).toMatch(/\[open, activeIndex, optionId\]/);
  });

  it("has more options than fit, which is why this matters", () => {
    // Guard the guard: if the empty state ever shrank below a screenful this
    // test would be asserting something that cannot happen.
    expect(POPULAR.length).toBeGreaterThan(5);
    expect(SOURCE).toContain("max-h-[60vh]");
  });
});
