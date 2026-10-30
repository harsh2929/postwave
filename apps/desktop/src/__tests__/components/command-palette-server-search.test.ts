/**
 * Tests for the CommandPalette's server-side search helpers (#59) —
 * the pure mapping from /api/v1/search hits onto palette navigation
 * targets, the dedupe key scheme, and the prefix-visibility rules.
 *
 * command-palette-helpers.ts is React/DOM-free (type-only imports),
 * so no stubbing is needed in the node environment.
 */
import { SEARCH_HIT_TYPES } from "@postwave/route-map";

import type { GlobalSearchResult } from "../../lib/api-client";
import { describe, expect, it } from "vitest";

import {
  serverHitToTarget,
  serverHitVisible,
} from "../../components/command-palette-helpers";

describe("serverHitToTarget", () => {
  it("maps list hits to the lists section with a pending target", () => {
    const t = serverHitToTarget({ type: "list", id: "7", title: "VIPs" });
    expect(t).toEqual({
      itemId: "list:7",
      aliasIds: [],
      kind: "list",
      section: "lists",
      targetId: "7",
      group: "Lists",
    });
  });

  it("ignores a type the server does not emit", () => {
    // This test used to assert that a `tag` hit mapped to the tags section.
    // internal/search/index.go collects list, segment, suppression, subscriber,
    // campaign, flow, template and form — never tag. So the branch it covered
    // could not run, and the test made the dead code look exercised.
    // check-route-map-destinations.mjs now fails on exactly this drift.
    expect(
      serverHitToTarget({ type: "tag", id: "t1", title: "beta" } as never),
    ).toBeNull();
  });

  it("maps campaign hits, which used to be dropped entirely", () => {
    const t = serverHitToTarget({
      type: "campaign",
      id: "c1",
      title: "Launch",
    } as never);
    expect(t?.section).toBe("campaigns");
    expect(t?.targetId).toBe("c1");
    expect(t?.itemId).toBe("campaign:c1");
    expect(t?.group).toBe("Campaigns");
  });

  it("subscriber hits prefer the email as deep-link target and carry an email-keyed alias", () => {
    const t = serverHitToTarget({
      type: "subscriber",
      id: "sub-9",
      title: "ada@example.com",
    });
    expect(t?.section).toBe("subscribers");
    expect(t?.targetId).toBe("ada@example.com");
    // Dedupe alias matches the per-type fetch's `subscriber:<email>` key.
    expect(t?.aliasIds).toContain("subscriber:ada@example.com");
  });

  it("subscriber hits without an email-looking title fall back to the id", () => {
    const t = serverHitToTarget({
      type: "subscriber",
      id: "sub-9",
      title: "Ada Lovelace",
    });
    expect(t?.targetId).toBe("sub-9");
  });

  it("segment and suppression hits carry a pending target", () => {
    const seg = serverHitToTarget({ type: "segment", id: "s1", title: "Churn risk" });
    expect(seg?.section).toBe("segments");
    expect(seg?.targetId).toBe("s1");

    const sup = serverHitToTarget({
      type: "suppression",
      id: "x1",
      title: "bounce@example.com",
    });
    expect(sup?.section).toBe("suppressions");
    expect(sup?.targetId).toBe("bounce@example.com");
  });

  it("suppression hits without an email-looking title fall back to the id", () => {
    const sup = serverHitToTarget({
      type: "suppression",
      id: "x1",
      title: "Manual suppression",
    });
    expect(sup?.targetId).toBe("x1");
  });

  it("drops unknown hit types instead of crashing", () => {
    expect(
      serverHitToTarget({ type: "warehouse", id: "1", title: "??" }),
    ).toBeNull();
  });

  it("itemId scheme matches the per-type fetch ids so dedupe by id works", () => {
    // CommandPalette keys per-type entity items as `<kind>:<id>` —
    // the server hits must collide on exactly those strings.
    expect(
      serverHitToTarget({ type: "list", id: "5", title: "x" })?.itemId,
    ).toBe("list:5");
    // The `tag` case that stood here asserted an id scheme for a type the
    // server never emits. Replaced with one the server does emit, and which
    // the old `default: return null` used to drop.
    expect(
      serverHitToTarget({ type: "form", id: "9", title: "x" } as never)?.itemId,
    ).toBe("form:9");
  });
});

describe("serverHitVisible — prefix routing", () => {
  const FULL = new Set([
    "subscribers",
    "campaigns",
    "lists",
    "forms",
    "templates",
    "tags",
    "actions",
    "nav",
  ]);
  const AT = new Set(["subscribers"]); // "@" prefix
  const HASH = new Set(["lists", "tags"]); // "#" prefix
  const NAV = new Set(["nav"]); // "/" prefix

  it("subscriber hits show for unprefixed and @ searches only", () => {
    expect(serverHitVisible("subscriber", FULL)).toBe(true);
    expect(serverHitVisible("subscriber", AT)).toBe(true);
    expect(serverHitVisible("subscriber", HASH)).toBe(false);
    expect(serverHitVisible("subscriber", NAV)).toBe(false);
  });

  it("list / segment hits show for unprefixed and # searches", () => {
    // `tag` was in this loop and in the ServerHitKind union, but the server has
    // never emitted a tag hit (internal/search/index.go collects eight types and
    // tag is not one). The branch and this assertion certified each other while
    // covering nothing.
    for (const kind of ["list", "segment"] as const) {
      expect(serverHitVisible(kind, FULL)).toBe(true);
      expect(serverHitVisible(kind, HASH)).toBe(true);
      expect(serverHitVisible(kind, AT)).toBe(false);
      expect(serverHitVisible(kind, NAV)).toBe(false);
    }
  });

  it("suppression hits show only on the unprefixed full search", () => {
    expect(serverHitVisible("suppression", FULL)).toBe(true);
    expect(serverHitVisible("suppression", AT)).toBe(false);
    expect(serverHitVisible("suppression", HASH)).toBe(false);
    expect(serverHitVisible("suppression", NAV)).toBe(false);
  });
});


describe("every server-indexed type reaches the palette", () => {
  // The regression this file previously could not catch. serverHitToTarget's
  // `default: return null` dropped campaign, flow, template and form — a
  // quarter of the search index — and the palette showed nothing, with no
  // error. A drop is legitimate for exactly one type, and only because desktop
  // ships no flows section.
  it("maps every type except the one desktop has no screen for", () => {
    const dropped: string[] = [];
    for (const type of SEARCH_HIT_TYPES) {
      const target = serverHitToTarget({
        type,
        id: "42",
        title: "Example",
      } as GlobalSearchResult);
      if (target === null) dropped.push(type);
    }
    expect(dropped).toEqual(["flow"]);
  });

  it("routes each mapped type to its own section", () => {
    const sections = SEARCH_HIT_TYPES.map((type) => {
      const target = serverHitToTarget({
        type,
        id: "42",
        title: "Example",
      } as GlobalSearchResult);
      return [type, target?.section ?? null];
    });
    expect(Object.fromEntries(sections)).toEqual({
      list: "lists",
      segment: "segments",
      suppression: "suppressions",
      subscriber: "subscribers",
      campaign: "campaigns",
      flow: null,
      template: "templates",
      form: "forms",
    });
  });
});
