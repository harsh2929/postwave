// SPDX-License-Identifier: AGPL-3.0-only
//
// Declaring role="tablist" is a promise about the keyboard: arrows move
// between tabs, Home/End jump to the ends, and only the selected tab is in the
// page tab order. The marketing InstallTabs widget declared every ARIA role and
// implemented none of the behaviour — a screen reader announced "tab, 1 of 4"
// while the arrow keys did nothing.
//
// The arithmetic behind it was already written out three times in this app
// (dashboard nav rail, template browser tablist, design-review tablist),
// differing only in which two arrow keys each one names. Copies are why two
// other widgets ended up with none of it, so this is the shared version.
import { describe, expect, it } from "vitest";

import { nextRovingIndex } from "@/lib/roving-index";

describe("nextRovingIndex", () => {
  it("wraps in both directions", () => {
    expect(nextRovingIndex("ArrowRight", 0, 4)).toBe(1);
    expect(nextRovingIndex("ArrowRight", 3, 4)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 4)).toBe(3);
    expect(nextRovingIndex("ArrowLeft", 3, 4)).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(nextRovingIndex("Home", 2, 4)).toBe(0);
    expect(nextRovingIndex("End", 2, 4)).toBe(3);
  });

  it("uses the vertical arrows only when asked", () => {
    expect(nextRovingIndex("ArrowDown", 0, 4, "vertical")).toBe(1);
    expect(nextRovingIndex("ArrowUp", 0, 4, "vertical")).toBe(3);
    // A horizontal widget must not swallow vertical arrows — the page still
    // has to scroll while focus sits inside a tablist.
    expect(nextRovingIndex("ArrowDown", 0, 4)).toBeNull();
    expect(nextRovingIndex("ArrowUp", 0, 4)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 0, 4, "vertical")).toBeNull();
  });

  it("declines keys it does not own", () => {
    // Returning null is what lets the caller skip preventDefault, so Tab,
    // Enter and typing keep working.
    for (const key of ["Tab", "Enter", " ", "a", "Escape", "PageDown"]) {
      expect(nextRovingIndex(key, 1, 4)).toBeNull();
    }
  });

  it("survives an empty or single-item widget", () => {
    expect(nextRovingIndex("ArrowRight", 0, 0)).toBeNull();
    expect(nextRovingIndex("End", 0, 0)).toBeNull();
    expect(nextRovingIndex("ArrowRight", 0, 1)).toBe(0);
    expect(nextRovingIndex("ArrowLeft", 0, 1)).toBe(0);
  });
});

describe("InstallTabs keyboard contract", () => {
  it("keeps only the selected tab in the page tab order", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL(
          "../components/marketing/install-tabs.tsx",
          import.meta.url,
        ).pathname,
        "utf8",
      ),
    );
    // Guard the guard: the file must actually be the tablist under test.
    expect(source).toMatch(/role="tablist"/);
    expect(source).toMatch(/tabIndex=\{selected \? 0 : -1\}/);
    expect(source).toMatch(/onKeyDown=\{onTabKeyDown\}/);
  });
});
