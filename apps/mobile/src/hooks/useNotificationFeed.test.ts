import { describe, expect, it, vi } from "vitest";

// The hooks themselves need a React renderer; the exported pure helpers (the
// badge contract) are what actually encode product rules, so those are tested
// here. react-native is unreachable from this module's pure exports.
vi.mock("@/api/notifications", () => ({
  fetchNotificationFeed: vi.fn(),
}));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));

const {
  NOTIFICATION_BADGE_CAP,
  NOTIFICATION_FEED_ROOT,
  badgeAccessibilityLabel,
  badgeLabel,
  badgeSpokenCount,
  notificationFeedKey,
} = await import("./useNotificationFeed");

describe("notificationFeedKey", () => {
  it("shares a root with the realtime invalidation contract", () => {
    expect(notificationFeedKey("t1", "all")[0]).toBe(NOTIFICATION_FEED_ROOT);
  });

  it("scopes by tenant", () => {
    expect(notificationFeedKey("t1", "all")).not.toEqual(
      notificationFeedKey("t2", "all"),
    );
  });

  it("separates the server-filtered unread view from the full feed", () => {
    expect(notificationFeedKey("t1", "unread")).not.toEqual(
      notificationFeedKey("t1", "all"),
    );
  });
});

describe("badgeLabel", () => {
  it("is empty at zero so no badge renders", () => {
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(-3)).toBe("");
  });

  it("renders an exact count under the cap", () => {
    expect(badgeLabel(12)).toBe("12");
    expect(badgeLabel(NOTIFICATION_BADGE_CAP)).toBe("99");
  });

  it("caps a backlog so the tab bar can't blow out", () => {
    expect(badgeLabel(NOTIFICATION_BADGE_CAP + 1)).toBe("99+");
    expect(badgeLabel(5000)).toBe("99+");
  });

  it("tolerates a non-finite count", () => {
    expect(badgeLabel(Number.NaN)).toBe("");
  });
});

describe("badgeAccessibilityLabel", () => {
  it("leaves the base label alone at zero", () => {
    expect(badgeAccessibilityLabel("Notifications", 0)).toBe("Notifications");
  });

  it("speaks the exact count, not the capped glyph", () => {
    expect(badgeAccessibilityLabel("Notifications", 250)).toBe(
      "Notifications, 250 unread",
    );
  });
});

describe("badgeSpokenCount", () => {
  it("speaks the exact count past the cap the pill stops at", () => {
    // The whole point: `badgeLabel` has already collapsed this to "99+".
    expect(badgeLabel(250)).toBe("99+");
    expect(badgeSpokenCount(250)).toBe("250");
  });

  it("agrees with the visible pill below the cap", () => {
    expect(badgeSpokenCount(12)).toBe("12");
    expect(badgeSpokenCount(NOTIFICATION_BADGE_CAP)).toBe("99");
  });

  it("is empty for the values that produce no badge at all", () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(badgeSpokenCount(value)).toBe("");
      expect(badgeLabel(value)).toBe("");
    }
  });

  it("floors a fractional count rather than speaking a decimal", () => {
    expect(badgeSpokenCount(4.7)).toBe("4");
  });
});
