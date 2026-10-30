// Consistency test: the desktop's primary nav must agree with the shared
// information-architecture manifest (@postwave/nav).
//
// The 2026-06-21 ecosystem audit found web/desktop/mobile hand-rolled three
// divergent nav maps. The desktop sidebar is intentionally the RICHEST
// surface (50+ sections, many desktop-only: tags, lists, segments, commerce,
// …) so it is a SUPERSET of the manifest overall. What must hold is the
// invariant where the two overlap:
//
//   every desktop nav entry that the manifest ALSO knows about (its `id`
//   is a manifest key) must be a manifest entry the manifest marks as
//   exposed on the `desktop` surface (its desktop route is non-null).
//
// i.e. the desktop's manifest-recognized nav entries are a SUBSET of the
// manifest's desktop-exposed entries. A regression that surfaced a section
// the manifest says desktop should NOT show — or renamed an id off a
// canonical key — trips this test.
//
import { describe, expect, it } from "vitest";

import {
  NAV_ENTRIES,
  getEntry,
  navForSurface,
  routeFor,
  type NavKey,
} from "@postwave/nav";

import { ALL_DESKTOP_SECTIONS } from "../lib/desktop-routes";

function desktopNavIds(): string[] {
  return [...ALL_DESKTOP_SECTIONS];
}

const manifestKeys = new Set<string>(NAV_ENTRIES.map((e) => e.key));

describe("desktop nav ↔ @postwave/nav manifest consistency", () => {
  it("extracts a non-trivial set of desktop route ids from the desktop manifest", () => {
    const ids = desktopNavIds();
    // Sanity: the manifest actually exports the desktop sections that the
    // shell consumes for sidebar/topbar/palette metadata.
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain("dashboard");
    expect(ids).toContain("settings");
  });

  /**
   * Desktop section ids that HAPPEN to equal a manifest key while naming a
   * different feature. Each needs a stated reason, because the default reading
   * of a shared id is "same destination".
   */
  const DELIBERATE_KEY_COLLISIONS: Record<string, string> = {
    referrals:
      "Desktop `referrals` is a read-only inspection screen — program snapshot, conversion stats and a masked leaderboard — with program writes, payout reads, subscriber links and widget install all fail-closed in lib/referral-operational-availability.ts (the payout queue is never even fetched). The manifest's referrals entry is web's referral-program MANAGEMENT screen, which reads payouts and writes the program via POST /api/v1/referral-programs behind a stale-write guard. Routing the key to desktop would advertise management desktop cannot perform — the same mistake as discounts, below.",
  };

  it("a desktop section sharing a manifest key is either claimed by it or a DECLARED collision", () => {
    const recognized = desktopNavIds().filter((id) => manifestKeys.has(id));
    // The overlap must be meaningful — if it were empty the invariant would
    // be vacuously true and we'd be testing nothing.
    expect(recognized.length).toBeGreaterThan(5);

    const violations = recognized.filter(
      (id) =>
        routeFor(id as NavKey, "desktop") === null &&
        DELIBERATE_KEY_COLLISIONS[id] === undefined,
    );
    expect(
      violations,
      `desktop sections whose id is a manifest key but which the manifest does not route to desktop: ${violations.join(", ")}. Either give the entry a desktop route or declare the collision.`,
    ).toEqual([]);
  });

  it("has no STALE collision declarations", () => {
    // A declaration that no longer describes a collision excuses nothing and
    // hides the next real one behind it.
    const stale = Object.keys(DELIBERATE_KEY_COLLISIONS).filter(
      (id) =>
        !desktopNavIds().includes(id) ||
        routeFor(id as NavKey, "desktop") !== null,
    );
    expect(stale).toEqual([]);
  });

  it("every desktop nav id that is a manifest key resolves to a defined manifest entry", () => {
    const recognized = desktopNavIds().filter((id) => manifestKeys.has(id));
    for (const id of recognized) {
      expect(getEntry(id)).toBeDefined();
    }
  });

  it("the manifest's desktop-exposed entries are internally consistent (route ⇔ surface)", () => {
    // navForSurface("desktop") must return exactly the entries with a
    // non-null desktop route — the manifest's own invariant the desktop
    // relies on.
    const exposed = navForSurface("desktop").map((e) => e.key);
    const byRoute = NAV_ENTRIES.filter(
      (e) => e.routes.desktop !== null,
    ).map((e) => e.key);
    expect(exposed.sort()).toEqual(byRoute.sort());
  });
});
