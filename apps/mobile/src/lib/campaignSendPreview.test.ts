import { describe, expect, it } from "vitest";

import {
  audienceKindLabel,
  audienceLabel,
  campaignAudienceHeadline,
  previewCount,
  previewCountLabel,
  sendPreviewReachesNobody,
  summarizeSendPreview,
} from "./campaignSendPreview";

describe("previewCount", () => {
  it("treats the -1 sentinel as unavailable, not zero", () => {
    expect(previewCount(-1)).toBeNull();
    expect(previewCountLabel(-1)).toBe("—");
  });

  it("preserves a genuine measured zero", () => {
    expect(previewCount(0)).toBe(0);
    expect(previewCountLabel(0)).toBe("0");
  });

  it("rejects non-numeric and non-finite values", () => {
    expect(previewCount(undefined)).toBeNull();
    expect(previewCount(Number.NaN)).toBeNull();
    expect(previewCount("500")).toBeNull();
  });
});

describe("audienceLabel", () => {
  it("prefers the resolved segment label over the kind", () => {
    expect(
      audienceLabel({ audience_kind: "segment", segment_label: "VIPs" }),
    ).toBe("VIPs");
  });

  it("falls back to the audience kind", () => {
    expect(audienceLabel({ audience_kind: "list" })).toBe("A list");
    expect(audienceLabel({ audience_kind: "workspace" })).toContain("workspace");
  });

  it("never claims an audience it cannot prove", () => {
    expect(audienceLabel(null)).toBe("Not resolved yet");
    expect(audienceLabel({})).toBe("Not resolved yet");
  });

  it("qualifies the kind separately", () => {
    expect(audienceKindLabel({ audience_kind: "segment" })).toBe("Segment");
    expect(audienceKindLabel({ audience_kind: "list" })).toBe("List");
    expect(audienceKindLabel({})).toBeNull();
  });
});

describe("summarizeSendPreview", () => {
  it("states recipients, suppressions and cap in one sentence", () => {
    const s = summarizeSendPreview({
      recipients: 12697,
      suppressed_excluded: 214,
      deliverable: 12483,
      tier_cap_remaining: 40000,
      over_cap: false,
    });
    expect(s.sentence).toContain("12,483 recipients");
    expect(s.sentence).toContain("214 suppressed");
    expect(s.sentence).toContain("within today's cap");
    expect(s.capWarning).toBeNull();
  });

  it("derives deliverable when the server omits it", () => {
    const s = summarizeSendPreview({
      recipients: 100,
      suppressed_excluded: 10,
      deliverable: -1,
    });
    expect(s.deliverable).toBe(90);
  });

  it("keeps deliverable unavailable when nothing can be derived", () => {
    const s = summarizeSendPreview({
      recipients: -1,
      suppressed_excluded: -1,
      deliverable: -1,
    });
    expect(s.deliverable).toBeNull();
    expect(s.sentence).toContain("unavailable");
  });

  it("omits the suppression clause when nothing was suppressed", () => {
    const s = summarizeSendPreview({ recipients: 5, suppressed_excluded: 0 });
    expect(s.sentence).not.toContain("suppressed");
  });

  it("does not claim 'within cap' when the cap is unknown", () => {
    const s = summarizeSendPreview({ recipients: 5, tier_cap_remaining: -1 });
    expect(s.sentence).not.toContain("cap");
  });

  it("raises an explicit warning when the send is over cap", () => {
    const s = summarizeSendPreview({
      recipients: 90000,
      deliverable: 90000,
      tier_cap_remaining: 2000,
      over_cap: true,
    });
    expect(s.overCap).toBe(true);
    expect(s.capWarning).toContain("2,000");
    expect(s.sentence).toContain("over today's sending cap");
  });

  it("warns without a number when the remaining cap is unavailable", () => {
    const s = summarizeSendPreview({
      recipients: 9,
      tier_cap_remaining: -1,
      over_cap: true,
    });
    expect(s.capWarning).toContain("held until tomorrow");
  });

  it("uses the singular for one recipient", () => {
    expect(summarizeSendPreview({ recipients: 1, deliverable: 1 }).sentence).toContain(
      "1 recipient",
    );
  });
});

describe("sendPreviewReachesNobody", () => {
  it("is true only when the audience is provably empty", () => {
    expect(sendPreviewReachesNobody({ recipients: 0, deliverable: 0 })).toBe(true);
    expect(sendPreviewReachesNobody({ recipients: -1, deliverable: -1 })).toBe(false);
    expect(sendPreviewReachesNobody(null)).toBe(false);
    expect(sendPreviewReachesNobody({ recipients: 3, deliverable: 3 })).toBe(false);
  });
});

describe("campaignAudienceHeadline", () => {
  const base = { preview: null, loading: false, unavailable: false };

  it("never claims 'no list or segment' when the read did not answer", () => {
    // THE BUG. A workspace-wide campaign carries neither list_id nor
    // segment_id, so a 500 — or airplane mode, which stops the query running
    // at all — printed "Not set — this campaign has no list or segment"
    // directly above Send. The inverse of "Everyone in the workspace",
    // asserted from a lack of signal.
    const line = campaignAudienceHeadline({ ...base, unavailable: true });
    expect(line).not.toContain("no list or segment");
    expect(line).toContain("Couldn't be read");
  });

  it("still says 'not set' when the read genuinely answered", () => {
    // The counterweight: without this the assertion above passes for a screen
    // that never states the honest empty case at all.
    expect(campaignAudienceHeadline(base)).toBe(
      "Not set — this campaign has no list or segment",
    );
  });

  it("prefers a resolved preview over every fallback", () => {
    expect(
      campaignAudienceHeadline({
        ...base,
        unavailable: true,
        preview: { audience_kind: "workspace" },
      }),
    ).toBe("Everyone in the workspace");
  });

  it("keeps the id fallback, which is proof an audience is set", () => {
    // A failed read does not erase what the campaign row already told us.
    expect(
      campaignAudienceHeadline({ ...base, unavailable: true, segmentId: "s1" }),
    ).toContain("A segment");
    expect(
      campaignAudienceHeadline({ ...base, unavailable: true, listId: "l1" }),
    ).toContain("A list");
  });

  it("says it is still resolving before it says anything else", () => {
    expect(campaignAudienceHeadline({ ...base, loading: true })).toBe(
      "Resolving…",
    );
  });
});
