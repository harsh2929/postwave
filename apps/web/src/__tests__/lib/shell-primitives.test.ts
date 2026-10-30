// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { nextMenuIndex } from "@/components/ui/header-menu";
import {
  readRecentDestinations,
  recordRecentDestination,
} from "@/lib/recent-destinations";

describe("nextMenuIndex (header-menu roving)", () => {
  it("wraps ArrowDown/ArrowUp and jumps Home/End", () => {
    expect(nextMenuIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextMenuIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextMenuIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextMenuIndex("Home", 2, 3)).toBe(0);
    expect(nextMenuIndex("End", 0, 3)).toBe(2);
  });

  it("ignores non-navigation keys and empty lists", () => {
    expect(nextMenuIndex("Enter", 1, 3)).toBeNull();
    expect(nextMenuIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("recent-destinations", () => {
  afterEach(() => window.localStorage.clear());

  it("returns most-recent-first, dedupes by href, and caps the list", () => {
    const t = "tenant_a";
    for (let i = 0; i < 10; i += 1) {
      recordRecentDestination(t, { href: `/app/x${i}`, label: `X${i}` });
    }
    const recent = readRecentDestinations(t);
    expect(recent).toHaveLength(6); // MAX_RECENT
    expect(recent[0]).toEqual({ href: "/app/x9", label: "X9" });

    // Re-visiting an existing href moves it to the front without duplicating.
    recordRecentDestination(t, { href: "/app/x5", label: "X5" });
    const after = readRecentDestinations(t);
    expect(after[0]).toEqual({ href: "/app/x5", label: "X5" });
    expect(after.filter((d) => d.href === "/app/x5")).toHaveLength(1);
  });

  it("scopes storage per tenant so recents never bleed across workspaces", () => {
    recordRecentDestination("tenant_a", { href: "/app/campaigns", label: "Campaigns" });
    expect(readRecentDestinations("tenant_b")).toEqual([]);
    expect(readRecentDestinations("tenant_a")).toHaveLength(1);
  });

  it("ignores non-/app hrefs and survives malformed storage", () => {
    recordRecentDestination("t", { href: "https://evil.example", label: "Nope" });
    expect(readRecentDestinations("t")).toEqual([]);
    window.localStorage.setItem("pw:recent-destinations:t", "{not json");
    expect(readRecentDestinations("t")).toEqual([]);
  });
});
