// SPDX-License-Identifier: AGPL-3.0-only
//
// role="region" and role="group" both exist to give a chunk of content a name.
// An unnamed one is worse than no role at all: it adds a stop to the landmark
// and rotor lists that announces nothing useful, and for role="region" the
// ARIA spec says an unnamed region should not be exposed as a landmark, so the
// markup and the behaviour disagree.
//
// This exists because I added seven of these in one pass and got one wrong —
// the Common-errors table on every migration guide was named "What migrates",
// which is a different section on the same page and is not even a table. A
// wrong name is not detectable by any sweep; a *missing* name is, and missing
// names are the more common failure. So this pins the checkable half.
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

/** The JSX opening tag that carries the attribute at `at`. */
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

describe("region and group roles carry names", () => {
  const tagged: { file: string; tag: string }[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/role="(?:region|group)"/g)) {
      tagged.push({ file: file.slice(SRC.length + 1), tag: owningTag(text, m.index!) });
    }
  }

  it("finds the roles to check", () => {
    // Guard the guard: the owning-tag parser must actually be resolving tags,
    // not returning fragments — every one of these has a className too.
    expect(tagged.length).toBeGreaterThan(5);
    expect(tagged.every((t) => t.tag.includes("className"))).toBe(true);
  });

  it("names every one", () => {
    const unnamed = tagged
      .filter(({ tag }) => !/aria-label(?:ledby)?=/.test(tag))
      .map(({ file }) => file);
    expect([...new Set(unnamed)].sort()).toEqual([]);
  });

  it("uses no empty or placeholder name", () => {
    // aria-label="" is the same as no name, and passes the check above.
    const empty = tagged
      .filter(({ tag }) => /aria-label=(?:""|\{""\}|\{`\`\})/.test(tag))
      .map(({ file }) => file);
    expect([...new Set(empty)].sort()).toEqual([]);
  });
});
