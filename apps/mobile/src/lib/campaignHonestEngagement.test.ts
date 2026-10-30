import { describe, expect, it } from "vitest";

import {
  aiSurfacingBucket,
  readHonestEngagement,
} from "./campaignHonestEngagement";

/**
 * The wire shape a STOCK deployment returns for GET /campaigns/{id}/engagement
 * (apps/api/internal/analytics/engagement.go): POSTWAVE_HUMAN_ENGAGEMENT is
 * off by default, so the human fields are ZEROED next to real raw numbers and
 * `bot_signatures_applied` is Go's nil slice — `null` on the wire.
 */
function flagOffPanel() {
  return {
    campaign_id: "c1",
    classification_filter: "all",
    delivered: 980,
    human_unique_opens: 0,
    human_open_rate: 0,
    raw_open_rate: 0.52,
    reply_count: 0,
    distinct_replyers: 0,
    reply_rate: 0,
    open_decoupled_conversions: 0,
    total_attributed_conversions: 0,
    bot_signatures_applied: null,
    ai_surfacing_score: 0.31,
    ai_surfacing_basis: null,
    ai_surfacing_confidence_level: "low",
    ai_surfacing_sample_opens: 510,
  };
}

function flagOnPanel() {
  return {
    ...flagOffPanel(),
    human_unique_opens: 372,
    human_open_rate: 0.38,
    reply_count: 14,
    distinct_replyers: 12,
    reply_rate: 0.0122,
    open_decoupled_conversions: 3,
    total_attributed_conversions: 9,
    bot_signatures_applied: ["Apple Mail Privacy Protection", "Gmail image proxy"],
    ai_surfacing_score: 0.62,
    ai_surfacing_basis: ["human_open_rate", "reply_rate", "hard_bounce_rate"],
    ai_surfacing_confidence_level: "ok",
    ai_surfacing_sample_opens: 372,
  };
}

describe("readHonestEngagement — shape", () => {
  it("is null for anything that is not a panel object", () => {
    expect(readHonestEngagement(undefined)).toBeNull();
    expect(readHonestEngagement(null)).toBeNull();
    expect(readHonestEngagement("nope")).toBeNull();
    expect(readHonestEngagement([flagOnPanel()])).toBeNull();
  });

  it("survives Go's nil slices arriving as null and junk entries", () => {
    const view = readHonestEngagement({
      ...flagOnPanel(),
      bot_signatures_applied: [null, 7, "  ", "Apple Mail Privacy Protection"],
      ai_surfacing_basis: null,
    });
    expect(view?.notes).toContain("Stripped: Apple Mail Privacy Protection");
    expect(view?.aiSurfacing?.basis).toBeNull();
    expect(readHonestEngagement(flagOffPanel())?.mode).toBe("raw");
  });
});

describe("readHonestEngagement — the human/raw split", () => {
  it("shows the RAW rate, never a 0% human rate, when bot filtering is off", () => {
    // The lie this module exists to prevent: the server zeroes the human
    // fields when filtering is off, so 0 beside 52% is "never measured", not
    // "nobody human opened it" and not "52 points of machines".
    const view = readHonestEngagement(flagOffPanel());
    expect(view?.mode).toBe("raw");
    const labels = view?.rows.map((r) => r.label);
    expect(labels).toContain("Open rate");
    expect(labels).not.toContain("Human open rate");
    expect(labels).not.toContain("Machine inflation");
    expect(view?.rows.find((r) => r.key === "raw")?.value).toBe("52.0%");
    expect(view?.rows.find((r) => r.key === "raw")?.detail).toBe(
      "bot filtering not enabled — showing raw rate",
    );
    // The wire cannot tell "flag off" from "flag on, zero signal", so the
    // headline states what was measured, not the deployment's config.
    expect(view?.headline).toBe(
      "52.0% of 980 delivered were opened. No human/machine split was measured for this send, so this is the raw rate.",
    );
    expect(JSON.stringify(view)).not.toContain("0.0%");
  });

  it("splits human from raw and states the inflation in POINTS when filtering is on", () => {
    const view = readHonestEngagement(flagOnPanel());
    expect(view?.mode).toBe("human");
    expect(view?.rows.find((r) => r.key === "human")?.value).toBe("38.0%");
    expect(view?.rows.find((r) => r.key === "raw")?.value).toBe("52.0%");
    // (0.52 − 0.38) × 100 — from the two wire rates, nothing else.
    expect(view?.rows.find((r) => r.key === "inflation")?.value).toBe("14.0 pts");
    expect(view?.headline).toBe(
      "38.0% of 980 delivered were opened by a person; the raw rate is 52.0%.",
    );
    expect(view?.notes).toContain(
      "Stripped: Apple Mail Privacy Protection, Gmail image proxy",
    );
  });

  it("treats a fired signature with zero human opens as measured, not as off", () => {
    const view = readHonestEngagement({
      ...flagOffPanel(),
      bot_signatures_applied: ["Apple Mail Privacy Protection"],
    });
    expect(view?.mode).toBe("human");
    expect(view?.rows.find((r) => r.key === "inflation")?.value).toBe("52.0 pts");
  });

  it("clamps a stripped rate that came out HIGHER than raw to 0 points", () => {
    const view = readHonestEngagement({
      ...flagOnPanel(),
      human_open_rate: 0.55,
      raw_open_rate: 0.52,
    });
    const inflation = view?.rows.find((r) => r.key === "inflation");
    expect(inflation?.value).toBe("0.0 pts");
    expect(inflation?.detail).toBe("The raw and human open rates agree");
  });
});

