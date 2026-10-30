/**
 * Guard for the referral route boundary mirrored in lib/referrals.ts.
 *
 * `MountAdminRoutes` registers three read routes and then early-returns on a
 * compile-time constant. The mobile screen is built on those three plus, while
 * the constant is true, three more behind the gate; the honesty banner is built
 * on the constant itself. If any of that moves, this test fails and says which
 * way:
 *
 *   - a read route disappears → the screen calls a 404;
 *   - the runtime OPENS       → the subscriber link, payouts and variants reads
 *                               become callable, and the "historical figures"
 *                               banner becomes a lie (which is what happened,
 *                               and why the banner is now conditional);
 *   - the runtime CLOSES again → the gated reads must stop being issued, which
 *                               is why every one of them is `enabled` on the
 *                               mirrored flag rather than on nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MOUNTED_REFERRAL_READ_ROUTES,
  REFERRAL_RUNTIME_AVAILABLE,
  RUNTIME_GATED_REFERRAL_READ_ROUTES,
} from "./referrals";

const referralsPath = fileURLToPath(
  new URL("../../../api/internal/referrals/referrals.go", import.meta.url),
);

const source = readFileSync(referralsPath, "utf8");

/** The body of `func (d *Deps) MountAdminRoutes(r chi.Router) { ... }`. */
function mountAdminBody(): string {
  const start = source.indexOf("func (d *Deps) MountAdminRoutes(r chi.Router) {");
  expect(
    start,
    "referrals.go no longer declares MountAdminRoutes with the expected signature",
  ).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
}

function routesIn(body: string): string[] {
  const out: string[] = [];
  const re = /\.(Get|Post|Put|Patch|Delete)\("([^"]+)"/g;
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    out.push(`${match[1]!.toUpperCase()} ${match[2]!}`);
    match = re.exec(body);
  }
  return out;
}

describe("referral route boundary", () => {
  const body = mountAdminBody();
  // Everything before the early return is unconditional; everything after it
  // only mounts when the runtime is open.
  const guardIndex = body.indexOf("if !OperationalRuntimeAvailable {");

  it("still gates the rest of the surface on the runtime constant", () => {
    expect(guardIndex).toBeGreaterThan(-1);
  });

  it("mirrors the runtime constant declared in Go", () => {
    expect(source).toContain("const OperationalRuntimeAvailable = ");
    const declared = /const OperationalRuntimeAvailable = (true|false)/.exec(source);
    expect(declared?.[1]).toBe(String(REFERRAL_RUNTIME_AVAILABLE));
  });

  it("mirrors the exact set of routes mounted unconditionally", () => {
    expect(routesIn(body.slice(0, guardIndex))).toEqual([
      ...MOUNTED_REFERRAL_READ_ROUTES,
    ]);
  });

  it("confirms the subscriber-link endpoint sits behind the runtime gate", () => {
    // This is the one the share sheet needs. Its position — AFTER the guard —
    // is what makes it conditional; whether it is REACHABLE is the constant
    // above, and the next test is the one that says which.
    const gated = routesIn(body.slice(guardIndex));
    expect(gated).toContain("GET /api/v1/subscribers/{id}/referral");
    expect(routesIn(body.slice(0, guardIndex))).not.toContain(
      "GET /api/v1/subscribers/{id}/referral",
    );
  });

  /**
   * THE HALF THAT WENT MISSING LAST TIME.
   *
   * The mirror above caught the gate opening, but nothing held the client to
   * what the open gate now serves: `useReferrals` grew three reads from behind
   * the guard and only prose said they were mounted. This pins the list mobile
   * calls against the Go source in both directions — a route mobile expects but
   * Go no longer registers is a 404, and a route Go registers behind the gate
   * that mobile has quietly stopped listing is how the surface fell behind the
   * server the first time.
   */
  it("mirrors the gated READ routes the client is wired to call", () => {
    const gated = routesIn(body.slice(guardIndex));
    for (const route of RUNTIME_GATED_REFERRAL_READ_ROUTES) {
      expect(gated, `${route} is no longer mounted behind the gate`).toContain(
        route,
      );
    }
    // These are reads. A write sneaking into the list would mean mobile is
    // claiming a verb it does not implement.
    for (const route of RUNTIME_GATED_REFERRAL_READ_ROUTES) {
      expect(route.startsWith("GET ")).toBe(true);
    }
  });

  it("ties the public redirect that credits conversions to the same constant", () => {
    // The basis for the screen's banner branch: with no public redirect there
    // is no new attribution and the counters cannot move, so the "historical
    // figures" copy is true exactly when this guard is closed — and that is
    // exactly when ReferralsScreen renders it.
    const publicStart = source.indexOf(
      "func (d *Deps) MountPublicRoutes(r chi.Router) {",
    );
    expect(publicStart).toBeGreaterThan(-1);
    const publicBody = source.slice(publicStart, source.indexOf("\n}", publicStart));
    expect(publicBody).toContain("if !OperationalRuntimeAvailable {");
    expect(publicBody.indexOf("if !OperationalRuntimeAvailable {")).toBeLessThan(
      publicBody.indexOf('r.Get("/api/public/r/{code}"'),
    );
    // Say out loud which world the surface is currently rendering, so a future
    // reader cannot mistake "the guard exists" for a statement about which way
    // it points. RE-CLOSED 2026-08-30: the server tree holds the release again
    // ("RELEASE REMAINS HELD…", referrals.go:46-52), so the redirect is OFF,
    // no new conversion is credited, and the historical-figures banner is true.
    expect(REFERRAL_RUNTIME_AVAILABLE).toBe(false);
  });
});
