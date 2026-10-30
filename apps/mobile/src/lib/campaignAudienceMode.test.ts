/**
 * Audience mode + freeze: the mode read defaults safe (dynamic), the freeze
 * result is read defensively, and the 422 codes render as product rules —
 * never as generic failures.
 */
import { describe, expect, it } from "vitest";

import {
  audienceModeHelp,
  campaignAudienceMode,
  freezeErrorMessage,
  readFreezeResult,
} from "./campaignAudienceMode";

describe("campaignAudienceMode", () => {
  it("is static only when the record says static", () => {
    expect(campaignAudienceMode({ audience_mode: "static" })).toBe("static");
    expect(campaignAudienceMode({ audience_mode: "dynamic" })).toBe("dynamic");
    expect(campaignAudienceMode({})).toBe("dynamic");
    expect(campaignAudienceMode(null)).toBe("dynamic");
    expect(campaignAudienceMode({ audience_mode: 42 })).toBe("dynamic");
  });

  it("the help copy distinguishes the two modes", () => {
    expect(audienceModeHelp("static")).not.toBe(audienceModeHelp("dynamic"));
  });
});

describe("readFreezeResult", () => {
  it("reads frozen_members from the server's {ok, frozen_members}", () => {
    expect(readFreezeResult({ ok: true, frozen_members: 1234 })).toEqual({
      frozenMembers: 1234,
    });
  });
  it("answers 0 for junk instead of NaN-ing the toast", () => {
    expect(readFreezeResult(null)).toEqual({ frozenMembers: 0 });
    expect(readFreezeResult({ frozen_members: -3 })).toEqual({
      frozenMembers: 0,
    });
  });
});

describe("freezeErrorMessage — the 422s are product rules", () => {
  it("explains freeze_requires_segment in words", () => {
    expect(freezeErrorMessage("freeze_requires_segment", "fallback")).toMatch(
      /workspace-wide/,
    );
  });
  it("explains segment_not_found", () => {
    expect(freezeErrorMessage("segment_not_found", "fallback")).toMatch(
      /no longer exists/,
    );
  });
  it("passes unknown codes through to the fallback", () => {
    expect(freezeErrorMessage("weird", "fallback")).toBe("fallback");
    expect(freezeErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
