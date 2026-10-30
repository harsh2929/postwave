/**
 * Guard for lib/discountMutationBoundary.ts.
 *
 * The constants there are a client-side mirror of a server-side mount list.
 * Mirrors rot silently — the Discounts screen shipped three affordances
 * against routes that were later unmounted, and nothing failed until an
 * operator tapped one. This test parses `MountRoutes` out of the Go source and
 * fails the build the moment the two disagree, in EITHER direction:
 *
 *   - a route disappears  → the client must stop calling it;
 *   - a route is mounted  → the client is leaving a capability on the floor,
 *                           and for DELETE specifically that capability is the
 *                           leaked-promo-code kill switch COMMERCE#11 and
 *                           MAP#24 both asked for. Build it, then flip the
 *                           constant.
 *
 * BOTH DIRECTIONS HAVE NOW FIRED. A1 (2026-08-18, commit dec6c5786) mounted
 * four routes and this test went red naming each drifted constant; the reversal
 * unmounted them again and it went red naming the same four. That is the whole
 * design: the red IS the to-do list, and neither move could be forgotten on the
 * client side.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DISCOUNT_DELETE_MOUNTED,
  DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE,
  DISCOUNT_LIVE_CHECK_MOUNTED,
  DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE,
  DISCOUNT_PATCH_MOUNTED,
  DISCOUNT_REDEMPTIONS_CSV_MOUNTED,
  MOUNTED_DISCOUNT_ROUTES,
  discountArchiveRecordId,
  discountKillSwitchAvailable,
} from "./discountMutationBoundary";

const handlersPath = fileURLToPath(
  new URL(
    "../../../api/internal/discounts/handlers.go",
    import.meta.url,
  ),
);

/** The body of `func (d *Deps) MountRoutes(r chi.Router) { ... }`. */
function mountRoutesBody(source: string): string {
  const start = source.indexOf("func (d *Deps) MountRoutes(r chi.Router) {");
  expect(
    start,
    "discounts/handlers.go no longer declares MountRoutes with the expected signature — re-read it before trusting this guard",
  ).toBeGreaterThan(-1);
  // MountRoutes contains no nested braces today; the first line that is exactly
  // "}" closes it. Assert that, so a future refactor that adds a block cannot
  // silently truncate the parse.
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  expect(end).toBeGreaterThan(0);
  return rest.slice(0, end);
}

/** `METHOD /path` for every chi registration inside a body. */
function registeredRoutes(body: string): string[] {
  const out: string[] = [];
  const re = /\.(Get|Post|Put|Patch|Delete|Head|Options)\("([^"]+)"/g;
  let match: RegExpExecArray | null = re.exec(body);
  while (match !== null) {
    out.push(`${match[1]!.toUpperCase()} ${match[2]!}`);
    match = re.exec(body);
  }
  return out;
}

