// SPDX-License-Identifier: AGPL-3.0-only
//
// An aria-labelledby pointing at an id that is rendered twice in the same tree
// silently names the wrong element: the reference resolves to the FIRST match,
// so the second landmark announces someone else's name and its own is never
// spoken.
//
// This shipped. signup-protection/page.tsx carried two sibling
// <section aria-labelledby="sp-firewall"> each containing <h2 id="sp-firewall">,
// so "Firewall posture" was unreachable to a screen reader. 232 static ARIA
// references existed in this app and none were verified.
//
// TWO FALSE-POSITIVE CLASSES SHAPED THIS FILE, and both were found by checking
// the accusations before trusting them:
//
//   1. Branch-exclusive ids. A component with `if (isPending) return <A id="x"/>`
//      and a later `return <B id="x"/>` defines the id twice in the FILE but
//      never twice in the DOM. Five such files exist; each is declared below
//      with the specific branch structure that makes it safe.
//
//   2. Ids threaded through props. <PasswordStrengthMeter helperId="password-strength">
//      renders <p id={helperId}>, so a literal `id="password-strength"` never
//      appears in the referring file. Three auth pages looked broken and were
//      correct. The resolution rule therefore accepts any `*Id="token"` prop as
//      a definition site.
//
// A ratchet that cries wolf gets an exception list instead of a fix, so the
// rules below are deliberately narrower than "every id must be unique".
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

const ARIA_ID_ATTRS = [
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-owns",
];

/** Literal `id="value"`. */
function literalIds(text: string): string[] {
  return [...text.matchAll(/\sid="([^"{}]+)"/g)].map((m) => m[1]);
}

/**
 * Values that BECOME an id elsewhere: `helperId="x"`, `titleId="x"`, …
 *
 * Without this the checker accuses every component that hands an id down to a
 * child, which is a normal and correct pattern.
 */
function propThreadedIds(text: string): string[] {
  return [...text.matchAll(/\s\w*[Ii]d="([^"{}]+)"/g)].map((m) => m[1]);
}

function ariaReferences(text: string): { attr: string; id: string }[] {
  const out: { attr: string; id: string }[] = [];
  for (const attr of ARIA_ID_ATTRS) {
    for (const m of text.matchAll(new RegExp(`\\s${attr}="([^"{}]+)"`, "g"))) {
      for (const token of m[1].split(/\s+/).filter(Boolean)) {
        out.push({ attr, id: token });
      }
    }
  }
  return out;
}

/**
 * Files where one id is defined more than once, each occurrence in a branch
 * that excludes the others. Verified individually — the reason names the
 * structure, so a future edit that flattens the branches invalidates it
 * visibly.
 */
const BRANCH_EXCLUSIVE: Record<string, string> = {
  "app/(dashboard)/app/migrations/new/[source]/connect-step.tsx":
    '5 occurrences of "account-id", one per `source === "<platform>"` branch inside ApiKeyConnect; `source` is a single string-union value, so at most one can match.',
  "app/(dashboard)/app/forms/[id]/_list-picker.tsx":
    '2 occurrences of "target-list": an early `if (listsQuery.isError) return` renders a fallback Input, the later return renders the Select.',
  "app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel.tsx":
    '3 occurrences of "campaign-assurance", one per react-query status early-return (pending / error / loaded); it is a scroll anchor, not an ARIA target.',
  "app/(dashboard)/app/subscribers/[id]/_email-health-card.tsx":
    '2 occurrences of "email-health-title": the error fallback in EmailHealthCard, and ResolvedEmailHealth which is only reached by the exclusive success branch.',
  "components/install-prompt.tsx":
    '2 occurrences of "postwave-install-title", one per arm of the `showIOSSheet ?` ternary.',
};

const FILES = walk(SRC);

describe("ARIA id references resolve, and ids are unique per rendered tree", () => {
  it("scans a non-trivial corpus", () => {
    // Vacuity floor: a broken walk makes every rule below pass for free.
    expect(FILES.length).toBeGreaterThan(400);
    const refs = FILES.reduce(
      (n, f) => n + ariaReferences(readFileSync(f, "utf8")).length,
      0,
    );
    expect(refs).toBeGreaterThan(100);
  });

  it("would still catch the defect it was written for", () => {
    // Guard the guard. If the duplicate rule stops firing on two unconditional
    // siblings, this file is decoration.
    const shipped = `
      <section aria-labelledby="sp-firewall"><h2 id="sp-firewall">Firewall</h2></section>
      <section aria-labelledby="sp-firewall"><h2 id="sp-firewall">Firewall posture</h2></section>`;
    const ids = literalIds(shipped);
    expect(ids.filter((i) => i === "sp-firewall")).toHaveLength(2);
  });

  it("treats a prop-threaded id as a definition", () => {
    // Guard the guard, second edge: the auth pages define their target via
    // helperId=, and accusing them would be noise.
    const threaded = `<PasswordStrengthMeter helperId="password-strength" />`;
    expect(propThreadedIds(threaded)).toContain("password-strength");
    expect(literalIds(threaded)).not.toContain("password-strength");
  });

  it("defines no id twice outside a declared branch-exclusive file", () => {
    const dupes: string[] = [];
    for (const file of FILES) {
      const rel = relative(SRC, file);
      if (BRANCH_EXCLUSIVE[rel] !== undefined) continue;
      const seen = new Set<string>();
      const repeated = new Set<string>();
      for (const id of literalIds(readFileSync(file, "utf8"))) {
        if (seen.has(id)) repeated.add(id);
        seen.add(id);
      }
      for (const id of repeated) dupes.push(`${rel}: id="${id}"`);
    }
    expect(dupes.sort()).toEqual([]);
  });

  it("keeps every branch-exclusive declaration real", () => {
    // A declaration for a file that no longer duplicates anything excuses
    // nothing and hides the next real one behind it.
    const stale = Object.keys(BRANCH_EXCLUSIVE).filter((rel) => {
      const file = join(SRC, rel);
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return true; // file gone — declaration is stale
      }
      const ids = literalIds(text);
      return new Set(ids).size === ids.length; // no duplicate left
    });
    expect(stale).toEqual([]);
  });

  it("resolves every literal ARIA id reference within its own file", () => {
    const unresolved: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, "utf8");
      const defined = new Set([...literalIds(text), ...propThreadedIds(text)]);
      for (const { attr, id } of ariaReferences(text)) {
        if (!defined.has(id)) {
          unresolved.push(`${relative(SRC, file)}: ${attr}="${id}"`);
        }
      }
    }
    expect(unresolved.sort()).toEqual([]);
  });
});
