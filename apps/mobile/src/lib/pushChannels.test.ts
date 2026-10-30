import { NOTIFICATIONS } from "@postwave/notifications";
import { describe, expect, it } from "vitest";

import {
  LEGACY_PUSH_CHANNEL_ID,
  androidPushChannels,
  pushChannelIdForEvent,
} from "./pushChannels";

describe("androidPushChannels", () => {
  it("registers one channel per notification category plus the legacy channel", () => {
    const channels = androidPushChannels();
    const ids = channels.map((c) => c.id);
    const categories = new Set(
      Object.values(NOTIFICATIONS).map((def) => def.category),
    );
    for (const category of categories) expect(ids).toContain(category);
    expect(ids).toContain(LEGACY_PUSH_CHANNEL_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The rule this guards is "HIGH is rare and earned", not "HIGH is approvals".
   *
   * It was written as `toEqual(["approvals"])` when approvals were the only
   * blocking category. COMMERCE#4 added billing, which meets the same bar for
   * the same reason — one notification per failed invoice, and the cost of
   * missing it is the workspace lapsing. DELIVERABILITY#15 adds deliverability
   * on the same terms: both of its events are EDGE-triggered (a downward
   * threshold crossing that cannot re-fire until the score recovers; a throttle
   * the server refuses to apply twice), so the ceiling is one notification per
   * incident, and the cost of missing it is mail that did not go out.
   *
   * What must never happen is a HIGH-importance channel carrying VOLUME: the
   * moment a bounce or a form submission buzzes with a banner and a sound,
   * people silence Moosewave entirely and the approval push dies with it.
   * Android importance is write-once per channel id, so this is not
   * recoverable after the fact.
   */
  it("reserves heads-up importance for low-volume urgent categories", () => {
    const high = androidPushChannels()
      .filter((c) => c.importance === "high")
      .map((c) => c.id);
    expect(high).toContain("approvals");
    expect(new Set(high)).toEqual(
      new Set(["security", "approvals", "billing", "deliverability"]),
    );
  });

  it("gives new-device alerts a dedicated heads-up channel", () => {
    expect(pushChannelIdForEvent("auth.new_device_sign_in")).toBe("security");
    expect(androidPushChannels()).toContainEqual(
      expect.objectContaining({ id: "security", importance: "high" }),
    );
  });

  /**
   * The DERIVED half of the rule above, and the one that cannot be satisfied by
   * editing a list.
   *
   * An event is default-OFF in the shared manifest precisely when it arrives in
   * bulk (campaign opens, subscriber signups, form submissions) — so a
   * default-OFF event sitting on a heads-up channel is the exact failure the
   * pinned set exists to prevent, expressed as a property instead of a
   * membership. A future category that argues its way into HIGH still cannot
   * bring an opt-in firehose with it.
   */
  it("never lets an opt-in (high-volume) event ride a heads-up channel", () => {
    const high = new Set(
      androidPushChannels()
        .filter((c) => c.importance === "high")
        .map((c) => c.id),
    );
    for (const def of Object.values(NOTIFICATIONS)) {
      if (!high.has(def.category)) continue;
      expect(
        def.defaultEnabled,
        `${def.event} is default-OFF (i.e. high volume) but its category ` +
          `"${def.category}" is a heads-up channel`,
      ).toBe(true);
    }
  });

  it("never gives a high-volume category a heads-up banner", () => {
    const importanceById = new Map(
      androidPushChannels().map((c) => [c.id, c.importance]),
    );
    // Every category whose events are default-OFF because they arrive in bulk.
    for (const noisy of ["subscribers", "campaigns", "forms"]) {
      expect(importanceById.get(noisy)).not.toBe("high");
    }
  });

  it("names and describes every channel — Android renders both in Settings", () => {
    for (const channel of androidPushChannels()) {
      expect(channel.name.length).toBeGreaterThan(2);
      expect(channel.description.length).toBeGreaterThan(10);
    }
  });
});

describe("pushChannelIdForEvent", () => {
  it("routes every manifest event to its category channel", () => {
    const ids = new Set(androidPushChannels().map((c) => c.id));
    for (const [event, def] of Object.entries(NOTIFICATIONS)) {
      const id = pushChannelIdForEvent(event);
      expect(id).toBe(def.category);
      // A channel id the device never created makes Android DROP the
      // notification silently, so every mapped id must be registered.
      expect(ids.has(id)).toBe(true);
    }
  });

  it("falls back to the legacy channel for an event this build does not know", () => {
    // An older client meeting a newer server must still show the notification.
    expect(pushChannelIdForEvent("something.invented.later")).toBe(
      LEGACY_PUSH_CHANNEL_ID,
    );
    expect(pushChannelIdForEvent("")).toBe(LEGACY_PUSH_CHANNEL_ID);
  });
});
