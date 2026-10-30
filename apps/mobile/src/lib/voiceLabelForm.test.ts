import { describe, expect, it } from "vitest";

import {
  normalizeVoiceLabelSample,
  parseVoiceLabelValue,
  voiceLabelPageSummary,
  voiceLabelsUnavailable,
} from "./voiceLabelForm";

describe("parseVoiceLabelValue", () => {
  it("accepts the inclusive 0..1 range", () => {
    expect(parseVoiceLabelValue("0")).toEqual({ ok: true, value: 0 });
    expect(parseVoiceLabelValue(" 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(parseVoiceLabelValue("1")).toEqual({ ok: true, value: 1 });
  });

  it("names the rule the operator actually broke", () => {
    expect(parseVoiceLabelValue("")).toMatchObject({
      ok: false,
      message: "Enter a strength between 0 and 1.",
    });
    const garbage = parseVoiceLabelValue("..");
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.message).toContain("isn't a number");
    expect(parseVoiceLabelValue("1.5")).toMatchObject({
      ok: false,
      message: "Strength runs from 0 (absent) to 1 (strong).",
    });
    expect(parseVoiceLabelValue("-0.2").ok).toBe(false);
  });
});

describe("normalizeVoiceLabelSample", () => {
  it("rejects whitespace-only text", () => {
    expect(normalizeVoiceLabelSample("   \n ")).toBeNull();
    expect(normalizeVoiceLabelSample(" hi ")).toBe("hi");
  });
});

describe("voiceLabelsUnavailable", () => {
  it("treats only 404/501 as a missing capability", () => {
    expect(voiceLabelsUnavailable(404)).toBe(true);
    expect(voiceLabelsUnavailable(501)).toBe(true);
    // A 500 or a 403 is a FAULT. Rendering it as "unavailable on this
    // deployment" tells the operator a lie about their gateway.
    expect(voiceLabelsUnavailable(500)).toBe(false);
    expect(voiceLabelsUnavailable(403)).toBe(false);
    expect(voiceLabelsUnavailable(undefined)).toBe(false);
  });
});

describe("voiceLabelPageSummary", () => {
  it("states the ratio and offers more when the server reports a total", () => {
    expect(voiceLabelPageSummary(25, 300)).toEqual({
      shown: 25,
      total: 300,
      hasMore: true,
      caption: "25 of 300",
    });
  });

  it("stops offering more once everything is loaded", () => {
    expect(voiceLabelPageSummary(12, 12)).toMatchObject({
      hasMore: false,
      caption: "12 of 12",
    });
  });

  it("never invents a total the server did not send", () => {
    expect(voiceLabelPageSummary(25, undefined)).toEqual({
      shown: 25,
      total: null,
      hasMore: false,
      caption: "25 loaded",
    });
    expect(voiceLabelPageSummary(25, "300")).toMatchObject({ total: null });
  });
});
