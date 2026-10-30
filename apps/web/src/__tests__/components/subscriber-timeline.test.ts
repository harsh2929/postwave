// Tests for subscriber detail helper behavior used by the drill-down route.

import { describe, expect, it } from "vitest";

import {
  bucketTimeline,
  createTimelineAttemptGate,
  isSuppressedStatus,
  isTimelineUnavailableError,
  membershipChipsFromEvents,
  mergeTimelinePages,
  nextTimelineCursor,
  statusVariant,
} from "@/app/(dashboard)/app/subscribers/[id]/subscriber-detail-helpers";
import { ApiError } from "@/lib/api";
import type {
  SubscriberTimeline,
  SubscriberTimelineEvent,
} from "@/lib/subscriber-timeline-api";

function evt(
  type: string,
  occurredAt: string,
  extra: Partial<SubscriberTimelineEvent> = {},
): SubscriberTimelineEvent {
  return { type, occurred_at: occurredAt, source: "campaigns", ...extra };
}

function timeline(patch: Partial<SubscriberTimeline> = {}): SubscriberTimeline {
  return {
    email: "demo@example.com",
    events: [
      evt("sent", "2026-04-03T10:00:00Z"),
      evt("opened", "2026-04-02T10:00:00Z"),
      evt("clicked", "2026-04-01T10:00:00Z"),
    ],
    pagination: {
      has_more: false,
      limit: 10,
    },
    stats: {
      bounced_count: 0,
      click_rate: 0.2,
      clicked_count: 1,
      current_status: "active",
      engagement_score: 0.75,
      open_rate: 0.6,
      opened_count: 3,
      replied_count: 0,
      sent_count: 5,
      subscribed_at: "2026-01-01T00:00:00Z",
    },
    subscriber_id: "sub_demo",
    ...patch,
  };
}

describe("subscriber detail timeline helpers", () => {
  it("merges paginated timeline pages and dedupes repeated boundary events", () => {
    const duplicate = evt("opened", "2026-04-02T10:00:00Z", {
      subject_id: "campaign-1",
    });
    const merged = mergeTimelinePages([
      timeline({
        events: [evt("sent", "2026-04-03T10:00:00Z"), duplicate],
        pagination: { has_more: true, limit: 2 },
      }),
      timeline({
        events: [duplicate, evt("clicked", "2026-04-01T10:00:00Z")],
        pagination: {
          before: "2026-04-02T10:00:00Z",
          has_more: false,
          limit: 2,
        },
      }),
    ]);

    expect(merged?.events.map((event) => event.type)).toEqual([
      "sent",
      "opened",
      "clicked",
    ]);
    expect(merged?.pagination.has_more).toBe(false);
  });

  it("retains legitimate same-time events from different timeline sources", () => {
    const shared = {
      occurred_at: "2026-04-02T10:00:00Z",
      subject_id: "campaign-1",
      type: "opened",
    };
    const merged = mergeTimelinePages([
      timeline({
        events: [
          { ...shared, source: "subscriber_events" },
          { ...shared, source: "audit_log" },
        ],
      }),
    ]);

    expect(merged?.events.map((event) => event.source)).toEqual([
      "subscriber_events",
      "audit_log",
    ]);
  });

  it("blocks duplicate page attempts without letting an old release unlock a newer key", () => {
    const gate = createTimelineAttemptGate();
    const releaseFirst = gate.begin("subscriber-a:cursor-1");
    expect(releaseFirst).toBeTypeOf("function");
    expect(gate.begin("subscriber-a:cursor-1")).toBeNull();

    const releaseNewSubscriber = gate.begin("subscriber-b:cursor-1");
    expect(releaseNewSubscriber).toBeTypeOf("function");
    releaseFirst?.();
    expect(gate.begin("subscriber-b:cursor-1")).toBeNull();

    releaseNewSubscriber?.();
    expect(gate.begin("subscriber-b:cursor-1")).toBeTypeOf("function");
  });

  it("returns the next cursor only when more timeline pages exist", () => {
    expect(nextTimelineCursor(timeline())).toBeUndefined();
    expect(
      nextTimelineCursor(
        timeline({
          pagination: {
            has_more: true,
            limit: 10,
            next_cursor: "opaque-next-page",
          },
        }),
      ),
    ).toBe("opaque-next-page");
    expect(
      nextTimelineCursor(
        timeline({
          events: [],
          pagination: { has_more: true, limit: 10 },
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps subscriber-not-found distinct from unavailable endpoints", () => {
    expect(isTimelineUnavailableError(new ApiError("missing", 404))).toBe(
      false,
    );
    expect(isTimelineUnavailableError(new ApiError("method", 405))).toBe(true);
    expect(isTimelineUnavailableError(new ApiError("disabled", 501))).toBe(
      true,
    );
    expect(isTimelineUnavailableError(new ApiError("broken", 500))).toBe(false);
    expect(isTimelineUnavailableError(new Error("network"))).toBe(false);
  });

  it("normalizes suppressed and blocklisted statuses consistently", () => {
    expect(isSuppressedStatus("suppressed")).toBe(true);
    expect(isSuppressedStatus("blocklisted")).toBe(true);
    expect(isSuppressedStatus("active")).toBe(false);
    expect(statusVariant("suppressed")).toBe("destructive");
    expect(statusVariant("blocklisted")).toBe("destructive");
  });

  it("derives membership chips from loaded timeline events without placeholders", () => {
    expect(membershipChipsFromEvents([])).toEqual([]);
    expect(
      membershipChipsFromEvents([
        evt("tag_removed", "2026-04-03T10:00:00Z", {
          detail: { tag: "VIP" },
        }),
        evt("list_added", "2026-04-02T10:00:00Z", {
          detail: { name: "Newsletter" },
        }),
        evt("tag_added", "2026-04-01T10:00:00Z", {
          detail: { tag: "VIP" },
        }),
      ]),
    ).toEqual([{ kind: "list", name: "Newsletter" }]);
  });

  it("buckets loaded engagement events into the 90-day sparkline window", () => {
    const buckets = bucketTimeline(
      [
        evt("opened", "2026-04-10T12:00:00Z"),
        evt("clicked", "2026-04-10T13:00:00Z"),
        evt("opened", "2026-01-01T12:00:00Z"),
      ],
      new Date("2026-04-10T15:00:00Z"),
    );

    expect(buckets).toHaveLength(90);
    expect(buckets.at(-1)).toEqual({
      clicks: 1,
      date: "2026-04-10",
      opens: 1,
    });
  });
});