describe("readHonestEngagement — no denominator, no rate", () => {
  it("prints no open rate at all when nothing was delivered", () => {
    // engagement.go guards its divisions and sends 0 for both rates; a 0%
    // open rate over zero deliveries is an invented denominator.
    const view = readHonestEngagement({
      ...flagOffPanel(),
      delivered: 0,
      raw_open_rate: 0,
    });
    expect(view?.headline).toBe(
      "No delivered recipients have been recorded for this send, so open rates can't be computed yet.",
    );
    expect(view?.rows.map((r) => r.key)).toEqual(["replies", "conversions"]);
    expect(JSON.stringify(view?.rows)).not.toContain("%");
    // Filtering on changes nothing: a measured split still has no denominator.
    expect(
      readHonestEngagement({ ...flagOnPanel(), delivered: 0 })?.rows.map(
        (r) => r.key,
      ),
    ).toEqual(["replies", "conversions"]);
  });

  it("shows replies as a COUNT, not a 0.0% rate, when nobody replied", () => {
    const row = readHonestEngagement(flagOffPanel())?.rows.find(
      (r) => r.key === "replies",
    );
    expect(row?.label).toBe("Replies");
    expect(row?.value).toBe("0");
    expect(row?.detail).toBe("No replies recorded for this send");
  });

  it("shows a reply RATE only when the server computed one over real repliers", () => {
    const withRate = readHonestEngagement(flagOnPanel())?.rows.find(
      (r) => r.key === "replies",
    );
    expect(withRate?.label).toBe("Reply rate");
    expect(withRate?.value).toBe("1.2%");
    expect(withRate?.detail).toBe("12 people replied · 14 replies");

    // Replies recorded but the recipient denominator was unavailable → 0 rate
    // on the wire, which is not a rate.
    const noRate = readHonestEngagement({
      ...flagOnPanel(),
      reply_rate: 0,
    })?.rows.find((r) => r.key === "replies");
    expect(noRate?.label).toBe("Replies");
    expect(noRate?.value).toBe("14");
    expect(noRate?.detail).toBe("Reply rate not reported for this send");
  });

  it("states open-decoupled conversions against the attributed total", () => {
    const row = readHonestEngagement(flagOnPanel())?.rows.find(
      (r) => r.key === "conversions",
    );
    expect(row?.label).toBe("Acted without an open");
    expect(row?.value).toBe("3 of 9");

    const none = readHonestEngagement(flagOffPanel())?.rows.find(
      (r) => r.key === "conversions",
    );
    expect(none?.label).toBe("Attributed conversions");
    expect(none?.value).toBe("0");
    expect(none?.detail).toBe("No attributed conversions yet");
  });
});

describe("readHonestEngagement — the AI-surfacing estimate", () => {
  it("withholds the number and renders the server's qualifier on LOW confidence", () => {
    // engagement.go:96 — "low" means the sample is too small to trust the
    // estimate. The same rule as the deliverability score: an unqualified
    // sample is not a number.
    const ai = readHonestEngagement(flagOffPanel())?.aiSurfacing;
    expect(ai?.kind).toBe("insufficient");
    if (ai?.kind !== "insufficient") throw new Error("expected insufficient");
    expect(ai.reason).toBe(
      "Estimate not shown: the server rates its confidence low (510 opens analysed).",
    );
    expect(ai.reason).not.toContain("31%");
    expect(ai.basis).toBeNull();
  });

  it("renders the bucket, score, confidence, sample and basis when the server trusts it", () => {
    const ai = readHonestEngagement(flagOnPanel())?.aiSurfacing;
    expect(ai?.kind).toBe("scored");
    if (ai?.kind !== "scored") throw new Error("expected scored");
    expect(ai.bucket).toBe("Moderate");
    expect(ai.score).toBe("62%");
    expect(ai.confidence).toBe("ok");
    expect(ai.sample).toBe("372 opens analysed");
    expect(ai.basis).toBe("Based on human open rate, reply rate, hard-bounce rate");
  });

  it("passes an unknown basis key through rather than dropping it", () => {
    const ai = readHonestEngagement({
      ...flagOnPanel(),
      ai_surfacing_basis: ["reply_rate", "some_new_signal"],
    })?.aiSurfacing;
    expect(ai?.basis).toBe("Based on reply rate, some_new_signal");
  });

  it("is null when the payload carries no score at all", () => {
    const { ai_surfacing_score: _dropped, ...rest } = flagOnPanel();
    expect(readHonestEngagement(rest)?.aiSurfacing).toBeNull();
  });

  it("buckets at desktop's thresholds", () => {
    expect(aiSurfacingBucket(0)).toBe("Low");
    expect(aiSurfacingBucket(0.39)).toBe("Low");
    expect(aiSurfacingBucket(0.4)).toBe("Moderate");
    expect(aiSurfacingBucket(0.69)).toBe("Moderate");
    expect(aiSurfacingBucket(0.7)).toBe("High");
    expect(aiSurfacingBucket(1)).toBe("High");
  });
});

describe("readHonestEngagement — the classification band", () => {
  it("says nothing for the default band and names any other", () => {
    expect(readHonestEngagement(flagOnPanel())?.notes).not.toContainEqual(
      expect.stringContaining("classification band"),
    );
    const human = readHonestEngagement({
      ...flagOnPanel(),
      classification_filter: "human",
    });
    expect(human?.notes).toContain(
      'Opens and clicks counted under the "human" classification band.',
    );
  });
});
