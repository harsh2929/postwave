// Cross-channel timeline helpers (R3 full-surface wiring): keyset
// page appending with defensive dedupe, channel badge mapping (email/
// sms typed, unknown channels rendered verbatim), and item text
// fallbacks.

import { describe, expect, it } from "vitest";

import type { CrossChannelTimelineItem } from "../../lib/api-client";
import {
  appendTimelinePage,
  channelBadge,
  timelineItemKey,
  timelineItemText,
} from "../../components/subscribers/cross-channel-helpers";

function item(over: Partial<CrossChannelTimelineItem>): CrossChannelTimelineItem {
  return {
    at: "2026-06-01T10:00:00Z",
    channel: "email",
    type: "opened",
    label: "Opened campaign",
    ...over,
  };
}

describe("appendTimelinePage", () => {
  it("appends older items after the existing ones", () => {
    const a = [item({ at: "2026-06-02T00:00:00Z" })];
    const b = [item({ at: "2026-06-01T00:00:00Z" })];
    const out = appendTimelinePage(a, b);
    expect(out).toHaveLength(2);
    expect(out[0]!.at).toBe("2026-06-02T00:00:00Z");
    expect(out[1]!.at).toBe("2026-06-01T00:00:00Z");
  });

  it("drops exact duplicates (cursor ties) instead of doubling rows", () => {
    const a = [item({}), item({ channel: "sms", type: "sent", label: "SMS sent" })];
    const out = appendTimelinePage(a, [item({})]);
    expect(out).toHaveLength(2);
  });

  it("returns the existing array identity for an empty/fully-dup page", () => {
    const a = [item({})];
    expect(appendTimelinePage(a, [])).toBe(a);
    expect(appendTimelinePage(a, [item({})])).toBe(a);
  });

  it("same timestamp + different channel/type are distinct events", () => {
    const a = [item({})];
    const out = appendTimelinePage(a, [
      item({ channel: "sms" }),
      item({ type: "clicked" }),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe("timelineItemKey", () => {
  it("distinguishes on the full (at, channel, type, label) tuple", () => {
    expect(timelineItemKey(item({}))).not.toBe(
      timelineItemKey(item({ label: "Other" })),
    );
  });
});

describe("channelBadge", () => {
  it("maps the two wire channels case-insensitively", () => {
    expect(channelBadge("email").label).toBe("Email");
    expect(channelBadge("SMS").label).toBe("SMS");
  });

  it("renders unknown channels verbatim instead of coercing", () => {
    expect(channelBadge("push").label).toBe("PUSH");
    expect(channelBadge("").label).toBe("?");
  });
});

describe("timelineItemText", () => {
  it("prefers label, falls back to type, then a placeholder", () => {
    expect(timelineItemText(item({}))).toBe("Opened campaign");
    expect(timelineItemText(item({ label: "" }))).toBe("opened");
    expect(timelineItemText(item({ label: "", type: "" }))).toBe("(event)");
  });
});
