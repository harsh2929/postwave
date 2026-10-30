import { describe, expect, it } from "vitest";

import { segmentInfo } from "./smsSegments";

describe("segmentInfo", () => {
  it("costs nothing for an empty message", () => {
    const info = segmentInfo("");
    expect(info.segments).toBe(0);
    expect(info.showCounter).toBe(false);
  });

  it("is one GSM segment up to 160 characters", () => {
    expect(segmentInfo("a".repeat(160)).segments).toBe(1);
    expect(segmentInfo("a".repeat(160)).unicode).toBe(false);
  });

  it("rolls to two segments at 161 characters (concatenated segments are 153)", () => {
    const info = segmentInfo("a".repeat(161));
    expect(info.segments).toBe(2);
    expect(info.remaining).toBe(306 - 161);
  });

  it("charges GSM extension characters two septets each", () => {
    // 159 plain + one '€' (2 septets) = 161 septets → two segments.
    const info = segmentInfo(`${"a".repeat(159)}€`);
    expect(info.segments).toBe(2);
    expect(info.unicode).toBe(false);
  });

  it("drops the whole message to UCS-2 when one character leaves the GSM set", () => {
    const info = segmentInfo(`${"a".repeat(100)}😀`);
    expect(info.unicode).toBe(true);
    // 100 units + a 2-unit surrogate pair = 102 → ceil(102/67) = 2.
    expect(info.segments).toBe(2);
  });

  it("counts an emoji as one character but two UTF-16 units", () => {
    const info = segmentInfo("😀");
    expect(info.characters).toBe(1);
    expect(info.unicode).toBe(true);
    expect(info.segments).toBe(1);
    expect(info.remaining).toBe(68);
  });

  it("is one UCS-2 segment up to 70 units", () => {
    expect(segmentInfo(`é${"a".repeat(69)}`).segments).toBe(1);
  });

  it("treats a curly quote pasted from a document as unicode", () => {
    // U+2019 is not in the GSM 03.38 set, which is the classic surprise.
    expect(segmentInfo("don’t").unicode).toBe(true);
  });

  it("keeps the accented characters that ARE in the GSM set on 160", () => {
    expect(segmentInfo("Grüße aus Köln").unicode).toBe(false);
  });

  it("hides the counter for a short plain reply and shows it for a long one", () => {
    expect(segmentInfo("thanks!").showCounter).toBe(false);
    expect(segmentInfo("a".repeat(40)).showCounter).toBe(true);
  });

  it("always shows the counter once the message went unicode, however short", () => {
    expect(segmentInfo("👍").showCounter).toBe(true);
  });

  it("never reports negative remaining capacity", () => {
    expect(segmentInfo("a".repeat(5000)).remaining).toBeGreaterThanOrEqual(0);
  });
});
