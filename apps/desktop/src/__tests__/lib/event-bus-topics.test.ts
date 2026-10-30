import { describe, expect, it } from "vitest";

import {
  CONCRETE_EVENT_BUS_TOPICS,
  DEFAULT_EVENT_BUS_TOPICS,
  normalizeEventBusTopics,
} from "../../lib/event-bus-topics";

describe("desktop event-bus topic normalization", () => {
  it("uses the desktop default topic set when no usable topic is supplied", () => {
    expect(normalizeEventBusTopics([])).toBe(DEFAULT_EVENT_BUS_TOPICS.join(","));
    expect(normalizeEventBusTopics(["Campaign.*", "../audit"])).toBe(
      DEFAULT_EVENT_BUS_TOPICS.join(","),
    );
  });

  it("deduplicates and trims valid topic patterns", () => {
    expect(
      normalizeEventBusTopics([" campaign.* ", "campaign.*", "audit.created"]),
    ).toBe("campaign.*,audit.created");
  });

  it("caps topic count and falls back on oversized topic CSVs", () => {
    expect(
      normalizeEventBusTopics(Array.from({ length: 75 }, (_, i) => `t${i}.event`))
        .split(",")
        .length,
    ).toBe(50);
    expect(
      normalizeEventBusTopics(
        Array.from({ length: 50 }, (_, i) => `verylongtopic${i}.verylongevent`),
      ),
    ).toBe(DEFAULT_EVENT_BUS_TOPICS.join(","));
  });

  it("survives its own normalization — every declared topic is actually sent", () => {
    // Declaring a topic and subscribing to it are different things:
    // normalizeEventBusTopics silently SKIPS any entry that fails the topic
    // grammar, so an ungrammatical declaration produces a shorter `?topics=`
    // CSV with no error anywhere. This file's own
    // `subscriber.lifecycle_stage_changed` was being dropped exactly that way,
    // which is the bug its neighbouring comment says it exists to prevent.
    for (const list of [DEFAULT_EVENT_BUS_TOPICS, CONCRETE_EVENT_BUS_TOPICS]) {
      expect(normalizeEventBusTopics([...list]).split(",")).toEqual([...list]);
    }
  });

  it("accepts underscore segments the gateway actually publishes", () => {
    // Mirrors apps/api/internal/events/handler.go streamTopicRE.
    for (const topic of [
      "list_health.degraded",
      "list_health.*",
      "subscriber.engagement_updated",
      "subscriber.lifecycle_stage_changed",
      "subscriber.pii_detected",
      "referral.milestone.unlocked",
    ]) {
      expect(normalizeEventBusTopics([topic]), topic).toBe(topic);
    }
    // …while still rejecting the shapes the grammar must exclude.
    for (const bad of ["Campaign.*", "../audit", "_leading", "a..b", "9x.y"]) {
      expect(normalizeEventBusTopics([bad]), bad).toBe(
        DEFAULT_EVENT_BUS_TOPICS.join(","),
      );
    }
  });

  it("keeps named EventSource listener topics in sync with realtime collaboration", () => {
    expect(DEFAULT_EVENT_BUS_TOPICS).toContain("cursor.*");
    expect(DEFAULT_EVENT_BUS_TOPICS).toContain("selection.*");
    expect(CONCRETE_EVENT_BUS_TOPICS).toContain("cursor.move");
    expect(CONCRETE_EVENT_BUS_TOPICS).toContain("selection.move");
    expect(new Set(CONCRETE_EVENT_BUS_TOPICS).size).toBe(
      CONCRETE_EVENT_BUS_TOPICS.length,
    );
  });
});
