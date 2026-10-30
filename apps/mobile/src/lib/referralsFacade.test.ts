/**
 * Guard for the lib/referrals.ts facade.
 *
 * `referrals.ts` was one file until the payouts, variants and per-subscriber
 * link reads pushed it past the source ceiling; it is now three siblings
 * (Boundary / Wire / Copy) re-exported from the original path so that hooks,
 * components and both other test files keep importing `@/lib/referrals`.
 *
 * Two ways that arrangement can rot silently, both checked here:
 *
 *   - a name added to a sibling but never reaching the facade, because someone
 *     replaced the `export *` with an explicit list and missed one. The
 *     consumer then fails at its own import, far from the cause.
 *   - two siblings exporting the SAME name. `export *` drops an ambiguous name
 *     from the re-export entirely rather than erroring, so the surface would
 *     lose an export that both halves still appear to provide.
 */
import { describe, expect, it } from "vitest";

import * as facade from "./referrals";
import * as boundary from "./referralsBoundary";
import * as copy from "./referralsCopy";
import * as wire from "./referralsWire";

// Indexed through Record views rather than the namespace objects directly:
// `import/namespace` cannot validate a computed member access on a namespace
// import, and the whole point of this guard is that the keys are discovered at
// runtime rather than spelled out.
const siblings: Record<string, Record<string, unknown>> = {
  boundary: boundary as unknown as Record<string, unknown>,
  copy: copy as unknown as Record<string, unknown>,
  wire: wire as unknown as Record<string, unknown>,
};
const facadeExports = facade as unknown as Record<string, unknown>;

describe("the lib/referrals facade", () => {
  it("re-exports every value each sibling provides", () => {
    for (const [name, module] of Object.entries(siblings)) {
      for (const key of Object.keys(module)) {
        expect(
          Object.hasOwn(facade, key),
          `referrals.ts does not re-export ${key} from referrals${name}`,
        ).toBe(true);
        expect(facadeExports[key]).toBe(module[key]);
      }
    }
  });

  it("gives the siblings disjoint names, so no export is dropped as ambiguous", () => {
    const seen = new Map<string, string>();
    for (const [name, module] of Object.entries(siblings)) {
      for (const key of Object.keys(module)) {
        expect(
          seen.get(key),
          `${key} is exported by both referrals${seen.get(key)} and referrals${name}`,
        ).toBeUndefined();
        seen.set(key, name);
      }
    }
  });

  it("adds nothing of its own — it is a re-export and not a fourth module", () => {
    const fromSiblings = new Set(
      Object.values(siblings).flatMap((module) => Object.keys(module)),
    );
    expect(
      Object.keys(facade).filter((key) => !fromSiblings.has(key)),
    ).toEqual([]);
  });
});
