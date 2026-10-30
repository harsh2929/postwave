// The tour's analytics identity must be shared, not re-declared per surface.
//
// Mobile emitted "mobile_dashboard" and desktop "dashboard", so the same tour
// arrived in analytics as two funnels that could not be compared or summed. The
// surface distinction it was encoding already existed: every onboarding event
// carries a `platform` field, so the id was duplicating a dimension and
// destroying comparability to do it.
//
// This guards the shape of the fix rather than the string. A surface that goes
// back to writing its own literal is the regression -- whatever literal it
// picks -- so the assertion is "no surface hardcodes a tour id", not "the id is
// still 'dashboard'". The latter would pass happily while mobile re-added
// `tourId: "mobile_v2"` beside it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DASHBOARD_TOUR_ID } from "./tour.js";

const REPO = resolve(__dirname, "../../..");

/** Surfaces that emit onboarding tour analytics. */
const EMITTERS = [
  "apps/mobile/src/components/tour/TourProvider.tsx",
  "apps/desktop/src/lib/onboarding-state-machine.ts",
];

describe("tour id is one shared constant", () => {
  it("is not the empty string", () => {
    expect(DASHBOARD_TOUR_ID).toBeTruthy();
  });

  it.each(EMITTERS)("%s assigns tourId from the shared constant", (rel) => {
    const src = readFileSync(resolve(REPO, rel), "utf8");
    // Every `tourId:` assignment must reference an identifier, never a literal.
    const literals = [...src.matchAll(/tourId:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(literals).toEqual([]);
  });

  it.each(EMITTERS)("%s actually assigns tourId somewhere", (rel) => {
    // Guards the guard: a file that stopped emitting tour analytics entirely
    // would satisfy the assertion above vacuously.
    const src = readFileSync(resolve(REPO, rel), "utf8");
    expect(src).toMatch(/tourId:\s*[A-Za-z_$]/);
  });

  it("no surface re-declares a dashboard tour id of its own", () => {
    const offenders: string[] = [];
    for (const rel of EMITTERS) {
      // Comment lines are excluded. The fix for this very divergence quotes
      // the old literal to explain it, and a guard that flags the explanation
      // of a deletion reports the opposite of the truth.
      const src = readFileSync(resolve(REPO, rel), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      // [a-z0-9_]*, not [a-z_]*. The first version could not see
      // "mobile_dashboard_v2" -- the digits fell outside the class -- so
      // mutation-testing the guard passed while a surface re-declared its own
      // id. A guard with a hole shaped like the bug it guards is worse than
      // none, because it reads as coverage.
      for (const m of src.matchAll(/"([a-z0-9_]*dashboard[a-z0-9_]*)"/g)) {
        // The shared value itself may legitimately appear in a comment.
        if (m[1] !== DASHBOARD_TOUR_ID) offenders.push(`${rel}: "${m[1]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
