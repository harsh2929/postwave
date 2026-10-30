/**
 * The one-mechanism rules: badges and the what's-new card read the SAME
 * registry, the same 30-day window, and the same route keys.
 *
 * The registry guard at the bottom is the part that keeps this honest over
 * time — an announcement whose route key is not a real More row would be a
 * card whose CTA goes nowhere, and no renderer test would catch it because the
 * row is looked up at press time.
 */
import { describe, expect, it } from "vitest";

import { MOBILE_SECONDARY_ROUTES } from "@/lib/mobileRouteManifest";
import { NEW_FEATURES, type NewFeatureEntry } from "@/lib/newFeatures";
import {
  DISMISSED_ANNOUNCEMENTS_CAP,
  WHATS_NEW,
  announcementSpoken,
  newFeatureKeyForRoute,
  newRouteKeys,
  parseDismissedAnnouncements,
  pickAnnouncement,
  withDismissal,
  type WhatsNewItem,
} from "@/lib/whatsNew";

const DAY_MS = 24 * 60 * 60 * 1000;

const registry: readonly NewFeatureEntry[] = [
  { key: "old", label: "Old thing", shippedAt: "2026-05-01" },
  { key: "fresh", label: "Fresh thing", shippedAt: "2026-08-01" },
  { key: "fresher", label: "Fresher thing", shippedAt: "2026-08-10" },
  { key: "same-day", label: "Same day thing", shippedAt: "2026-08-10" },
];

const items: readonly WhatsNewItem[] = [
  { featureKey: "old", routeKey: "audit", title: "Old.", ctaLabel: "Open" },
  { featureKey: "fresh", routeKey: "billing", title: "Fresh.", ctaLabel: "Open" },
  {
    featureKey: "fresher",
    routeKey: "settings",
    title: "Fresher.",
    ctaLabel: "Open",
  },
  {
    featureKey: "same-day",
    routeKey: "settings",
    title: "Same day.",
    ctaLabel: "Open",
  },
];

const NOW = Date.parse("2026-08-12");

describe("newFeatureKeyForRoute", () => {
  it("badges the row of a live feature", () => {
    expect(newFeatureKeyForRoute("billing", NOW, items, registry)).toBe("fresh");
  });

  it("does not badge a row whose only feature has expired", () => {
    expect(newFeatureKeyForRoute("audit", NOW, items, registry)).toBeNull();
  });

  it("gives a row sharing two live features ONE pill — the newest", () => {
    // Same ship date, so table position decides: "same-day" is listed later.
    expect(newFeatureKeyForRoute("settings", NOW, items, registry)).toBe(
      "same-day",
    );
  });

  it("stops badging the day after the shared window closes", () => {
    const expired = Date.parse("2026-08-10") + 31 * DAY_MS;
    expect(newFeatureKeyForRoute("settings", expired, items, registry)).toBeNull();
  });
});

describe("newRouteKeys", () => {
  it("lists each live route once, newest first", () => {
    expect(newRouteKeys(NOW, items, registry)).toEqual(["settings", "billing"]);
  });
});

describe("pickAnnouncement", () => {
  it("shows the newest live, un-dismissed card", () => {
    const picked = pickAnnouncement({
      now: NOW,
      dismissed: [],
      items,
      registry,
    });
    expect(picked?.featureKey).toBe("same-day");
  });

  it("advances to the next one when the top card is dismissed", () => {
    const picked = pickAnnouncement({
      now: NOW,
      dismissed: ["same-day", "fresher"],
      items,
      registry,
    });
    expect(picked?.featureKey).toBe("fresh");
  });

  it("shows nothing once every live card is dismissed", () => {
    expect(
      pickAnnouncement({
        now: NOW,
        dismissed: ["same-day", "fresher", "fresh"],
        items,
        registry,
      }),
    ).toBeNull();
  });

  it("never advertises a destination this role cannot reach", () => {
    const picked = pickAnnouncement({
      now: NOW,
      dismissed: [],
      canReach: (routeKey) => routeKey !== "settings",
      items,
      registry,
    });
    expect(picked?.featureKey).toBe("fresh");
  });

  it("shares the badge window: an expired feature is never announced", () => {
    const later = Date.parse("2026-08-10") + 31 * DAY_MS;
    expect(
      pickAnnouncement({ now: later, dismissed: [], items, registry }),
    ).toBeNull();
  });

  it("survives a corrupted dismissal list rather than hiding everything", () => {
    const picked = pickAnnouncement({
      now: NOW,
      dismissed: null as unknown as string[],
      items,
      registry,
    });
    expect(picked?.featureKey).toBe("same-day");
  });
});

describe("announcementSpoken", () => {
  it("names the feature from the registry, then the sentence", () => {
    expect(announcementSpoken(items[1] as WhatsNewItem, registry)).toBe(
      "What's new: Fresh thing. Fresh.",
    );
  });

  it("falls back cleanly when the registry has no label", () => {
    expect(
      announcementSpoken(
        { featureKey: "ghost", routeKey: "x", title: "Hi.", ctaLabel: "Open" },
        registry,
      ),
    ).toBe("What's new. Hi.");
  });
});

describe("withDismissal", () => {
  it("appends, and re-dismissing is a no-op rather than a duplicate", () => {
    expect(withDismissal(["a"], "b")).toEqual(["a", "b"]);
    expect(withDismissal(["a", "b"], "a")).toEqual(["b", "a"]);
  });

  it("ignores an empty key", () => {
    expect(withDismissal(["a"], "   ")).toEqual(["a"]);
  });

  it("drops the OLDEST past the cap", () => {
    const many = Array.from(
      { length: DISMISSED_ANNOUNCEMENTS_CAP },
      (_, i) => `k${i}`,
    );
    const next = withDismissal(many, "newest");
    expect(next).toHaveLength(DISMISSED_ANNOUNCEMENTS_CAP);
    expect(next[0]).toBe("k1");
    expect(next[next.length - 1]).toBe("newest");
  });
});

describe("parseDismissedAnnouncements", () => {
  it("keeps strings, drops everything else", () => {
    expect(
      parseDismissedAnnouncements(["a", 2, null, " b ", "", "a"]),
    ).toEqual(["a", "b"]);
  });

  it("reads a non-array as nothing dismissed", () => {
    expect(parseDismissedAnnouncements({ a: 1 })).toEqual([]);
    expect(parseDismissedAnnouncements(null)).toEqual([]);
  });

  it("caps a hostile record", () => {
    const huge = Array.from({ length: 500 }, (_, i) => `k${i}`);
    expect(parseDismissedAnnouncements(huge)).toHaveLength(
      DISMISSED_ANNOUNCEMENTS_CAP,
    );
  });
});

describe("the shipped table", () => {
  it("announces only features the badge registry dates", () => {
    for (const item of WHATS_NEW) {
      expect(
        NEW_FEATURES.some((entry) => entry.key === item.featureKey),
      ).toBe(true);
    }
  });

  it("lands only on More rows that exist", () => {
    const keys = new Set(MOBILE_SECONDARY_ROUTES.map((route) => route.key));
    for (const item of WHATS_NEW) {
      expect(keys.has(item.routeKey)).toBe(true);
    }
  });

  it("says something in both halves of every row", () => {
    for (const item of WHATS_NEW) {
      expect(item.title.trim()).not.toBe("");
      expect(item.ctaLabel.trim()).not.toBe("");
    }
  });
});
