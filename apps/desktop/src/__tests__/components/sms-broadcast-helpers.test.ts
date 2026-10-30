/**
 * sms-broadcast-helpers.test — pure-logic coverage for the SMS
 * Broadcasts surface (src/components/sms/broadcasts/broadcast-helpers.ts).
 *
 * The segment-math cases mirror the Go reference (apps/api/internal/
 * sms/phone.go SegmentCount) boundary-for-boundary so the composer
 * counter can never disagree with the stored segments_per_message.
 */

import { describe, expect, it } from "vitest";

import type { SmsBroadcast } from "../../lib/api-client";
import {
  audienceKind,
  audienceSummary,
  broadcastStatusBadge,
  buildBroadcastUpsert,
  canCancelBroadcast,
  canDeleteBroadcast,
  canEditBroadcast,
  canSendBroadcast,
  describeBroadcastError,
  emptyBroadcastForm,
  extractAudienceCap,
  fieldForBroadcastErrorCode,
  formFromBroadcast,
  isoToLocalInput,
  localInputToIso,
  progressPct,
  smsSegmentInfo,
  unwrapLists,
  validateBroadcastForm,
  type BroadcastFormState,
} from "../../components/sms/broadcasts/broadcast-helpers";

function baseBroadcast(over: Partial<SmsBroadcast> = {}): SmsBroadcast {
  return {
    id: "b1",
    tenant_id: "10000000-0000-4000-8000-000000000001",
    name: "June blast",
    body: "Hello!",
    list_ids: [],
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 1,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function baseForm(over: Partial<BroadcastFormState> = {}): BroadcastFormState {
  return {
    ...emptyBroadcastForm(),
    name: "June blast",
    body: "Hello!",
    audience: "lists",
    listIds: ["l1"],
    ...over,
  };
}

/* ---------- segment math (mirrors Go SegmentCount) ------------------- */

describe("smsSegmentInfo", () => {
  it("returns 0 segments for empty / whitespace bodies (Go parity)", () => {
    expect(smsSegmentInfo("").segments).toBe(0);
    expect(smsSegmentInfo("   \n ").segments).toBe(0);
    expect(smsSegmentInfo("").remaining).toBe(160);
  });

  it("trims before counting, like the server", () => {
    expect(smsSegmentInfo("  a  ").chars).toBe(1);
  });

  it("GSM: 160 chars is one segment, 161 splits at 153", () => {
    expect(smsSegmentInfo("a".repeat(160))).toMatchObject({
      segments: 1,
      remaining: 0,
      encoding: "gsm",
    });
    expect(smsSegmentInfo("a".repeat(161)).segments).toBe(2);
    // 2*153 = 306 fits in 2; 307 needs 3.
    expect(smsSegmentInfo("a".repeat(306)).segments).toBe(2);
    expect(smsSegmentInfo("a".repeat(307)).segments).toBe(3);
  });

  it("any code point above 127 flips the body to unicode 70/67", () => {
    const info = smsSegmentInfo(`héllo ${"a".repeat(64)}`);
    expect(info.encoding).toBe("unicode");
    expect(info.singleLimit).toBe(70);
    expect(info.segments).toBe(1);
    expect(smsSegmentInfo("é".repeat(71)).segments).toBe(2);
    // 2*67 = 134 fits in 2; 135 needs 3.
    expect(smsSegmentInfo("é".repeat(134)).segments).toBe(2);
    expect(smsSegmentInfo("é".repeat(135)).segments).toBe(3);
  });

  it("counts code points, not UTF-16 units (emoji)", () => {
    // 🎉 is a surrogate pair (length 2) but ONE code point / rune.
    expect(smsSegmentInfo("🎉").chars).toBe(1);
    expect(smsSegmentInfo("🎉").encoding).toBe("unicode");
  });

  it("reports remaining capacity within the current segment", () => {
    expect(smsSegmentInfo("a".repeat(150)).remaining).toBe(10);
    // 161 chars → 2 segments of 153 → 306 - 161 = 145 left.
    expect(smsSegmentInfo("a".repeat(161)).remaining).toBe(145);
  });
});

/* ---------- audience -------------------------------------------------- */

describe("audienceKind / audienceSummary", () => {
  it("classifies the exactly-one audience dimensions", () => {
    expect(audienceKind({ list_ids: ["a"] })).toBe("lists");
    expect(audienceKind({ segment_id: "s1" })).toBe("segment");
    expect(audienceKind({ tag: "vip" })).toBe("tag");
    expect(audienceKind({})).toBeNull();
    expect(audienceKind({ list_ids: [], segment_id: "", tag: "" })).toBeNull();
  });

  it("summarises lists with names, counts, and overflow", () => {
    const lookup = {
      listName: (id: string): string | undefined =>
        ({ a: "VIP", b: "News" })[id],
    };
    expect(audienceSummary({ list_ids: ["a"] }, lookup)).toBe("List: VIP");
    expect(audienceSummary({ list_ids: ["a", "b"] }, lookup)).toBe(
      "2 lists: VIP, News",
    );
    expect(
      audienceSummary({ list_ids: ["a", "b", "c", "d"] }, lookup),
    ).toContain("+1 more");
  });

  it("falls back to a shortened id when no name is known", () => {
    expect(audienceSummary({ segment_id: "0123456789abcdef" })).toBe(
      "Segment: 01234567…",
    );
    expect(audienceSummary({ tag: "vip" })).toBe("Tag: vip");
    expect(audienceSummary({})).toBe("No audience yet");
  });
});

/* ---------- form validation + upsert ---------------------------------- */

describe("validateBroadcastForm", () => {
  const now = new Date("2026-06-11T12:00:00");

  it("accepts a complete lists draft", () => {
    expect(validateBroadcastForm(baseForm(), now)).toEqual({});
  });

  it("requires name and body (mirrors 422 name_required/body_required)", () => {
    const errors = validateBroadcastForm(
      baseForm({ name: "  ", body: " " }),
      now,
    );
    expect(errors.name).toBeTruthy();
    expect(errors.body).toBeTruthy();
  });

  it("requires the chosen audience dimension to be populated", () => {
    expect(
      validateBroadcastForm(baseForm({ listIds: [] }), now).audience,
    ).toBeTruthy();
    expect(
      validateBroadcastForm(
        baseForm({ audience: "segment", segmentId: "" }),
        now,
      ).audience,
    ).toBeTruthy();
    expect(
      validateBroadcastForm(baseForm({ audience: "tag", tag: "  " }), now)
        .audience,
    ).toBeTruthy();
    expect(
      validateBroadcastForm(
        baseForm({ audience: "tag", tag: "vip", listIds: [] }),
        now,
      ),
    ).toEqual({});
  });

  it("rejects past and unparseable schedule times", () => {
    expect(
      validateBroadcastForm(
        baseForm({ scheduledAtLocal: "2026-06-11T11:00" }),
        now,
      ).schedule,
    ).toBeTruthy();
    expect(
      validateBroadcastForm(baseForm({ scheduledAtLocal: "not-a-date" }), now)
        .schedule,
    ).toBeTruthy();
    expect(
      validateBroadcastForm(
        baseForm({ scheduledAtLocal: "2026-06-11T13:00" }),
        now,
      ),
    ).toEqual({});
  });
});

describe("buildBroadcastUpsert", () => {
  it("sets the chosen audience and explicitly clears the other two", () => {
    expect(buildBroadcastUpsert(baseForm())).toMatchObject({
      list_ids: ["l1"],
      segment_id: "",
      tag: "",
    });
    expect(
      buildBroadcastUpsert(baseForm({ audience: "segment", segmentId: "s1" })),
    ).toMatchObject({ list_ids: [], segment_id: "s1", tag: "" });
    expect(
      buildBroadcastUpsert(baseForm({ audience: "tag", tag: "vip" })),
    ).toMatchObject({ list_ids: [], segment_id: "", tag: "vip" });
  });

  it("clears stale dimensions even when their form fields still hold values", () => {
    // Operator picked lists, typed a tag, then switched back to lists:
    // the tag must NOT survive into the payload (server 422
    // invalid_audience guards this — we never trip it).
    const upsert = buildBroadcastUpsert(
      baseForm({ audience: "lists", tag: "leftover", segmentId: "s9" }),
    );
    expect(upsert.tag).toBe("");
    expect(upsert.segment_id).toBe("");
  });

  it("trims text fields and maps an empty schedule to null", () => {
    const upsert = buildBroadcastUpsert(
      baseForm({ name: " June ", body: " Hi ", scheduledAtLocal: "" }),
    );
    expect(upsert.name).toBe("June");
    expect(upsert.body).toBe("Hi");
    expect(upsert.scheduled_at).toBeNull();
  });

  it("serialises the schedule as RFC3339 UTC", () => {
    const upsert = buildBroadcastUpsert(
      baseForm({ scheduledAtLocal: "2026-07-01T09:30" }),
    );
    expect(upsert.scheduled_at).toBe(
      new Date("2026-07-01T09:30").toISOString(),
    );
  });
});

describe("formFromBroadcast", () => {
  it("round-trips a stored row including the audience kind", () => {
    const form = formFromBroadcast(
      baseBroadcast({ segment_id: "s1", sender_profile_id: "p1" }),
    );
    expect(form.audience).toBe("segment");
    expect(form.segmentId).toBe("s1");
    expect(form.senderProfileId).toBe("p1");
  });

  it("defaults a no-audience draft to the lists picker", () => {
    expect(formFromBroadcast(baseBroadcast()).audience).toBe("lists");
  });
});

/* ---------- datetime conversions --------------------------------------- */

describe("local <-> ISO datetime conversion", () => {
  it("round-trips through both directions", () => {
    const local = "2026-07-01T09:30";
    const iso = localInputToIso(local);
    expect(iso).toBeTruthy();
    expect(isoToLocalInput(iso)).toBe(local);
  });

  it("handles empty / invalid input", () => {
    expect(localInputToIso("")).toBeNull();
    expect(localInputToIso("garbage")).toBeNull();
    expect(isoToLocalInput(null)).toBe("");
    expect(isoToLocalInput("garbage")).toBe("");
  });
});

/* ---------- status + gates --------------------------------------------- */

describe("status badge + action gates", () => {
  it("maps every status onto the shared badge classes", () => {
    expect(broadcastStatusBadge("draft")).toEqual({
      label: "Draft",
      className: "badge",
    });
    expect(broadcastStatusBadge("scheduled").className).toBe("badge warning");
    expect(broadcastStatusBadge("sending").className).toBe("badge accent");
    expect(broadcastStatusBadge("sent").className).toBe("badge accent");
    expect(broadcastStatusBadge("cancelled").label).toBe("Cancelled");
  });

  it("renders unknown statuses verbatim instead of guessing", () => {
    expect(broadcastStatusBadge("weird_future_status")).toEqual({
      label: "weird_future_status",
      className: "badge",
    });
    expect(broadcastStatusBadge("").label).toBe("—");
  });

  it("send from draft|scheduled; cancel scheduled|sending; delete draft; edit draft|scheduled", () => {
    expect(canSendBroadcast("draft")).toBe(true);
    expect(canSendBroadcast("scheduled")).toBe(true);
    expect(canSendBroadcast("sending")).toBe(false);
    expect(canSendBroadcast("sent")).toBe(false);

    expect(canCancelBroadcast("scheduled")).toBe(true);
    expect(canCancelBroadcast("sending")).toBe(true);
    expect(canCancelBroadcast("draft")).toBe(false);

    expect(canDeleteBroadcast("draft")).toBe(true);
    expect(canDeleteBroadcast("sent")).toBe(false);
    expect(canDeleteBroadcast("cancelled")).toBe(false);

    expect(canEditBroadcast("draft")).toBe(true);
    expect(canEditBroadcast("scheduled")).toBe(true);
    expect(canEditBroadcast("sending")).toBe(false);
  });
});

/* ---------- progress ---------------------------------------------------- */

describe("progressPct", () => {
  it("counts sent+failed as done; held stays outstanding", () => {
    expect(
      progressPct({
        status: "sending",
        sent: 50,
        failed: 0,
        held: 25,
        total: 100,
      }),
    ).toBe(50);
    expect(
      progressPct({
        status: "sent",
        sent: 90,
        failed: 10,
        held: 0,
        total: 100,
      }),
    ).toBe(100);
  });

  it("is 0 for an empty queue", () => {
    expect(
      progressPct({ status: "draft", sent: 0, failed: 0, held: 0, total: 0 }),
    ).toBe(0);
  });
});

/* ---------- typed errors ------------------------------------------------ */

describe("typed broadcast errors", () => {
  it("extracts the recipient cap from the server message", () => {
    expect(
      extractAudienceCap(
        "broadcast audience exceeds the per-broadcast cap of 5000 recipients (set SMS_BROADCAST_MAX_RECIPIENTS to raise it)",
      ),
    ).toBe(5000);
    expect(extractAudienceCap("something else")).toBeNull();
  });

  it("audience_too_large copy quotes the cap", () => {
    const msg = describeBroadcastError({
      code: "audience_too_large",
      message:
        "broadcast audience exceeds the per-broadcast cap of 5000 recipients (set SMS_BROADCAST_MAX_RECIPIENTS to raise it)",
    });
    expect(msg).toContain("5,000");
    expect(msg).toContain("cap");
  });

  it("audience_too_large with an unparseable message falls back verbatim", () => {
    expect(
      describeBroadcastError({
        code: "audience_too_large",
        message: "rewritten upstream",
      }),
    ).toBe("rewritten upstream");
  });

  it("explains no_consented_recipients in consent terms", () => {
    const msg = describeBroadcastError({
      code: "no_consented_recipients",
      message: "no opted-in, non-suppressed recipients found",
    });
    expect(msg).toContain("opted-in");
    expect(msg).toContain("suppressed");
  });

  it("covers the remaining typed codes and falls back to the message", () => {
    expect(
      describeBroadcastError({
        code: "sms_provider_unconfigured",
        message: "x",
      }),
    ).toContain("provider");
    expect(
      describeBroadcastError({
        code: "sms_broadcast_dispatch_release_held",
        message: "x",
      }),
    ).toContain("provider reconciliation and budget settlement");
    expect(
      describeBroadcastError({
        code: "sms_financial_reservation_unavailable",
        message: "x",
      }),
    ).toContain("financial reservation");
    expect(
      describeBroadcastError({
        code: "sms_dispatch_worker_unavailable",
        message: "x",
      }),
    ).toContain("worker identity");
    expect(
      describeBroadcastError({ code: "sender_paused", message: "x" }),
    ).toContain("paused");
    expect(
      describeBroadcastError({ code: "broadcast_sending", message: "x" }),
    ).toContain("cancel");
    expect(
      describeBroadcastError({ code: "invalid_audience", message: "x" }),
    ).toContain("exactly one");
    expect(
      describeBroadcastError({ code: "totally_unknown", message: "raw" }),
    ).toBe("raw");
    expect(describeBroadcastError(undefined)).toBeTruthy();
  });

  it("routes typed 422s onto the right composer field", () => {
    expect(fieldForBroadcastErrorCode("name_required")).toBe("name");
    expect(fieldForBroadcastErrorCode("body_required")).toBe("body");
    expect(fieldForBroadcastErrorCode("invalid_audience")).toBe("audience");
    expect(fieldForBroadcastErrorCode("audience_required")).toBe("audience");
    expect(fieldForBroadcastErrorCode("audience_too_large")).toBe("audience");
    expect(fieldForBroadcastErrorCode("sender_required")).toBe("sender");
    expect(fieldForBroadcastErrorCode("invalid_sender")).toBe("sender");
    expect(fieldForBroadcastErrorCode("anything_else")).toBe("_form");
    expect(fieldForBroadcastErrorCode(undefined)).toBe("_form");
  });
});

/* ---------- envelope unwrapping ----------------------------------------- */

describe("unwrapLists", () => {
  const rows = [{ id: 1, name: "VIP" }];

  it("walks the Listmonk unwrap ladder", () => {
    expect(unwrapLists({ data: { results: rows } })).toEqual(rows);
    expect(unwrapLists({ data: rows })).toEqual(rows);
    expect(unwrapLists({ items: rows })).toEqual(rows);
    expect(unwrapLists({ results: rows })).toEqual(rows);
    expect(unwrapLists({})).toEqual([]);
    expect(unwrapLists(undefined)).toEqual([]);
  });
});
