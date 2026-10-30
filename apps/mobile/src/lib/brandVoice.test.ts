import { describe, expect, it } from "vitest";

import {
  BRAND_VOICE_CAPS,
  brandVoiceDraftError,
  brandVoiceErrorMessage,
  normalizeBrandVoiceProfile,
  parseLineList,
  toLineList,
} from "./brandVoice";

describe("normalizeBrandVoiceProfile", () => {
  it("returns null for an absent row", () => {
    expect(normalizeBrandVoiceProfile(null)).toBeNull();
    expect(normalizeBrandVoiceProfile(undefined)).toBeNull();
  });

  it("treats a row with three empty arrays as empty, not as content", () => {
    const p = normalizeBrandVoiceProfile({
      id: "row-1",
      descriptors: [],
      writing_rules: null,
      sample_snippets: [],
    });
    expect(p).not.toBeNull();
    expect(p?.empty).toBe(true);
    expect(p?.descriptors).toEqual([]);
  });

  it("drops blank entries and trims the rest", () => {
    const p = normalizeBrandVoiceProfile({
      descriptors: ["  warm ", "", "   ", "direct"],
      writing_rules: ["Never shout"],
      sample_snippets: [],
    });
    expect(p?.descriptors).toEqual(["warm", "direct"]);
    expect(p?.writingRules).toEqual(["Never shout"]);
    expect(p?.empty).toBe(false);
  });

  it("ignores non-string array members instead of rendering 'undefined'", () => {
    const p = normalizeBrandVoiceProfile({
      descriptors: ["ok", 7, null, { a: 1 }] as unknown as string[],
    });
    expect(p?.descriptors).toEqual(["ok"]);
  });

  it("enforces the server's item and character caps", () => {
    const many = Array.from({ length: 40 }, (_, i) => `d${i}`);
    const p = normalizeBrandVoiceProfile({
      descriptors: many,
      writing_rules: ["x".repeat(BRAND_VOICE_CAPS.ruleChars + 50)],
    });
    expect(p?.descriptors).toHaveLength(BRAND_VOICE_CAPS.descriptors);
    expect(p?.writingRules[0]).toHaveLength(BRAND_VOICE_CAPS.ruleChars);
  });

  it("keeps updated_at only when it is a string", () => {
    expect(normalizeBrandVoiceProfile({ updated_at: "2026-01-01" })?.updatedAt)
      .toBe("2026-01-01");
    expect(
      normalizeBrandVoiceProfile({ updated_at: 5 as unknown as string })
        ?.updatedAt,
    ).toBeNull();
  });
});

describe("line list round trip", () => {
  it("drops blank lines so the round trip is idempotent", () => {
    const parsed = parseLineList("warm\n\n  direct  \n\n");
    expect(parsed).toEqual(["warm", "direct"]);
    expect(parseLineList(toLineList(parsed))).toEqual(parsed);
  });

  it("returns an empty list for whitespace-only input", () => {
    expect(parseLineList("   \n \n")).toEqual([]);
  });
});

describe("brandVoiceDraftError", () => {
  it("accepts a draft within caps", () => {
    expect(
      brandVoiceDraftError({ descriptors: ["warm"], writingRules: ["No ALL CAPS"] }),
    ).toBeNull();
  });

  it("names how many descriptors to remove", () => {
    const descriptors = Array.from({ length: 22 }, (_, i) => `d${i}`);
    expect(brandVoiceDraftError({ descriptors, writingRules: [] })).toBe(
      "Up to 20 descriptors. Remove 2.",
    );
  });

  it("names how many rules to remove", () => {
    const writingRules = Array.from({ length: 31 }, (_, i) => `r${i}`);
    expect(brandVoiceDraftError({ descriptors: [], writingRules })).toBe(
      "Up to 30 writing rules. Remove 1.",
    );
  });

  it("points at the 1-based index of an over-long descriptor", () => {
    expect(
      brandVoiceDraftError({
        descriptors: ["ok", "x".repeat(65)],
        writingRules: [],
      }),
    ).toBe("Descriptor 2 is longer than 64 characters.");
  });

  it("points at the 1-based index of an over-long rule", () => {
    expect(
      brandVoiceDraftError({
        descriptors: [],
        writingRules: ["ok", "y".repeat(513)],
      }),
    ).toBe("Writing rule 2 is longer than 512 characters.");
  });
});

describe("brandVoiceErrorMessage", () => {
  it("names a role problem for 403 rather than echoing the server", () => {
    expect(brandVoiceErrorMessage(403, "forbidden")).toContain("Ask an admin");
  });

  it("passes the server's validation text through for 422", () => {
    expect(brandVoiceErrorMessage(422, "descriptor too long")).toBe(
      "descriptor too long",
    );
  });

  it("calls an unmounted route unavailable rather than a fault", () => {
    expect(brandVoiceErrorMessage(501, "")).toContain("doesn't expose");
  });

  it("falls back to the transport message", () => {
    expect(brandVoiceErrorMessage(500, "boom")).toBe("boom");
    expect(brandVoiceErrorMessage(0, "")).toBe(
      "Couldn't save the authored brand voice.",
    );
  });
});
