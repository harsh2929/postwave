/**
 * The wire contract of a first-party lookalike audience.
 *
 * These tests pin the four parsing decisions that would each produce a
 * confident lie on screen if they regressed:
 *
 *  1. An ABSENT count is null, not zero. The columns are NOT NULL server-side,
 *     so a genuine 0 is a real measurement ("this model matched nobody") and a
 *     missing field is a different claim entirely. Collapsing them makes an
 *     unparsed row look like an empty audience.
 *  2. An UNRECOGNISED status is null, and the raw string survives. Anything
 *     that coerced it to "ready" would render a half-built audience as
 *     finished, which is the one failure this whole surface exists to avoid.
 *  3. The bands histogram is three independently-nullable numbers. A partial
 *     histogram must not be silently completed with zeroes, because the missing
 *     band is exactly the one a reader would draw a conclusion from.
 *  4. `pii_included` is echoed, never inferred from an empty members array.
 *     "No members" and "members withheld" are different sentences and only one
 *     of them means the audience is empty.
 */
import { describe, expect, it } from "vitest";

import {
  bandOf,
  lookalikeName,
  LOOKALIKE_BAND_HIGH_MIN,
  LOOKALIKE_BAND_MEDIUM_MIN,
  parseLookalikeAudience,
  parseLookalikeAudienceList,
  parseLookalikeMember,
  parseLookalikeMemberPage,
} from "./lookalikeAudiences";

