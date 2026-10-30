// SPDX-License-Identifier: AGPL-3.0-only
//
// One wire shape, one parser. Every surface's request layer must normalise API
// errors through @postwave/errors' parseErrorEnvelope.
//
// The package existed and two of three surfaces used it; mobile hand-rolled its
// own reads off the SDK error and so recovered a strict subset of the same
// bytes -- no validation `fields`, no `retryAfterSeconds`, no `details`. That
// was the HIGH item in the ecosystem blueprint's dim-7 fold, and a note in that
// doc had already declared it closed on the strength of a grep that matched
// mobile's DENIAL helper, which imports a different export. This guard checks
// the thing the note assumed: that the envelope parser itself is what each
// request layer calls.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");

/** Each surface's request layer -- the file where a thrown/failed response
 *  becomes the error object screens branch on. */
const REQUEST_LAYERS = [
  "apps/web/src/lib/api.ts",
  "apps/desktop/src/lib/api-client.ts",
  "apps/mobile/src/api/request.ts",
];

function src(rel: string): string {
  return readFileSync(resolve(REPO, rel), "utf8");
}

describe("error envelope parser parity", () => {
  it.each(REQUEST_LAYERS)("%s imports parseErrorEnvelope from @postwave/errors", (rel) => {
    const s = src(rel);
    const importsIt = /import\s*\{[^}]*\bparseErrorEnvelope\b[^}]*\}\s*from\s*"@postwave\/errors"/s.test(s);
    expect(importsIt).toBe(true);
  });

  it.each(REQUEST_LAYERS)("%s actually calls it", (rel) => {
    // An import alone can be dead; the call is the adoption.
    expect(src(rel)).toMatch(/\bparseErrorEnvelope\(/);
  });

  it("can see its subjects", () => {
    for (const rel of REQUEST_LAYERS) expect(src(rel).length).toBeGreaterThan(1000);
  });
});
