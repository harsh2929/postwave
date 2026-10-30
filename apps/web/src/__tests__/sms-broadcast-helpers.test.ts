// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  buildSmsBroadcastUpsert,
  canCancelSmsBroadcast,
  canDeleteSmsBroadcast,
  canEditSmsBroadcast,
  emptySmsBroadcastForm,
  smsBroadcastAudienceSummary,
  smsBroadcastFieldForErrorCode,
  smsBroadcastFormFrom,
  smsBroadcastProgressPct,
  smsBroadcastSegmentInfo,
  validateSmsBroadcastForm,
} from "@/app/(dashboard)/app/sms/sms-broadcast-helpers";

describe("smsBroadcastSegmentInfo mirrors sms.SegmentCount", () => {
  it("counts GSM-7 septets and splits at 160 then 153", () => {
    expect(smsBroadcastSegmentInfo("   ")).toMatchObject({
      units: 0,
      segments: 0,
    });
    expect(smsBroadcastSegmentInfo("a".repeat(160))).toMatchObject({
      units: 160,
      segments: 1,
      encoding: "gsm7",
      remaining: 0,
    });
    expect(smsBroadcastSegmentInfo("a".repeat(161))).toMatchObject({
      units: 161,
      segments: 2,
      remaining: 306 - 161,
    });
    // Extension characters cost two septets; é is in the basic table.
    expect(smsBroadcastSegmentInfo("€é").units).toBe(3);
    expect(smsBroadcastSegmentInfo("€".repeat(80)).segments).toBe(1);
    expect(smsBroadcastSegmentInfo("€".repeat(81)).segments).toBe(2);
  });

  it("switches the whole body to UCS-2 units on any non-GSM character", () => {
    const info = smsBroadcastSegmentInfo("a".repeat(69) + "😀");
    expect(info.encoding).toBe("ucs2");
    // 69 + a surrogate pair (2 UTF-16 units) = 71 > 70 → two segments.
    expect(info.units).toBe(71);
    expect(info.segments).toBe(2);
  });
});

describe("broadcast form → upsert", () => {
  it("sends exactly one audience and clears the other two dimensions", () => {
    const form = {
      ...emptySmsBroadcastForm(),
      name: " Sale ",
      body: " Hi ",
      senderProfileId: " s1 ",
      audience: "segment" as const,
      listIds: ["l1"],
      segmentId: " seg ",
      tag: "vip",
    };
    expect(buildSmsBroadcastUpsert(form)).toEqual({
      name: "Sale",
      body: "Hi",
      sender_profile_id: "s1",
      list_ids: [],
      segment_id: "seg",
      tag: "",
      scheduled_at: null,
    });
    expect(
      buildSmsBroadcastUpsert({ ...form, audience: "tag" }),
    ).toMatchObject({ list_ids: [], segment_id: "", tag: "vip" });
    expect(
      buildSmsBroadcastUpsert({ ...form, audience: "lists" }),
    ).toMatchObject({ list_ids: ["l1"], segment_id: "", tag: "" });
  });

  it("round-trips a stored row and validates the server's rules up front", () => {
    const form = smsBroadcastFormFrom({
      id: "x",
      name: "Row",
      body: "Body",
      list_ids: [],
      tag: "vip",
      status: "draft",
      scheduled_at: null,
      sent_count: 0,
      failed_count: 0,
      held_count: 0,
      segments_per_message: 1,
      created_at: "",
      updated_at: "",
    });
    expect(form).toMatchObject({ audience: "tag", tag: "vip", listIds: [] });
    expect(validateSmsBroadcastForm(form)).toEqual({});
    expect(
      validateSmsBroadcastForm({ ...form, tag: "", body: "" }),
    ).toEqual({
      body: "Message body is required.",
      audience: "Enter a tag.",
    });
    expect(
      validateSmsBroadcastForm({ ...form, body: "a".repeat(153 * 10 + 1) })
        .body,
    ).toMatch(/capped at 10 segments/);
    expect(
      validateSmsBroadcastForm(
        { ...form, scheduledAtLocal: "2020-01-01T00:00" },
        new Date("2026-01-01T00:00:00Z"),
      ).schedule,
    ).toBe("Scheduled time must be in the future.");
  });
});

describe("status gates and summaries", () => {
  it("edits draft|scheduled, cancels scheduled|sending, deletes anything not sending", () => {
    expect(["draft", "scheduled", "sending", "sent", "cancelled"].map(
      (status) => [
        canEditSmsBroadcast(status),
        canCancelSmsBroadcast(status),
        canDeleteSmsBroadcast(status),
      ],
    )).toEqual([
      [true, false, true],
      [true, true, true],
      [false, true, false],
      [false, false, true],
      [false, false, true],
    ]);
  });

  it("summarises the audience honestly and routes server codes to fields", () => {
    expect(
      smsBroadcastAudienceSummary(
        { list_ids: ["aaaaaaaa-1", "bbbbbbbb-2"] },
        { lists: [{ id: "aaaaaaaa-1", name: "VIP" }] },
      ),
    ).toBe("2 lists: VIP, bbbbbbbb…");
    expect(smsBroadcastAudienceSummary({})).toBe("No audience yet");
    expect(smsBroadcastFieldForErrorCode("too_many_segments")).toBe("body");
    expect(smsBroadcastFieldForErrorCode("invalid_sender")).toBe("sender");
    expect(smsBroadcastFieldForErrorCode("broadcast_not_editable")).toBe(
      "_form",
    );
    expect(
      smsBroadcastProgressPct({ status: "sending", sent: 120, failed: 3, held: 7, total: 200 }),
    ).toBe(62);
  });
});
