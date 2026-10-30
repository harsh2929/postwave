import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearNavigationRecents,
  loadNavigationPreferences,
  loadNavigationRecents,
  pushNavigationRecent,
  recentDestinationSections,
  saveNavigationPreferences,
} from "../../lib/navigation-preferences";

const values = new Map<string, string>();

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  clearNavigationRecents();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("identity-scoped navigation preferences", () => {
  it("shares one ordered recent source without crossing identities", () => {
    pushNavigationRecent("workspace-a", {
      id: "nav:campaigns",
      label: "Campaigns",
      group: "Navigation",
      kind: "nav",
      section: "campaigns",
    });
    pushNavigationRecent("workspace-a", {
      id: "campaign:42",
      label: "Launch",
      group: "Campaigns",
      kind: "campaign",
      section: "campaigns",
      resourceId: "42",
    });
    pushNavigationRecent("workspace-a", {
      id: "nav:analytics",
      label: "Analytics",
      group: "Navigation",
      kind: "nav",
      section: "analytics",
    });

    expect(
      recentDestinationSections(loadNavigationRecents("workspace-a")),
    ).toEqual(["analytics", "campaigns"]);
    expect(loadNavigationRecents("workspace-b")).toEqual([]);
    const atRest = [...values.values()].join("\n");
    expect(atRest).not.toMatch(/Launch|campaign:42|resourceId|"42"/u);
    expect(atRest).toContain("nav:analytics");
  });

  it("validates favorites, domain collapse, and calm sidebar state", () => {
    saveNavigationPreferences("workspace-a", {
      favorites: ["campaigns", "audit"],
      collapsedDomains: ["growth", "connections"],
      sidebarCollapsed: true,
    });
    expect(loadNavigationPreferences("workspace-a")).toEqual({
      favorites: ["campaigns", "audit"],
      collapsedDomains: ["growth", "connections"],
      sidebarCollapsed: true,
    });

    values.set(
      "postwave.desktop.navigation.v1:workspace-b",
      JSON.stringify({
        favorites: ["campaigns", "campaigns", "not-a-section"],
        collapsedDomains: ["growth", "growth", "not-a-domain"],
        sidebarCollapsed: "yes",
      }),
    );
    expect(loadNavigationPreferences("workspace-b")).toEqual({
      favorites: ["campaigns"],
      collapsedDomains: ["growth"],
      sidebarCollapsed: false,
    });
  });

  it("rejects malformed or unbounded recent records", () => {
    values.set(
      "postwave.cmdk.recents.v1:workspace-a",
      JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        items: [
          {
            id: "nav:campaigns",
            label: "Campaigns",
            group: "Navigation",
            kind: "nav",
            section: "campaigns",
            at: Date.now(),
          },
          {
            id: "invalid-kind",
            label: "Unsafe",
            group: "Navigation",
            kind: "executable",
            at: Date.now(),
          },
          {
            id: "invalid-date",
            label: "Unsafe",
            group: "Navigation",
            kind: "nav",
            at: null,
          },
          {
            id: "x".repeat(300),
            label: "Oversized",
            group: "Navigation",
            kind: "nav",
            at: Date.now(),
          },
        ],
      }),
    );

    expect(loadNavigationRecents("workspace-a")).toEqual([
      expect.objectContaining({ id: "nav:campaigns" }),
    ]);
    expect([...values.values()].join("\n")).not.toContain("Unsafe");
  });

  it("purges legacy arrays instead of adopting their customer labels", () => {
    values.set(
      "postwave.cmdk.recents.v1:workspace-a",
      JSON.stringify([
        {
          id: "subscriber:private@example.com",
          label: "private@example.com",
          group: "Subscribers",
          kind: "subscriber",
          section: "subscribers",
          resourceId: "private@example.com",
          at: Date.now(),
        },
      ]),
    );

    expect(loadNavigationRecents("workspace-a")).toEqual([]);
    expect([...values.values()].join("\n")).not.toContain("example.com");
  });

  it("expires durable product recents and removes their stale record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    pushNavigationRecent("workspace-a", {
      id: "nav:campaigns",
      label: "Campaigns",
      group: "Navigation",
      kind: "nav",
      section: "campaigns",
    });

    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000 + 1);

    expect(loadNavigationRecents("workspace-a")).toEqual([]);
    expect(values.has("postwave.cmdk.recents.v1:workspace-a")).toBe(false);
  });
});

describe("recent kind vocabulary", () => {
  // `NavigationRecentKind` gained "flow" with a comment explaining the point:
  // the vocabulary should cover what a palette item CAN be, so that shipping a
  // flows section later does not mean chasing a type error through the store.
  //
  // The runtime allow-list did not gain it. `new Set<NavigationRecentKind>([…])`
  // accepts a SUBSET without complaint, so the two drifted with nothing failing.
  // The effect is worse than the type error the comment set out to avoid: a
  // flow recent is rejected at push time and simply never appears, which reads
  // as a broken recents store rather than as a missing enum entry.
  it("accepts every kind the type permits, including flow", () => {
    pushNavigationRecent("workspace-a", {
      id: "flow:welcome",
      label: "Welcome series",
      group: "Flows",
      kind: "flow",
    });

    const recents = loadNavigationRecents("workspace-a");

    expect(recents.map((recent) => recent.id)).toContain("flow:welcome");
    expect(recents.find((recent) => recent.id === "flow:welcome")?.kind).toBe(
      "flow",
    );
  });
});
