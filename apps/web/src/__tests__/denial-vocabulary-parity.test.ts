// SPDX-License-Identifier: AGPL-3.0-only
//
// The denial vocabulary is declared twice — `entitlement.Reason` in Go, and
// `DENIAL_REASONS` in @postwave/errors for web, desktop and mobile. The TS
// package states the rule itself:
//
//   "The closed reason vocabulary, mirroring `entitlement.Reason` (denial.go).
//    A new value is a client-visible contract change on BOTH sides."
//
// Nothing enforced it. The drift is asymmetric and quiet in each direction:
//
//   * A reason the SERVER adds and clients don't know falls through
//     parseDenial's validation. Every client shows its generic fallback for a
//     refusal the product has a specific, actionable explanation for — the
//     user is told "something went wrong" when the truth was "your plan does
//     not include this".
//
//   * A reason CLIENTS list and the server never sends is dead branch and dead
//     copy: guidance written, translated, and maintained for a state that
//     cannot occur.
//
// The remedies are the sharper half. REMEDY_UPGRADE_PLAN is deliberately
// withheld by the server on the top tier — "a client must never re-derive it"
// — so a client that invents the remedy instead of reading it tells a customer
// already on the highest plan to upgrade.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DENIAL_REASONS, isDenialReason } from "@postwave/errors";

const GO = readFileSync(
  resolve(process.cwd(), "../../apps/api/internal/entitlement/denial.go"),
  "utf8",
);


const ERRORS_SRC = readFileSync(
  resolve(process.cwd(), "../../packages/errors/src/index.ts"),
  "utf8",
);

/** The DENIAL_REASONS literal as written in TypeScript source. */
function declaredReasons(source: string): string[] {
  const m = /DENIAL_REASONS\s*=\s*\[([^\]]*)\]/.exec(source);
  expect(m, "DENIAL_REASONS literal not found in source").not.toBeNull();
  return [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!);
}

/** Every `ReasonX Reason = "value"` the gateway can emit. */
function goReasons(): string[] {
  return [...GO.matchAll(/Reason\w+\s+Reason\s*=\s*"([a-z_]+)"/g)].map(
    (m) => m[1]!,
  );
}

describe("denial reason vocabulary matches the gateway", () => {
  it("reads the Go source", () => {
    // Guard the guard: a moved file would otherwise make every comparison
    // vacuously true rather than failing.
    expect(GO).toContain("package entitlement");
    expect(goReasons().length).toBeGreaterThan(3);
  });

  it("lists exactly the reasons the server can send", () => {
    // Set equality both ways — a missing reason and an invented one are
    // different bugs and both matter.
    expect([...DENIAL_REASONS].sort()).toEqual(goReasons().sort());
  });

  it("checks the SOURCE list, not only the built package", () => {
    // @postwave/errors resolves to dist/index.js, so importing DENIAL_REASONS
    // validates the compiled artifact. A source-only edit — the normal way a
    // reason gets added — would not be seen until someone rebuilt, and the
    // guard would report parity against a package that no longer matches its
    // own source.
    const srcReasons = declaredReasons(ERRORS_SRC);
    expect(srcReasons.length).toBeGreaterThan(3);
    expect(srcReasons.sort()).toEqual(goReasons().sort());
  });

  it("keeps the built package in step with its source", () => {
    // A stale dist means the app ships a vocabulary the source disagrees with,
    // which is invisible to both of the checks above taken alone.
    expect(declaredReasons(ERRORS_SRC).sort()).toEqual(
      [...DENIAL_REASONS].sort(),
    );
  });

  it("accepts every server reason through the type guard", () => {
    // parseDenial narrows through isDenialReason; a reason that fails it is
    // downgraded to the generic fallback at runtime.
    const rejected = goReasons().filter((r) => !isDenialReason(r));
    expect(rejected).toEqual([]);
  });

  it("rejects values outside the closed vocabulary", () => {
    for (const bogus of ["", "PLAN", "billing", "unknown", null, 42]) {
      expect(isDenialReason(bogus as unknown), String(bogus)).toBe(false);
    }
  });

  it("keeps the remedy constants byte-identical to the server's", () => {
    // The server decides whether a remedy applies — notably withholding
    // upgrade_plan on the top tier. A client that spells it differently
    // silently stops matching the server's own value.
    const remedies = [...GO.matchAll(/Remedy\w+\s*=\s*"([a-z_]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(remedies).toContain("upgrade_plan");
    expect(remedies).toContain("contact_workspace_admin");

    const ts = readFileSync(
      resolve(process.cwd(), "../../packages/errors/src/index.ts"),
      "utf8",
    );
    for (const remedy of remedies) {
      expect(ts, `@postwave/errors does not know remedy ${remedy}`).toContain(
        `"${remedy}"`,
      );
    }
  });

  it("does not re-derive a remedy the server withheld", () => {
    // denial.go drops RemedyUpgradePlan at the top tier on purpose. If a
    // client computed it from `reason === "plan"` instead of reading the
    // field, a customer on the highest plan would be told to upgrade.
    expect(GO).toMatch(/d\.Remedy == RemedyUpgradePlan && d\.Tier == topTier/);
    const ts = readFileSync(
      resolve(process.cwd(), "../../packages/errors/src/index.ts"),
      "utf8",
    );
    expect(ts).not.toMatch(/reason === "plan"[\s\S]{0,80}REMEDY_UPGRADE_PLAN/);
  });
});
