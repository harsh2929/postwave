// SPDX-License-Identifier: AGPL-3.0-only
//
// An overlay that sets `document.body.style.overflow = "hidden"` takes away
// the page's scrollbar, so it has to supply one of its own. The marketing
// mobile nav did not: the panel was `fixed inset-x-0 top-14` with no height
// cap and no overflow, holding seventeen links (thirteen product links in a
// two-column grid, three primary links, and Sign in).
//
// It fits in portrait. It does not fit in landscape — a phone turned sideways
// leaves roughly 334px under the 56px header for ~516px of content, and the
// overflow was unreachable in both directions: body scroll locked, panel not
// scrollable. "Sign in" is the last item in the panel, so it went first.
//
// The dashboard drawer already got this right (h-full aside, `flex-1
// overflow-y-auto` nav), which is what makes it an invariant rather than a
// one-off: a height constraint and a scroll region have to travel together,
// because `overflow-y-auto` on an auto-height fixed element never scrolls.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Files that take the page's scrollbar away. */
function scrollLockers(): string[] {
  return walk(SRC).filter((f) =>
    /document\.body\.style\.overflow\s*=\s*"hidden"/.test(
      readFileSync(f, "utf8"),
    ),
  );
}

/** Resolve a local import specifier to a file on disk. */
function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(from), spec)
      : null;
  if (!base) return null;
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not this extension
    }
  }
  return null;
}

/**
 * The overlay's own source plus the components it pulls in — the dashboard
 * drawer's scroll region lives in the DashboardNav it renders, not in the
 * shell that owns the scroll lock.
 */
function overlaySources(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out = [text];
  for (const m of text.matchAll(/from\s+"([^"]+)"/g)) {
    const target = resolveLocal(file, m[1]!);
    if (target) out.push(readFileSync(target, "utf8"));
  }
  return out;
}

const HEIGHT_CAP = /\b(?:max-h-|h-full|h-dvh|h-screen|flex-1)/;
const SCROLLS = /\boverflow-(?:y-)?auto\b/;

/** A className that both constrains height and scrolls. */
function hasScrollRegion(sources: string[]): boolean {
  for (const text of sources) {
    for (const m of text.matchAll(/className="([^"]*)"/g)) {
      const cls = m[1]!;
      if (SCROLLS.test(cls) && HEIGHT_CAP.test(cls)) return true;
    }
  }
  return false;
}

describe("overlays that lock body scroll", () => {
  const lockers = scrollLockers();

  it("finds the overlays", () => {
    // Guard the guard: an empty list would make the sweep vacuous, and the
    // regexes below must actually be able to fail.
    expect(lockers.length).toBeGreaterThanOrEqual(2);
    expect(hasScrollRegion(["className=\"flex-1 overflow-y-auto\""])).toBe(true);
    expect(hasScrollRegion(["className=\"overflow-y-auto\""])).toBe(false);
    expect(hasScrollRegion(["className=\"max-h-96\""])).toBe(false);
  });

  it("gives every one a scroll region of its own", () => {
    const stuck = lockers
      .filter((f) => !hasScrollRegion(overlaySources(f)))
      .map((f) => f.slice(SRC.length + 1));
    expect(stuck.sort()).toEqual([]);
  });
});
