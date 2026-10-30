import { describe, expect, it } from "vitest";

import {
  subscriberAvatarHue,
  subscriberInitials,
  subscriberName,
  subscriberPrimaryLabel,
  subscriberSecondaryLabel,
} from "./subscriberIdentity";

describe("subscriberName", () => {
  it("prefers full_name, then display_name, then first+last", () => {
    expect(
      subscriberName({
        full_name: "Ada Lovelace",
        display_name: "ada",
        first_name: "Augusta",
      }),
    ).toBe("Ada Lovelace");
    expect(subscriberName({ display_name: "ada", first_name: "Augusta" })).toBe(
      "ada",
    );
    expect(subscriberName({ first_name: "Augusta", last_name: "King" })).toBe(
      "Augusta King",
    );
  });

  it("treats whitespace-only and null fields as absent", () => {
    expect(
      subscriberName({ full_name: "   ", display_name: null, first_name: "" }),
    ).toBe("");
  });

  it("composes from a first name alone", () => {
    expect(subscriberName({ first_name: "Grace" })).toBe("Grace");
  });
});

describe("subscriberPrimaryLabel / subscriberSecondaryLabel", () => {
  it("promotes the name and demotes the email", () => {
    const row = { email: "ada@example.com", full_name: "Ada Lovelace" };
    expect(subscriberPrimaryLabel(row)).toBe("Ada Lovelace");
    expect(subscriberSecondaryLabel(row)).toBe("ada@example.com");
  });

  it("never renders the email twice when there is no name", () => {
    const row = { email: "ada@example.com" };
    expect(subscriberPrimaryLabel(row)).toBe("ada@example.com");
    expect(subscriberSecondaryLabel(row)).toBe("");
  });

  it("degrades to empty for a record with nothing at all", () => {
    expect(subscriberPrimaryLabel({})).toBe("");
    expect(subscriberSecondaryLabel({})).toBe("");
  });
});

describe("subscriberInitials", () => {
  it("uses first + last initial", () => {
    expect(subscriberInitials({ full_name: "Ada Lovelace" })).toBe("AL");
  });

  it("uses one initial for a single-word name", () => {
    expect(subscriberInitials({ full_name: "Prince" })).toBe("P");
  });

  it("skips the middle name and uses the last part", () => {
    expect(subscriberInitials({ full_name: "Ada Byron King Lovelace" })).toBe(
      "AL",
    );
  });

  it("falls back to the email's first character", () => {
    expect(subscriberInitials({ email: "zoe@example.com" })).toBe("Z");
  });

  it("never returns blank", () => {
    expect(subscriberInitials({})).toBe("?");
    expect(subscriberInitials({ email: "   " })).toBe("?");
  });

  it("counts an astral-plane glyph as one character", () => {
    // Naive `name[0]` returns half a surrogate pair and renders as ▯.
    expect(subscriberInitials({ full_name: "𝒜da Lovelace" })).toBe("𝒜L");
  });
});

describe("subscriberAvatarHue", () => {
  it("is stable for the same email", () => {
    expect(subscriberAvatarHue({ email: "ada@example.com" })).toBe(
      subscriberAvatarHue({ email: "ada@example.com" }),
    );
  });

  it("ignores case so a re-cased address keeps its colour", () => {
    expect(subscriberAvatarHue({ email: "Ada@Example.com" })).toBe(
      subscriberAvatarHue({ email: "ada@example.com" }),
    );
  });

  it("does not move when the display name changes", () => {
    expect(
      subscriberAvatarHue({ email: "ada@example.com", full_name: "Ada L" }),
    ).toBe(
      subscriberAvatarHue({
        email: "ada@example.com",
        full_name: "Augusta King",
      }),
    );
  });

  it("always produces a legal hue, including for an empty record", () => {
    for (const row of [
      {},
      { email: "" },
      { email: "a@b.c" },
      { full_name: "Zed" },
    ]) {
      const hue = subscriberAvatarHue(row);
      expect(Number.isFinite(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("spreads a realistic address book across the wheel", () => {
    const hues = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((c) =>
        subscriberAvatarHue({ email: `${c}@example.com` }),
      ),
    );
    // Not a strict guarantee, but a degenerate hash (e.g. summing char
    // codes) collapses these onto ~2 values.
    expect(hues.size).toBeGreaterThanOrEqual(6);
  });
});
