// SPDX-License-Identifier: AGPL-3.0-only
//
// Every <nav> is a navigation landmark, and a landmark with no accessible name
// is announced as bare "navigation". Pages here routinely have two or three —
// /forge/docs has a header nav and a docs sidebar, /forge/motion-preview has
// two — so a screen-reader user jumping by landmark got "navigation,
// navigation" with nothing to choose between.
//
// The app had already settled the convention on its own: 26 labelled against
// 8 unlabelled, with distinguishing names ("Breadcrumb", "Documentation
// sidebar", "Tag jump-list") rather than the redundant "Navigation" — the role
// is already announced.
//
// Comments are stripped before matching. header-menu.tsx documents its own
// design in prose containing a literal `<nav>` landmark reference, and an
// earlier ad-hoc version of this sweep reported that file as a violation. The
// same mistake has now been made four times in this audit, which is why
// helpers/visible-code exists.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { visibleCode } from "./helpers/visible-code";

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

/** Opening <nav …> tags in visible code, with their attribute text. */
function navTags(): { file: string; attrs: string }[] {
  const out: { file: string; attrs: string }[] = [];
  for (const file of walk(SRC)) {
    const text = visibleCode(readFileSync(file, "utf8"));
    // Attributes may contain {…} expressions, so a bare [^>]* stops early on
    // the first > inside a generic or arrow function.
    for (const m of text.matchAll(/<nav\b((?:[^>{]|\{[^}]*\})*)>/g)) {
      out.push({ file: file.slice(SRC.length + 1), attrs: m[1]! });
    }
  }
  return out;
}

describe("navigation landmarks are named", () => {
  const tags = navTags();

  it("finds the navs", () => {
    // Guard the guard: a regex that stopped matching would make this vacuous,
    // and vacuous a11y sweeps read exactly like passing ones.
    expect(tags.length).toBeGreaterThan(20);
  });

  it("gives every nav an accessible name", () => {
    const unnamed = tags
      .filter((t) => !/aria-label(?:ledby)?[=\s]/.test(t.attrs))
      .map((t) => t.file);
    expect([...new Set(unnamed)].sort()).toEqual([]);
  });

  it("does not name two navs in one file the same thing", () => {
    // Two landmarks called "Documentation sidebar" on one page is the same
    // problem as two called nothing.
    const byFile = new Map<string, string[]>();
    for (const t of tags) {
      const label = /aria-label="([^"]*)"/.exec(t.attrs)?.[1];
      if (!label) continue;
      byFile.set(t.file, [...(byFile.get(t.file) ?? []), label]);
    }
    const collisions = [...byFile.entries()]
      .filter(([, labels]) => new Set(labels).size !== labels.length)
      .map(([file, labels]) => `${file}: ${labels.join(", ")}`);
    expect(collisions.sort()).toEqual([]);
  });

  it("does not pad labels with the role that is already announced", () => {
    // "Main navigation" is read as "Main navigation navigation".
    const padded = tags
      .map((t) => ({
        file: t.file,
        label: /aria-label="([^"]*)"/.exec(t.attrs)?.[1] ?? "",
      }))
      .filter((t) => /\bnavigation\b/i.test(t.label))
      .map((t) => `${t.file}: "${t.label}"`);
    expect(padded.sort()).toEqual([]);
  });
});
