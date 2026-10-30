import { describe, expect, it } from "vitest";

import { ENTITIES, type RouteSurface } from "./entities";
import {
  SEARCH_HIT_TYPES,
  isSearchHitType,
  searchHitDestination,
  searchHitEntity,
} from "./search";

/**
 * The conformance property: no client may silently discard a type the server
 * indexes.
 *
 * Desktop's resolver returned `null` for campaign, flow, template and form —
 * a quarter of the search index vanished from the command palette with no
 * error. The `null` fallthrough was documented as a safety valve ("a
 * server-side addition can never crash the palette"), and it did prevent
 * crashes; it also meant nobody found out that four types were never wired.
 *
 * Dropping a hit is correct in exactly one case: the surface does not ship the
 * entity at all. These tests pin that distinction.
 */

const SURFACES: RouteSurface[] = ["web", "desktop", "mobile"];

describe("search hit destinations", () => {
  it("resolves every server hit type to a real entity", () => {
    for (const type of SEARCH_HIT_TYPES) {
      const entity = searchHitEntity(type);
      expect(
        ENTITIES[entity],
        `hit type "${type}" maps to entity "${entity}", which is not in the registry`,
      ).toBeDefined();
    }
  });

  it("gives every hit type a destination on every surface that ships it", () => {
    const dropped: string[] = [];
    for (const type of SEARCH_HIT_TYPES) {
      for (const surface of SURFACES) {
        const def = ENTITIES[searchHitEntity(type)];
        const destination = searchHitDestination(type, "42", surface);
        if (def.surfaces[surface] === "none") {
          // The one legitimate drop: the surface has no such screen.
          expect(destination).toBeNull();
          continue;
        }
        if (destination === null) {
          dropped.push(`${surface}:${type}`);
          continue;
        }
        expect(destination.path.startsWith("/app/")).toBe(true);
      }
    }
    expect(
      dropped,
      "these server-indexed types resolve to nothing, so the hit is silently discarded",
    ).toEqual([]);
  });

  it("addresses the record when the surface has a detail screen", () => {
    for (const type of SEARCH_HIT_TYPES) {
      for (const surface of SURFACES) {
        const support = ENTITIES[searchHitEntity(type)].surfaces[surface];
        const destination = searchHitDestination(type, "abc-123", surface);
        if (support === "none") continue;
        expect(destination).not.toBeNull();
        expect(destination!.support).toBe(support);
        if (support === "detail") {
          expect(destination!.path).toContain("abc-123");
        } else {
          expect(destination!.path).not.toContain("abc-123");
        }
      }
    }
  });

  it("drops a hit only where the surface ships no such screen", () => {
    // The legitimate drops, named rather than inferred, so that adding a screen
    // (or losing one) shows up here as a diff instead of a silent behaviour
    // change. desktop has no flows section at all — the server still indexes
    // flow hits, and desktop is right to discard them because there is nowhere
    // to navigate to.
    const drops: string[] = [];
    for (const type of SEARCH_HIT_TYPES) {
      for (const surface of SURFACES) {
        if (searchHitDestination(type, "1", surface) === null) {
          drops.push(`${surface}:${type}`);
        }
      }
    }
    expect(drops.sort()).toEqual(["desktop:flow", "web:segment"]);
  });

  it("falls back to the collection rather than emitting a dangling path", () => {
    // An empty id would otherwise produce `/app/campaigns/`, which is a
    // different route on some routers and a 404 on others.
    const destination = searchHitDestination("campaign", "  ", "desktop");
    expect(destination).not.toBeNull();
    expect(destination!.path).toBe("/app/campaigns");
    expect(destination!.support).toBe("list");
  });



  it("rejects a type the server does not emit", () => {
    // `tag` is the concrete case: desktop's resolver had a branch for it and
    // the server has never emitted one, so the branch was dead code that read
    // like coverage.
    expect(isSearchHitType("tag")).toBe(false);
    expect(isSearchHitType("subscriber")).toBe(true);
    expect(isSearchHitType(undefined)).toBe(false);
  });
});

describe("search hit id safety", () => {
  it("refuses to put a traversal in a path", () => {
    // The rule `isSafeResourceId` already enforces for deep links and share
    // sheets. Encoding alone is not the answer here: the shared rule rejects
    // these ids outright rather than trusting every downstream router to treat
    // %2F as a literal.
    for (const bad of ["../escape", "a/b", "..", "a\\b", "with space", ""]) {
      const destination = searchHitDestination("campaign", bad, "desktop");
      expect(destination!.support, `id ${JSON.stringify(bad)}`).toBe("list");
      expect(destination!.path).toBe("/app/campaigns");
    }
  });

  it("addresses a suppression by email, which the opaque-id rule rejects", () => {
    // Suppressions are email-keyed by design — mobile ships
    // app/(tabs)/suppressions/[email].tsx. isSafeResourceId rejects every email
    // (the @ and the dot), so without an explicit exception the one surface
    // that CAN address a single suppression could never be linked to.
    const destination = searchHitDestination(
      "suppression",
      "user+tag@example.com",
      "mobile",
    );
    expect(destination!.support).toBe("detail");
    expect(destination!.path).toBe("/app/suppressions/user%2Btag%40example.com");
  });

  it("does not let an email shape smuggle a traversal", () => {
    for (const bad of ["../a@b.com", "a@b.com/../x", "a@../b.com"]) {
      const destination = searchHitDestination("suppression", bad, "mobile");
      expect(destination!.support, `id ${JSON.stringify(bad)}`).toBe("list");
    }
  });
});
