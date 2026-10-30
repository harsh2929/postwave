/**
 * Guard for the private podcast feed boundary (lib/privateFeedBoundary.ts).
 *
 * This surface is unusual: nothing is broken, so nothing fails on its own. The
 * phone withholds three working routes because the platform holds them, and
 * the ONLY thing keeping that honest is that the copy still matches the source
 * it was quoted from. So this file holds the mirror in three directions:
 *
 *  - against apps/desktop — the flag, the reason, the heading, the checklist
 *    and the closing note are quoted, not paraphrased. If desktop rewords the
 *    hold, mobile says something desktop no longer says, and this goes red.
 *  - against apps/api's routeauth manifest — the routes really are mounted, at
 *    the roles claimed. If one disappears, "held by product decision" stops
 *    being the true reason and the copy has to change.
 *  - against the day the gate OPENS — the flag flipping true is the moment
 *    every sentence here becomes false and mobile owes the operator either the
 *    verbs or a new reason. That must never pass quietly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PRIVATE_PODCAST_FEEDS_AVAILABLE,
  PRIVATE_PODCAST_GATE_TITLE,
  PRIVATE_PODCAST_MOBILE_NOTE,
  PRIVATE_PODCAST_NO_CHANGE_NOTE,
  PRIVATE_PODCAST_RELEASE_CHECKLIST,
  PRIVATE_PODCAST_TOKEN_ROUTES,
  PRIVATE_PODCAST_UNAVAILABLE_REASON,
  privateFeedGateVisible,
} from "./privateFeedBoundary";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const availability = read(
  "../../../desktop/src/lib/archive-operational-availability.ts",
);
const archivePage = read(
  "../../../desktop/src/components/archive/ArchivePageContent.tsx",
);
const podcastGo = read("../../../api/internal/podcast/podcast.go");
const manifest = JSON.parse(
  read("../../../api/internal/routeauth/manifest.json"),
) as { routes: { method: string; path: string; session_minimum_role: string }[] };

describe("desktop mirror", () => {
  it("holds the same flag desktop holds", () => {
    const declared = availability.match(
      /export const ARCHIVE_PRIVATE_PODCAST_AVAILABLE = (true|false);/,
    );
    expect(declared?.[1], "desktop no longer declares the flag").toBeDefined();
    expect(PRIVATE_PODCAST_FEEDS_AVAILABLE).toBe(declared![1] === "true");
  });

  it("quotes desktop's reason rather than paraphrasing it", () => {
    expect(availability).toContain(`"${PRIVATE_PODCAST_UNAVAILABLE_REASON}"`);
  });

  it("quotes desktop's heading and closing note", () => {
    // Prettier wraps JSX prose across lines, so compare on collapsed
    // whitespace — the words have to match, the line breaks need not.
    const flattened = archivePage.replace(/\s+/g, " ");
    expect(flattened).toContain(PRIVATE_PODCAST_GATE_TITLE);
    expect(flattened).toContain(PRIVATE_PODCAST_NO_CHANGE_NOTE);
  });

  it("lists exactly desktop's release checklist for this boundary", () => {
    for (const item of PRIVATE_PODCAST_RELEASE_CHECKLIST) {
      expect(archivePage, item).toContain(`<li>${item}</li>`);
    }
    expect(PRIVATE_PODCAST_RELEASE_CHECKLIST).toHaveLength(3);
  });

  it("says the hold is cross-platform, which is the fact desktop proves", () => {
    expect(PRIVATE_PODCAST_MOBILE_NOTE).toContain("desktop");
    expect(archivePage).toContain("ARCHIVE_PRIVATE_PODCAST_AVAILABLE");
  });
});

describe("server mirror", () => {
  it("names three routes the API really mounts", () => {
    for (const route of PRIVATE_PODCAST_TOKEN_ROUTES) {
      const mounted = manifest.routes.find(
        (entry) => entry.method === route.method && entry.path === route.path,
      );
      expect(mounted, `${route.method} ${route.path}`).toBeDefined();
      expect(mounted?.session_minimum_role).toBe(route.minimumRole);
    }
  });

  it("covers every token verb podcast.go registers, and no other", () => {
    const body = podcastGo.slice(
      podcastGo.indexOf("func (d *Deps) MountAdminRoutes(r chi.Router) {"),
    );
    const registered = Array.from(
      body.slice(0, body.indexOf("\n}")).matchAll(/admin\.(\w+)\("([^"]+)"/g),
      (match) => `${match[1]!.toUpperCase()} ${match[2]!}`,
    ).sort();
    expect(registered).toEqual(
      PRIVATE_PODCAST_TOKEN_ROUTES.map(
        (route) => `${route.method} ${route.path}`,
      ).sort(),
    );
  });

  it("still returns the plaintext secret on read, which is the first held item", () => {
    // The checklist's first line is "Issued tokens must never be recoverable
    // after reveal." AdminGetToken re-issues it. If this ever stops being
    // true, the hold has lost one of its reasons and should be re-argued.
    const getToken = podcastGo.slice(
      podcastGo.indexOf("func (d *Deps) AdminGetToken("),
    );
    expect(getToken.slice(0, getToken.indexOf("\n}"))).toContain(
      "tok.FeedURL = d.feedURLForToken(t.Slug, tok.Secret)",
    );
    expect(PRIVATE_PODCAST_RELEASE_CHECKLIST[0]).toBe(
      "Issued tokens must never be recoverable after reveal.",
    );
  });
});

describe("privateFeedGateVisible", () => {
  it("withholds the disclosure from a session that could not act on it", () => {
    expect(privateFeedGateVisible({ canAdmin: false })).toBe(false);
  });

  it("states the hold to an admin while the gate is closed", () => {
    expect(privateFeedGateVisible({ canAdmin: true })).toBe(
      !PRIVATE_PODCAST_FEEDS_AVAILABLE,
    );
    expect(privateFeedGateVisible({ canAdmin: true })).toBe(true);
  });

  it("goes red the day the platform opens the gate", () => {
    // NOT a restatement of the mirror test above: that one asks whether the
    // two platforms agree, this one asks whether the ANSWER mobile ships is
    // still the answer this code was written for. When it flips, mobile owes
    // the operator mint / rotate / revoke, or a different true sentence — the
    // disclosure alone would then be stale copy about a lifted hold.
    expect(PRIVATE_PODCAST_FEEDS_AVAILABLE).toBe(false);
  });
});
