/**
 * The export budget must measure the bundle the app actually ships.
 *
 * `scripts/build-verification-export.mjs` builds its own `cleanEnv` and that
 * env feeds ONLY the CI verification export. The STORE artifact comes from
 * `eas build --profile production`, which reads `eas.json`. Anything that
 * changes bundling — graph optimisation, tree shaking — set in one place and
 * not the other makes the gate a number about a build nobody ships: CI would
 * measure a smaller bundle than users download, or refuse a bundle that is
 * fine.
 *
 * This pins the two together. It is deliberately about PARITY, not about the
 * flags being on: turning them off is a legitimate decision, but turning them
 * off in one place only is not.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP_ROOT = join(__dirname, "..", "..");

/** Env keys that change what the bundler emits. */
const BUNDLING_KEYS = [
  "EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH",
  "EXPO_UNSTABLE_TREE_SHAKING",
] as const;

function verificationEnv(): Record<string, string> {
  const src = readFileSync(
    join(APP_ROOT, "scripts/build-verification-export.mjs"),
    "utf8",
  );
  const out: Record<string, string> = {};
  for (const key of BUNDLING_KEYS) {
    const match = new RegExp(`${key}:\\s*"([^"]*)"`, "u").exec(src);
    if (match?.[1] !== undefined) out[key] = match[1];
  }
  return out;
}

function easEnv(profile: string): Record<string, string> {
  const eas = JSON.parse(
    readFileSync(join(APP_ROOT, "eas.json"), "utf8"),
  ) as { build: Record<string, { env?: Record<string, string> }> };
  return eas.build[profile]?.env ?? {};
}

describe("bundling flags agree between CI and the store build", () => {
  it("finds both configuration sources", () => {
    // Vacuity floor: a renamed script or profile would make the comparisons
    // below trivially true.
    expect(Object.keys(easEnv("production")).length).toBeGreaterThan(0);
    expect(
      readFileSync(
        join(APP_ROOT, "scripts/build-verification-export.mjs"),
        "utf8",
      ),
    ).toContain("cleanEnv");
  });

  for (const profile of ["production", "preview"]) {
    it(`matches the ${profile} profile`, () => {
      const eas = easEnv(profile);
      const ci = verificationEnv();
      for (const key of BUNDLING_KEYS) {
        expect(
          ci[key] ?? null,
          `${key}: eas.json ${profile}=${eas[key] ?? "unset"}, verification export=${ci[key] ?? "unset"}`,
        ).toBe(eas[key] ?? null);
      }
    });
  }
});
