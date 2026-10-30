import { describe, expect, it } from "vitest";

import {
  limitRunes,
  runeLength,
  TAG_NAME_MAX_RUNES,
  validateTagDraft,
} from "./tagInput";

describe("runeLength", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(runeLength("abc")).toBe(3);
    // "👍".length === 2 in JS; Go's utf8.RuneCountInString says 1.
    expect(runeLength("👍")).toBe(1);
    expect(runeLength("é")).toBe(1);
  });

  it("is zero for the empty string", () => {
    expect(runeLength("")).toBe(0);
  });
});

describe("limitRunes", () => {
  it("leaves short values untouched", () => {
    expect(limitRunes("vip", 10)).toBe("vip");
  });

  it("truncates on a rune boundary, never mid-surrogate", () => {
    const truncated = limitRunes("👍👍👍", 2);
    expect(truncated).toBe("👍👍");
    expect(runeLength(truncated)).toBe(2);
    // A naive slice(0, 2) would return "👍" only by luck and
    // slice(0, 3) would produce a lone surrogate.
    expect(truncated.includes("�")).toBe(false);
  });

  it("defaults to the server's rune ceiling", () => {
    const long = "a".repeat(200);
    expect(runeLength(limitRunes(long))).toBe(TAG_NAME_MAX_RUNES);
  });
});

describe("validateTagDraft", () => {
  it("refuses an empty draft silently (no scolding hint)", () => {
    expect(validateTagDraft("", [])).toEqual({
      code: "empty",
      hint: null,
      canAdd: false,
    });
    expect(validateTagDraft("   ", [])).toEqual({
      code: "empty",
      hint: null,
      canAdd: false,
    });
  });

  it("catches an over-long paste before the round trip", () => {
    const result = validateTagDraft("x".repeat(65), []);
    expect(result.code).toBe("too_long");
    expect(result.canAdd).toBe(false);
    expect(result.hint).toContain("65");
  });

  it("accepts exactly the server's maximum", () => {
    expect(validateTagDraft("x".repeat(64), []).code).toBe("ok");
  });

  it("measures the over-long check in runes", () => {
    // 64 emoji = 128 UTF-16 units but exactly 64 runes: the server accepts
    // it, so we must too.
    expect(validateTagDraft("👍".repeat(64), []).code).toBe("ok");
    expect(validateTagDraft("👍".repeat(65), []).code).toBe("too_long");
  });

  it("detects a case-insensitive duplicate against the current tags", () => {
    const result = validateTagDraft(" VIP ", ["vip", "beta"]);
    expect(result.code).toBe("duplicate");
    expect(result.canAdd).toBe(false);
    expect(result.hint).toMatch(/already/i);
  });

  it("tolerates an absent tag array", () => {
    expect(validateTagDraft("vip", undefined).canAdd).toBe(true);
  });

  it("reports length before duplication so the worse problem wins", () => {
    const tag = "x".repeat(70);
    expect(validateTagDraft(tag, [tag]).code).toBe("too_long");
  });
});