describe("discount route boundary", () => {
  const source = readFileSync(handlersPath, "utf8");
  const mountBody = mountRoutesBody(source);
  const routes = registeredRoutes(mountBody);

  it("mirrors the exact set of routes MountRoutes registers", () => {
    expect(routes).toEqual([...MOUNTED_DISCOUNT_ROUTES]);
  });

  it("tracks the live-redeemability probe to whatever /check is", () => {
    const mounted = routes.includes("GET /api/v1/discounts/{code}/check");
    expect(DISCOUNT_LIVE_CHECK_MOUNTED).toBe(mounted);
  });

  it("tracks the Extend sheet to whatever PATCH {code} is", () => {
    const mounted = routes.includes("PATCH /api/v1/discounts/{code}");
    expect(DISCOUNT_PATCH_MOUNTED).toBe(mounted);
  });

  it("tracks the CSV export to whatever redemptions.csv is", () => {
    const mounted = routes.includes(
      "GET /api/v1/discounts/{code}/redemptions.csv",
    );
    expect(DISCOUNT_REDEMPTIONS_CSV_MOUNTED).toBe(mounted);
  });

  it("tracks the kill switch to whatever the server actually mounts", () => {
    const mounted = routes.includes("DELETE /api/v1/discounts/{code}");
    expect(DISCOUNT_DELETE_MOUNTED).toBe(mounted);
    expect(discountKillSwitchAvailable()).toBe(mounted);
  });

  /**
   * THE ARCHIVE IS READ-ONLY, AND THAT IS A STRONGER STATEMENT THAN THE LIST.
   *
   * The four constants above name four specific paths, so a fifth mutation
   * arriving under a name nobody predicted would slip past every one of them
   * while `MOUNTED_DISCOUNT_ROUTES` was dutifully updated to match. The Go
   * boundary test states the invariant shape rather than the membership —
   * "mutation route mounted on read-only archive" — and this is that same
   * invariant on the client side.
   */
  it("holds the archive to GET-only, whatever the paths are called", () => {
    for (const route of routes) {
      expect(
        route.startsWith("GET "),
        `${route} is a mutation on a surface this client treats as a read-only archive`,
      ).toBe(true);
    }
    expect(routes.length).toBeGreaterThan(0);
  });

  /**
   * THE PROSE IS PART OF THE MIRROR, and it has drifted in both directions.
   *
   * After A1 this module's most prominent heading still read "`MountRoutes`
   * today registers exactly two routes" directly above four constants that were
   * all `true`. After the reversal it read "registers six routes" directly above
   * four constants that were all `false`, and `useDiscountOps` still narrated
   * "since A1 it is mounted, so the flag below is `true`" above a flag that was
   * false. Each time the specific harm is a maintainer trusting the paragraph
   * over the values and re-opening — or re-closing — three working affordances.
   *
   * The cases above cannot catch that: they only compare values to Go. This one
   * reads the two files' TEXT and fails on any present-tense claim that
   * contradicts the mounted set. Both directions are listed, so whichever way
   * the boundary moves next, the sentence that stops being true fails the build.
   */
  it("does not describe the mounted set as anything other than it is", () => {
    const opsPath = fileURLToPath(
      new URL("../hooks/useDiscountOps.ts", import.meta.url),
    );
    const boundarySource = readFileSync(
      fileURLToPath(new URL("./discountMutationBoundary.ts", import.meta.url)),
      "utf8",
    );
    const opsSource = readFileSync(opsPath, "utf8");

    // Claims that a route THIS CLIENT STILL CALLS is gone. Only wrong while the
    // route is mounted, which is exactly when it misleads.
    const claimsUnmounted = [
      "registers exactly two routes",
      "registers the two catalogue GETs and nothing else",
      "it is not mounted at all",
      "no longer exist in the chi tree",
      "All three answer 404",
    ];
    // Claims that a WITHHELD route is available. This is the more dangerous
    // half: it reads as permission to wire an affordance that 404s.
    const claimsMounted = [
      "registers six routes",
      "DELETE is mounted",
      "MOUNTED since A1",
      "since A1 (2026-08-18) it is mounted",
      "and the probe runs",
      "is now true",
    ];
    const everyRouteIsMounted =
      DISCOUNT_LIVE_CHECK_MOUNTED &&
      DISCOUNT_PATCH_MOUNTED &&
      DISCOUNT_REDEMPTIONS_CSV_MOUNTED &&
      DISCOUNT_DELETE_MOUNTED;
    const stale = everyRouteIsMounted ? claimsUnmounted : claimsMounted;

    for (const claim of stale) {
      expect(
        boundarySource.includes(claim),
        `lib/discountMutationBoundary.ts claims "${claim}", but MountRoutes registers exactly ${routes.join(", ")}`,
      ).toBe(false);
      expect(
        opsSource.includes(claim),
        `hooks/useDiscountOps.ts claims "${claim}", but MountRoutes registers exactly ${routes.join(", ")}`,
      ).toBe(false);
    }
  });

  it("keeps issuance and pool inventory withheld", () => {
    // The boundary has moved twice and both times this stayed shut. Opening
    // PATCH/DELETE/check/CSV is not a reason to accept coupon ISSUANCE arriving
    // alongside them: minting provider state is the part with no reconciliation
    // story, and it is the failure this file would otherwise stop describing.
    expect(source).toContain("// Delete DELETE /api/v1/discounts/{code}");
    for (const withheld of [
      "d.Redeem)",
      "d.UpsertCouponPool)",
      "d.ImportCouponCodes)",
      "d.AssignCoupon)",
    ]) {
      expect(
        mountBody.includes(withheld),
        `${withheld} is mounted; issuance and pool inventory are still withheld`,
      ).toBe(false);
    }
  });
});

