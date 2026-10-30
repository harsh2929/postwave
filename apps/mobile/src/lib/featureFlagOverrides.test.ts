import { describe, expect, it } from "vitest";

import {
  FLAG_KEY_MAX,
  FLAG_VALUE_MAX,
  emptyFlagDraft,
  flagDraftDirty,
  flagDraftFromRow,
  flagUpsertBody,
  overrideRemovalConsequence,
  validateFlagDraft,
} from "./featureFlagOverrides";

describe("flagDraftFromRow", () => {
  it("copies key, value and note from a workspace override", () => {
    expect(
      flagDraftFromRow({
        key: "new_composer",
        value: "on",
        note: "Beta cohort",
        enabled: true,
        isDefault: false,
      }),
    ).toEqual({ key: "new_composer", value: "on", note: "Beta cohort" });
  });

  it("does not carry a platform default's note into a workspace override", () => {
    expect(
      flagDraftFromRow({
        key: "new_composer",
        value: "off",
        note: "Platform-wide until GA",
        enabled: true,
        isDefault: true,
      }),
    ).toEqual({ key: "new_composer", value: "off", note: "" });
  });
});

describe("validateFlagDraft", () => {
  it("accepts a trimmed key and value", () => {
    expect(
      validateFlagDraft({ key: " new_composer ", value: " on ", note: "" }),
    ).toBeNull();
  });

  it("requires a key", () => {
    expect(validateFlagDraft({ key: "  ", value: "on", note: "" })).toEqual({
      key: "Flag key is required.",
    });
  });

  it("refuses whitespace inside a key — DELETE /{key} could not address it", () => {
    expect(validateFlagDraft({ key: "new composer", value: "on", note: "" })).toEqual(
      { key: "Flag key can’t contain spaces." },
    );
  });

  it("mirrors the server's 200-character caps", () => {
    expect(
      validateFlagDraft({ key: "k".repeat(FLAG_KEY_MAX), value: "on", note: "" }),
    ).toBeNull();
    expect(
      validateFlagDraft({
        key: "k".repeat(FLAG_KEY_MAX + 1),
        value: "v".repeat(FLAG_VALUE_MAX + 1),
        note: "",
      }),
    ).toEqual({
      key: "Flag key is too long (max 200 characters).",
      value: "Value is too long (max 200 characters).",
    });
  });

  it("requires a value — the server 400s bad_value on an empty one", () => {
    expect(validateFlagDraft({ key: "k", value: "   ", note: "" })).toEqual({
      value: "A value is required — “on” or “off” for a simple switch.",
    });
  });
});

describe("flagUpsertBody", () => {
  it("trims every field the way the server does", () => {
    expect(
      flagUpsertBody({ key: " new_composer ", value: " on ", note: " why " }),
    ).toEqual({ key: "new_composer", value: "on", note: "why" });
  });
});

describe("flagDraftDirty", () => {
  it("ignores whitespace-only edits", () => {
    const initial = { key: "k", value: "on", note: "" };
    expect(flagDraftDirty({ ...initial, note: "  " }, initial)).toBe(false);
    expect(flagDraftDirty({ ...initial, note: "why" }, initial)).toBe(true);
    expect(flagDraftDirty(emptyFlagDraft(), emptyFlagDraft())).toBe(false);
  });
});

describe("overrideRemovalConsequence", () => {
  it("is desktop's sentence, verbatim", () => {
    expect(overrideRemovalConsequence("new_composer")).toBe(
      '"new_composer" falls back to its platform default (or to missing if no default exists). The default row is untouched.',
    );
  });
});
