// SPDX-License-Identifier: AGPL-3.0-only
//
// The web command palette's entity-aware results (Phase 4 — search parity) map
// a global-search hit to a web destination. `subscriber` deep-links precisely
// via @postwave/route-map; the other types land on the screen where that
// entity lives. We test the pure mapper (the palette itself is a thin UI shell).

import { describe, it, expect } from "vitest";

import {
  searchHitHref,
  searchHitTypeLabel,
  type GlobalSearchResult,
} from "@/lib/search-api";

const hit = (
  type: GlobalSearchResult["type"],
  id: string,
): GlobalSearchResult => ({ type, id, title: "x" });

describe("searchHitHref", () => {
  it("deep-links a subscriber to its detail page via route-map", () => {
    expect(searchHitHref(hit("subscriber", "sub_123"))).toBe(
      "/app/subscribers/sub_123",
    );
  });

  it("falls back to the subscribers list when the id is route-map-unsafe", () => {
    // route-map rejects ids with path-injection chars; never emit a broken URL.
    expect(searchHitHref(hit("subscriber", "../escape"))).toBe(
      "/app/subscribers",
    );
  });

  it("routes the non-entity types to the screen that hosts them", () => {
    expect(searchHitHref(hit("segment", "seg_1"))).toBe(
      "/app/subscribers/segments",
    );
    expect(searchHitHref(hit("suppression", "a@b.com"))).toBe(
      "/app/suppressions",
    );
    // Lists now have a dedicated detail route. Safe ids deep-link precisely;
    // rejected path-injection ids still fall back to the collection.
    expect(searchHitHref(hit("list", "list_1"))).toBe("/app/lists/list_1");
    expect(searchHitHref(hit("list", "../escape"))).toBe("/app/lists");
  });

  it("deep-links the new entity types to their detail pages (SHELL-020)", () => {
    expect(searchHitHref(hit("campaign", "cmp_1"))).toBe(
      "/app/campaigns/cmp_1",
    );
    expect(searchHitHref(hit("flow", "flow_1"))).toBe("/app/flows/flow_1");
    expect(searchHitHref(hit("template", "tpl_1"))).toBe(
      "/app/templates/tpl_1",
    );
    expect(searchHitHref(hit("form", "form_1"))).toBe("/app/forms/form_1");
  });

  it("always returns a non-empty in-app path", () => {
    for (const t of [
      "subscriber",
      "segment",
      "suppression",
      "list",
      "campaign",
      "flow",
      "template",
      "form",
    ] as const) {
      expect(searchHitHref(hit(t, "x1")).startsWith("/app/")).toBe(true);
    }
  });
});

describe("searchHitTypeLabel", () => {
  it("capitalises the type", () => {
    expect(searchHitTypeLabel("subscriber")).toBe("Subscriber");
    expect(searchHitTypeLabel("suppression")).toBe("Suppression");
  });
});
