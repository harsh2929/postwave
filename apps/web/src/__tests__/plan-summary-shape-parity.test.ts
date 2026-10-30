// SPDX-License-Identifier: AGPL-3.0-only
//
// GET /api/v1/billing/plan-summary is modelled by hand on three surfaces.
//
// The blueprint records this as "the billing response shape is hand-modeled ×3
// (web/desktop/ops, no @postwave/billing)". The surfaces are actually web,
// desktop and MOBILE — ops does not model it — and all three agree with the Go
// struct today. That is the only moment a parity guard is free: written now it
// costs nothing, written after a divergence it is a bug report plus a migration.
//
// WHY A FIELD-PRESENCE GUARD AND NOT A TYPE ONE. Nothing generates these
// clients, and a real @postwave/billing package is a much larger change than
// this file justifies. What can be enforced cheaply is that no surface silently
// stops modelling a field the server sends — which is the drift that actually
// happens, because dropping a field breaks nothing at compile time and shows up
// only as a value that renders blank.
//
// The two optional fields matter most, and are the likeliest to be dropped:
//   - current_period_end is `omitempty`, so it is ABSENT on a tenant with no
//     billing state. A client that never modelled it looks correct in every
//     test fixture that omits it.
//   - sends_projection is the "you will exceed your plan on the 14th" warning.
//     A surface that drops it does not error; it just stops warning anybody.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const GO = resolve(REPO, "apps/api/internal/limits/plan_summary.go");

/**
 * Where each surface models the response. Mobile splits it across two modules —
 * the fetcher and a normaliser — so the surface is checked as a UNIT rather
 * than per file; asserting per file would report a false gap for a field that
 * is simply modelled in the other half.
 */
const SURFACES: ReadonlyArray<{ name: string; files: readonly string[] }> = [
  { name: "web", files: ["apps/web/src/lib/billing-types.ts"] },
  {
    name: "desktop",
    files: ["apps/desktop/src/lib/api/platform-operations.ts"],
  },
  {
    name: "mobile",
    files: [
      "apps/mobile/src/api/billing.ts",
      "apps/mobile/src/lib/billingNormalize.ts",
    ],
  },
];

/** The wire field names on limits.PlanSummary. */
function goPlanSummaryFields(): string[] {
  const src = readFileSync(GO, "utf8");
  const block = /type PlanSummary struct \{(.*?)\n\}/s.exec(src);
  if (!block?.[1]) {
    throw new Error(
      "limits.PlanSummary struct not found — the guard cannot see its subject",
    );
  }
  const fields = [...block[1].matchAll(/json:"([a-z_]+)/g)].map((m) => m[1]!);
  if (fields.length === 0) throw new Error("PlanSummary parsed to zero fields");
  return [...new Set(fields)].sort();
}

function surfaceText(files: readonly string[]): string {
  return files.map((f) => readFileSync(resolve(REPO, f), "utf8")).join("\n");
}

describe("plan-summary shape parity", () => {
  const expected = goPlanSummaryFields();

  it("the Go struct still declares the fields this guard is about", () => {
    // Guards the guard. A renamed struct or a changed json tag would make every
    // assertion below vacuous rather than failing.
    expect(expected).toEqual([
      "current_period_end",
      "resources",
      "sends_projection",
      "tier",
    ]);
  });

  it.each(SURFACES)("$name models every field the server sends", ({ files }) => {
    const text = surfaceText(files);
    const missing = expected.filter(
      (f) => !new RegExp(`\\b${f}\\b`).test(text),
    );
    expect(missing).toEqual([]);
  });

  it.each(SURFACES)("$name actually contains a plan-summary model", ({ files }) => {
    // A surface that stopped modelling the response entirely would satisfy
    // "missing === []" only if the regex also found nothing — this pins that
    // the file is really the one carrying the shape.
    expect(surfaceText(files)).toMatch(/resources/);
  });
});