/** A row shaped exactly as `scanLookalikeAudience` writes it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "look-1",
    name: "Buyers lookalike",
    seed_segment_id: "seg-1",
    size_requested: 5000,
    member_count: 4120,
    seed_count: 812,
    confidence_threshold: 0.6,
    model_version: "first-party-v1",
    status: "ready",
    exported_destination_id: null,
    payload: {
      seed_count: 812,
      candidate_count: 41_000,
      scored: 4120,
      feature_dims: ["email_domain", "signup_source", "engagement", "retention"],
      bands: { high: 900, medium: 2200, low: 1020 },
      data_use_acknowledged: true,
      data_use_notice_version: "first-party-lookalike-v1",
    },
    error: "",
    created_at: "2026-07-01T09:00:00Z",
    updated_at: "2026-07-01T09:00:00Z",
    ...overrides,
  };
}

describe("parsing one lookalike audience header", () => {
  it("reads the header and flattens the payload stats onto it", () => {
    const parsed = parseLookalikeAudience(row());

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe("look-1");
    expect(parsed?.memberCount).toBe(4120);
    expect(parsed?.sizeRequested).toBe(5000);
    expect(parsed?.seedCount).toBe(812);
    expect(parsed?.candidateCount).toBe(41_000);
    expect(parsed?.scored).toBe(4120);
    expect(parsed?.bands).toEqual({ high: 900, medium: 2200, low: 1020 });
    expect(parsed?.featureDims).toContain("signup_source");
    expect(parsed?.dataUseNoticeVersion).toBe("first-party-lookalike-v1");
  });

  it("returns null for a row with no id rather than an unidentifiable entry", () => {
    expect(parseLookalikeAudience({ name: "orphan" })).toBeNull();
    expect(parseLookalikeAudience(null)).toBeNull();
    expect(parseLookalikeAudience([])).toBeNull();
  });

  it("keeps a MISSING count null and a genuine zero zero", () => {
    const missing = parseLookalikeAudience(row({ member_count: undefined }));
    const empty = parseLookalikeAudience(row({ member_count: 0 }));

    expect(missing?.memberCount).toBeNull();
    expect(empty?.memberCount).toBe(0);
  });

  it("refuses to recognise a status outside the CHECK set, and keeps the raw", () => {
    const parsed = parseLookalikeAudience(row({ status: "materialising" }));

    // Null, NOT coerced to "ready" — that coercion would present a half-built
    // audience as finished.
    expect(parsed?.status).toBeNull();
    expect(parsed?.rawStatus).toBe("materialising");
  });

  it("recognises every state the migration's CHECK admits", () => {
    for (const status of ["pending", "running", "ready", "failed"]) {
      expect(parseLookalikeAudience(row({ status }))?.status).toBe(status);
    }
  });

  it("treats a partial bands histogram as partly UNKNOWN, never as zeroes", () => {
    const parsed = parseLookalikeAudience(
      row({ payload: { bands: { high: 12 } } }),
    );

    expect(parsed?.bands.high).toBe(12);
    expect(parsed?.bands.medium).toBeNull();
    expect(parsed?.bands.low).toBeNull();
  });

  it("survives a payload that is absent, null or the wrong type", () => {
    for (const payload of [undefined, null, "nope", 42, []]) {
      const parsed = parseLookalikeAudience(row({ payload }));
      expect(parsed?.bands).toEqual({ high: null, medium: null, low: null });
      expect(parsed?.candidateCount).toBeNull();
      expect(parsed?.featureDims).toEqual([]);
    }
  });

  it("falls back to the payload's seed_count when the column is absent", () => {
    const parsed = parseLookalikeAudience(
      row({ seed_count: undefined, payload: { seed_count: 77 } }),
    );
    expect(parsed?.seedCount).toBe(77);
  });

  it("carries an export association as a nullable id, never as a boolean", () => {
    expect(parseLookalikeAudience(row())?.exportedDestinationId).toBeNull();
    expect(
      parseLookalikeAudience(row({ exported_destination_id: "dest-9" }))
        ?.exportedDestinationId,
    ).toBe("dest-9");
  });
});

describe("parsing the catalogue envelope", () => {
  it("reads the {items} envelope ListLookalikes actually sends", () => {
    expect(parseLookalikeAudienceList({ items: [row()] })).toHaveLength(1);
  });

  it("also reads a bare array, so an envelope change cannot blank the screen", () => {
    expect(parseLookalikeAudienceList([row()])).toHaveLength(1);
  });

  it("drops unparseable rows instead of rendering placeholders", () => {
    expect(
      parseLookalikeAudienceList({ items: [row(), { name: "no id" }, null] }),
    ).toHaveLength(1);
  });

  it("reads an unexpected shape as an empty list rather than throwing", () => {
    expect(parseLookalikeAudienceList(undefined)).toEqual([]);
    expect(parseLookalikeAudienceList("nope")).toEqual([]);
  });
});

describe("parsing one ranked member", () => {
  const member = {
    subscriber_id: "sub-1",
    email: "a@example.test",
    similarity_score: 0.9123,
    rank: 1,
    features: {
      "domain:example.test": 1,
      "source:checkout": 1,
      engagement: 0.82,
      retention: 0.71,
    },
  };

  it("pulls the two numeric features out of the feature vector", () => {
    const parsed = parseLookalikeMember(member);

    expect(parsed?.engagement).toBe(0.82);
    expect(parsed?.retention).toBe(0.71);
  });

  it("names the one-hot dimensions the member SHARES with the seed", () => {
    const parsed = parseLookalikeMember(member);

    expect(parsed?.matchedDomain).toBe("example.test");
    expect(parsed?.matchedSource).toBe("checkout");
  });

  it("reads an absent one-hot key as 'not shared', not as a missing person", () => {
    // `vectorize` only emits domain:/source: when the SEED exhibits the value,
    // so absence says something about the SEED, not about the subscriber.
    const parsed = parseLookalikeMember({
      ...member,
      features: { engagement: 0.4, retention: 0.5 },
    });

    expect(parsed?.matchedDomain).toBeNull();
    expect(parsed?.matchedSource).toBeNull();
    expect(parsed?.engagement).toBe(0.4);
  });

  it("returns null without a subscriber id", () => {
    expect(parseLookalikeMember({ email: "a@b.test" })).toBeNull();
  });
});

describe("parsing the member page", () => {
  it("echoes the server's pii_included rather than inferring it", () => {
    const withheld = parseLookalikeMemberPage({
      audience: row(),
      members: [],
      page: 1,
      per_page: 25,
      pii_included: false,
    });

    // Empty AND withheld — the screen must be able to tell that apart from an
    // audience that genuinely has no members.
    expect(withheld.members).toEqual([]);
    expect(withheld.piiIncluded).toBe(false);
  });

  it("reads a hydrated page with its members and paging", () => {
    const page = parseLookalikeMemberPage({
      audience: row(),
      members: [
        { subscriber_id: "s-1", email: "a@b.test", similarity_score: 0.9, rank: 1, features: {} },
      ],
      page: 1,
      per_page: 25,
      pii_included: true,
    });

    expect(page.members).toHaveLength(1);
    expect(page.piiIncluded).toBe(true);
    expect(page.perPage).toBe(25);
    expect(page.audience?.id).toBe("look-1");
  });

  it("never reports pii_included true off a truthy-but-wrong value", () => {
    expect(
      parseLookalikeMemberPage({ members: [], pii_included: "true" })
        .piiIncluded,
    ).toBe(false);
  });
});

describe("similarity bands", () => {
  it("uses the server's own 0.8 / 0.5 edges", () => {
    expect(bandOf(LOOKALIKE_BAND_HIGH_MIN)).toBe("high");
    expect(bandOf(0.79)).toBe("medium");
    expect(bandOf(LOOKALIKE_BAND_MEDIUM_MIN)).toBe("medium");
    expect(bandOf(0.49)).toBe("low");
  });

  it("says nothing about a member with no score", () => {
    expect(bandOf(null)).toBeNull();
  });
});

describe("naming a model", () => {
  it("never renders an empty name as an empty string", () => {
    const parsed = parseLookalikeAudience(row({ name: "   " }));
    expect(lookalikeName(parsed!)).toBe("Untitled lookalike");
  });
});
