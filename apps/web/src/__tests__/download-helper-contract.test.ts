// SPDX-License-Identifier: AGPL-3.0-only
//
// Repo invariant: browser downloads go through src/lib/download.ts.
//
// Hand-rolled copies kept reappearing, and every one of them repeated the same
// two mistakes the shared helper exists to prevent:
//   * revoking the object URL synchronously in a `finally` right after
//     .click(), which races the download that has only just been dispatched;
//   * never attaching the anchor to the document, which some browsers require
//     for a programmatic click to do anything at all.
// Originally found in the now-withheld discount-redemptions export, the pilot
// sign-off markdown, the
// voice-labels JSON export, and — worst — the 2FA recovery codes, where a
// dropped download costs the operator their way back into a locked account.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const EXTS = new Set([".ts", ".tsx"]);

// The one implementation allowed to touch the anchor + object-URL dance.
const OWNERS = new Set(["src/lib/download.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.has(extname(p))) out.push(p);
  }
  return out;
}

describe("download helper contract", () => {
  it("only src/lib/download.ts builds a download anchor from an object URL", () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      if (file.includes("__tests__")) continue;
      const rel = relative(process.cwd(), file);
      if (OWNERS.has(rel)) continue;
      const src = readFileSync(file, "utf8");

      // The signature of the copied dance: the object URL is what gets put on
      // the anchor's href. Merely creating an object URL is fine — form-qr-card
      // legitimately makes one for an <img> source and downloads a data: URL —
      // so tie the check to the specific binding.
      const minted = [
        ...src.matchAll(
          /(?:const|let|var)\s+(\w+)\s*=\s*URL\.createObjectURL\s*\(/g,
        ),
      ].map((m) => m[1]!);
      const onAnchorHref = minted.some((name) =>
        new RegExp(`\\.\\s*href\\s*=\\s*${name}\\b`).test(src),
      );
      if (onAnchorHref && /\.\s*download\s*=/.test(src)) {
        offenders.push(rel);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("the shared helper defers the revoke past the click", () => {
    const src = readFileSync(join(SRC, "lib/download.ts"), "utf8");
    // Revoking in the same tick as .click() is the bug every copy had.
    expect(src).toMatch(/setTimeout\(\s*\(\)\s*=>\s*URL\.revokeObjectURL/);
    // And the anchor must be in the document when it is clicked.
    expect(src).toMatch(/document\.body\.appendChild\(/);
  });
});
