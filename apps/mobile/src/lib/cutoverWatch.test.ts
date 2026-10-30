import { describe, expect, it } from "vitest";

import {
  cutoverHeadline,
  parseShadowWatch,
  parseSourceEventWatch,
  pendingReviewCount,
  reopenUnavailableReason,
  reviewedCount,
  shadowActionCopy,
  watchAgeCopy,
  type ShadowWatch,
  type SourceEventWatch,
} from "./cutoverWatch";

/** Shaped exactly like `shadowMonitorResponse` (shadow_monitor.go:143). */
const SHADOW_PAYLOAD = {
  monitor: {
    job_id: "job_1",
    tenant_id: "t_1",
    source: "klaviyo",
    enabled: true,
    interval_seconds: 3600,
    last_checked_at: "2026-07-25T10:00:00Z",
    next_check_at: "2026-07-25T11:00:00Z",
    last_recommended_action: "run_delta_import_before_cutover",
  },
  history: [
    {
      job_id: "job_1",
      source: "klaviyo",
      generated_at: "2026-07-25T10:00:00Z",
      needs_delta_import: true,
      recommended_action: "run_delta_import_before_cutover",
      blockers: [],
      deltas: [
        {
          resource: "subscribers",
          label: "Profiles",
          source_total: 1200,
          imported: 1180,
          delta: 20,
          status: "delta_detected",
          supported: true,
          cutover_risk: "medium",
        },
        {
          resource: "segments",
          label: "Segments",
          source_total: 8,
          imported: 8,
          delta: 0,
          status: "match",
          supported: true,
          cutover_risk: "low",
        },
      ],
    },
  ],
};

/** Shaped exactly like `sourceEventMonitorResponse` (source_events.go:186). */
const EVENTS_PAYLOAD = {
  monitor: {
    job_id: "job_1",
    tenant_id: "t_1",
    source: "activecampaign",
    enabled: true,
    interval_seconds: 3600,
    enabled_since: "2026-07-20T09:00:00Z",
    last_event_at: "2026-07-25T09:40:00Z",
    last_synced_at: "2026-07-25T10:00:00Z",
    next_sync_at: "2026-07-25T11:00:00Z",
    events_seen: 14,
    events_applied: 12,
  },
  events: [
    {
      id: "11111111-1111-1111-1111-111111111111",
      job_id: "job_1",
      tenant_id: "t_1",
      source: "activecampaign",
      source_event_id: "ac_9",
      resource_type: "activecampaign_non_email_contact",
      action: "manual_review",
      occurred_at: "2026-07-25T09:40:00Z",
      applied: false,
      review_status: "pending",
    },
    {
      id: "22222222-2222-2222-2222-222222222222",
      job_id: "job_1",
      tenant_id: "t_1",
      source: "activecampaign",
      source_event_id: "ac_8",
      resource_type: "activecampaign_non_email_contact",
      action: "manual_review",
      occurred_at: "2026-07-24T09:40:00Z",
      applied: false,
      review_status: "reviewed",
      review_detail: "Reconciled against the CRM export.",
      reviewed_at: "2026-07-24T12:00:00Z",
    },
    {
      id: "33333333-3333-3333-3333-333333333333",
      job_id: "job_1",
      tenant_id: "t_1",
      source: "activecampaign",
      source_event_id: "ac_7",
      resource_type: "contact",
      action: "upsert",
      applied: true,
      review_status: "pending",
    },
  ],
};

describe("cutover watch parsing", () => {
  it("reads the shadow monitor and names the resources that moved", () => {
    const watch = parseShadowWatch(SHADOW_PAYLOAD);
    expect(watch).not.toBeNull();
    expect(watch?.enabled).toBe(true);
    expect(watch?.lastAction).toBe("run_delta_import_before_cutover");
    expect(watch?.history).toHaveLength(1);
    // Only the delta that actually moved is named; a matching resource is
    // noise on a phone.
    expect(watch?.history[0]?.changedResources).toEqual(["Profiles"]);
    expect(watch?.history[0]?.blockers).toBe(0);
  });

  it("returns null rather than an empty shell for a non-monitor payload", () => {
    expect(parseShadowWatch(null)).toBeNull();
    expect(parseShadowWatch({ history: [] })).toBeNull();
    expect(parseSourceEventWatch("not a document")).toBeNull();
  });

  it("distinguishes a missing count from zero", () => {
    const watch = parseSourceEventWatch({ monitor: { enabled: true } });
    expect(watch?.eventsSeen).toBeNull();
    expect(watch?.eventsApplied).toBeNull();
    expect(watch?.lastEventAt).toBeNull();
    // The one with real numbers still reads them.
    expect(parseSourceEventWatch(EVENTS_PAYLOAD)?.eventsSeen).toBe(14);
  });

  it("counts only unapplied manual-review rows as pending", () => {
    const watch = parseSourceEventWatch(EVENTS_PAYLOAD);
    expect(watch?.events).toHaveLength(3);
    expect(pendingReviewCount(watch)).toBe(1);
    expect(reviewedCount(watch)).toBe(1);
  });

  it("drops an event row with no id rather than rendering a keyless row", () => {
    const watch = parseSourceEventWatch({
      monitor: { enabled: true },
      events: [{ resource_type: "contact", action: "upsert" }],
    });
    expect(watch?.events).toEqual([]);
  });
});

