import { describe, expect, it } from "vitest";

import {
  eventTypeFromPushData,
  NOTIFICATION_FEED_ROOT,
  queryRootsForPushData,
} from "./pushInvalidation";

describe("eventTypeFromPushData", () => {
  it("reads the top-level event_type the sender sets", () => {
    expect(eventTypeFromPushData({ event_type: "approval.requested" })).toBe(
      "approval.requested",
    );
  });

  it("ignores nested bodies and malformed payloads", () => {
    expect(eventTypeFromPushData(null)).toBeNull();
    expect(eventTypeFromPushData("approval.requested")).toBeNull();
    expect(
      eventTypeFromPushData({ body: { event_type: "campaign.sent" } }),
    ).toBeNull();
    expect(eventTypeFromPushData({ event_type: 7 })).toBeNull();
    expect(eventTypeFromPushData({ event_type: "  " })).toBeNull();
  });

  it("rejects an over-long event type", () => {
    expect(eventTypeFromPushData({ event_type: "a".repeat(200) })).toBeNull();
  });
});

describe("queryRootsForPushData", () => {
  it("always dirties the inbox feed", () => {
    expect(queryRootsForPushData(undefined)).toEqual([NOTIFICATION_FEED_ROOT]);
    expect(queryRootsForPushData({ event_type: "nonsense.event" })).toEqual([
      NOTIFICATION_FEED_ROOT,
    ]);
  });

  it("adds the entity roots the event maps to", () => {
    const roots = queryRootsForPushData({ event_type: "approval.requested" });
    expect(roots[0]).toBe(NOTIFICATION_FEED_ROOT);
    expect(roots).toContain("approvals");
    expect(roots.length).toBeGreaterThan(1);
  });

  it("de-duplicates the feed root when the event also maps to it", () => {
    const roots = queryRootsForPushData({ event_type: "notification.created" });
    expect(roots.filter((r) => r === NOTIFICATION_FEED_ROOT)).toHaveLength(1);
  });
});