/**
 * THE IDENTITY HALF OF THE BOUNDARY.
 *
 * A mount flag says whether a route exists. It says nothing about whether this
 * client holds a value that route will accept, and that is where the divergence
 * actually bit: the one detail route that IS mounted moved from `{code}` to
 * `{record_id}` and now refuses anything but a canonical UUID. Mobile kept
 * sending codes, so the mounted route 400ed while all four flags were "correct".
 */
describe("discount archive record IDs", () => {
  const source = readFileSync(handlersPath, "utf8");

  it("addresses the detail route the way the server names it", () => {
    // Not a spelling check: this is what makes the canonicaliser below the
    // right shape of guard rather than a defensive habit. If the server ever
    // goes back to a code-addressed detail route, the UUID gate becomes wrong
    // and this fails first.
    expect(MOUNTED_DISCOUNT_ROUTES).toContain(
      "GET /api/v1/discounts/{record_id}/redemptions",
    );
    expect(source).toContain(`chi.URLParam(r, "record_id")`);
    expect(source).toContain("canonicalArchiveUUID");
  });

  it("accepts a canonical UUID and lowercases it", () => {
    expect(discountArchiveRecordId("11111111-2222-4333-8444-555555555555")).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    expect(discountArchiveRecordId("11111111-2222-4333-8444-55555555555A")).toBe(
      "11111111-2222-4333-8444-55555555555a",
    );
  });

  it("refuses a redeemable code, which is what the server refuses", () => {
    // The Go side pins the same refusal from the other direction, so this is
    // not two copies of one opinion:
    expect(source).toContain("discount record id must be a canonical UUID");
    for (const notAnId of [
      "BLACKFRIDAY",
      "SAVE20",
      "d1",
      "",
      " 11111111-2222-4333-8444-555555555555",
      "11111111-2222-4333-8444-555555555555 ",
      "11111111222243338444555555555555",
      null,
      undefined,
      42,
    ]) {
      expect(
        discountArchiveRecordId(notAnId),
        `${String(notAnId)} would have been sent into a {record_id} slot`,
      ).toBeNull();
    }
  });
});

/**
 * WHAT THE OPERATOR IS TOLD.
 *
 * Every unreachable affordance is omitted rather than disabled, which is right
 * — but omission is silence, and for these two capabilities silence is a wrong
 * answer rather than no answer. These assertions are about CONSEQUENCE: the
 * notices have to name what is unavailable and what the reader should do
 * instead, not merely be non-empty strings.
 */
describe("what the drawer says in place of an unavailable capability", () => {
  it("tells the operator the pill is derived, not confirmed", () => {
    const notice = DISCOUNT_LIVE_CHECK_UNAVAILABLE_NOTICE;
    expect(notice.detail).toMatch(/derived from the code list/i);
    expect(notice.spoken).toMatch(/may be out of date/i);
    // Only correct while the probe is unmounted. Mounting /check without
    // removing this notice would leave the drawer contradicting its own verdict.
    expect(DISCOUNT_LIVE_CHECK_MOUNTED).toBe(false);
  });

  it("tells the operator the leaked code cannot be stopped from here, and where it can", () => {
    const notice = DISCOUNT_KILL_SWITCH_UNAVAILABLE_NOTICE;
    // The consequence, named. "Not available" alone would leave the reader to
    // guess whether another Moosewave surface has it — none does.
    expect(notice.headline).toMatch(/cannot be withdrawn from Moosewave/i);
    expect(notice.detail).toMatch(/no Moosewave surface exposes it/i);
    // And the one action that actually works, so the notice is not a dead end.
    expect(notice.detail).toMatch(/Stripe/);
    expect(notice.spoken).toMatch(/Stripe/);
    expect(discountKillSwitchAvailable()).toBe(false);
  });
});