describe("shadow action copy", () => {
  it("names every action the service can emit", () => {
    expect(shadowActionCopy("ready_for_cutover_review").tone).toBe("ok");
    expect(shadowActionCopy("run_delta_import_before_cutover").tone).toBe(
      "attention",
    );
    expect(shadowActionCopy("manual_review_required").tone).toBe("danger");
    expect(shadowActionCopy("check_failed").tone).toBe("danger");
  });

  it("echoes an unknown verdict instead of swallowing it", () => {
    expect(shadowActionCopy("some_new_verdict").label).toBe("some new verdict");
    expect(shadowActionCopy(null).label).toBe("No check has run yet");
  });
});

describe("cutover headline", () => {
  const liveShadow: ShadowWatch = {
    enabled: true,
    intervalSeconds: 3600,
    lastCheckedAt: "2026-07-25T10:00:00Z",
    nextCheckAt: "2026-07-25T11:00:00Z",
    lastAction: "ready_for_cutover_review",
    lastError: null,
    history: [],
  };
  const liveEvents: SourceEventWatch = {
    enabled: true,
    intervalSeconds: 3600,
    enabledSince: "2026-07-20T09:00:00Z",
    lastEventAt: null,
    lastSyncedAt: "2026-07-25T10:00:00Z",
    nextSyncAt: "2026-07-25T11:00:00Z",
    lastError: null,
    eventsSeen: 0,
    eventsApplied: 0,
    events: [],
  };

  it("says nothing is watching when neither monitor exists", () => {
    const out = cutoverHeadline({ shadow: null, events: null });
    expect(out.tone).toBe("neutral");
    expect(out.headline).toBe("No cutover watch is running");
  });

  // The load-bearing case: a stopped monitor's frozen counters read exactly
  // like a live monitor's quiet ones.
  it("outranks every number with the fact that the watch is stopped", () => {
    const out = cutoverHeadline({
      shadow: { ...liveShadow, enabled: false },
      events: liveEvents,
    });
    expect(out.headline).toBe("The watch is stopped");
    expect(out.tone).toBe("attention");
    expect(out.detail).toContain("frozen");
  });

  it("leads with pending manual reviews over a clean shadow verdict", () => {
    const events = parseSourceEventWatch(EVENTS_PAYLOAD);
    const out = cutoverHeadline({ shadow: liveShadow, events });
    expect(out.headline).toBe("1 source change needs manual review");
    expect(out.tone).toBe("danger");
  });

  it("reports a live source that is still receiving traffic", () => {
    const out = cutoverHeadline({
      shadow: liveShadow,
      events: { ...liveEvents, eventsSeen: 6, eventsApplied: 6 },
    });
    expect(out.headline).toBe("6 source events since cutover");
    expect(out.tone).toBe("attention");
  });

  it("only says the source is quiet when the watch is actually running", () => {
    const out = cutoverHeadline({ shadow: liveShadow, events: liveEvents });
    expect(out.headline).toBe("Source is quiet");
    expect(out.tone).toBe("ok");
  });

  it("surfaces a failing poll ahead of its stale counters", () => {
    const out = cutoverHeadline({
      shadow: { ...liveShadow, lastError: "klaviyo returned 429" },
      events: liveEvents,
    });
    expect(out.tone).toBe("danger");
    expect(out.detail).toBe("klaviyo returned 429");
  });
});

describe("re-open availability mirrors the handler's 409s", () => {
  const reviewed = {
    applied: false,
    action: "manual_review",
    reviewed: true,
  } as const;

  it("allows re-opening a signed-off manual-review event on a completed job", () => {
    expect(
      reopenUnavailableReason({ jobStatus: "completed", event: reviewed }),
    ).toBeNull();
  });

  it("refuses on a job that is not completed", () => {
    expect(
      reopenUnavailableReason({ jobStatus: "importing", event: reviewed }),
    ).toBe("Review re-opens only on a completed import.");
  });

  it("refuses for an applied event or a non-review action", () => {
    expect(
      reopenUnavailableReason({
        jobStatus: "completed",
        event: { applied: true, action: "manual_review", reviewed: true },
      }),
    ).toBe("Only unapplied manual-review events carry a sign-off.");
    expect(
      reopenUnavailableReason({
        jobStatus: "completed",
        event: { applied: false, action: "upsert", reviewed: true },
      }),
    ).toBe("Only unapplied manual-review events carry a sign-off.");
  });

  it("refuses for an event that was never signed off", () => {
    expect(
      reopenUnavailableReason({
        jobStatus: "completed",
        event: { applied: false, action: "manual_review", reviewed: false },
      }),
    ).toBe("This event has not been signed off.");
  });
});

describe("watch age", () => {
  const now = Date.parse("2026-07-25T12:00:00Z");

  it("states absence rather than implying freshness", () => {
    expect(watchAgeCopy(null, now)).toBe("never checked");
    expect(watchAgeCopy("not-a-date", now)).toBe("last check time unknown");
  });

  it("scales the unit with the age", () => {
    expect(watchAgeCopy("2026-07-25T11:59:30Z", now)).toBe("checked just now");
    expect(watchAgeCopy("2026-07-25T11:20:00Z", now)).toBe("checked 40m ago");
    expect(watchAgeCopy("2026-07-25T06:00:00Z", now)).toBe("checked 6h ago");
    expect(watchAgeCopy("2026-07-22T12:00:00Z", now)).toBe("checked 3d ago");
  });
});
