/**
 * POST /api/v1/send-window/check — verdict parse, tone, the one line under the
 * picker, and the minute-truncated query instant.
 *
 * The dangerous regression is the silent one: a parser that stops recognising
 * `should` returns null, the sheet says nothing, and a schedule the policy
 * will BLOCK reads as fine until the send fails after the fact — the exact
 * discovery-after-the-fact this seam exists to remove.
 */
import { describe, expect, it } from "vitest";

import {
  parseSendWindowVerdict,
  sendWindowCheckInstant,
  sendWindowLine,
  sendWindowTone,
} from "./sendWindowVerdict";

describe("parseSendWindowVerdict", () => {
  it("reads the send_window.go Verdict shape", () => {
    const verdict = parseSendWindowVerdict({
      inside_window: false,
      enforcement: "block",
      should: "block",
      reason: "outside 09:00–17:00 Europe/Stockholm",
    });
    expect(verdict).toEqual({
      insideWindow: false,
      enforcement: "block",
      should: "block",
      reason: "outside 09:00–17:00 Europe/Stockholm",
    });
  });

  it("returns null — the sheet then says nothing — on junk", () => {
    expect(parseSendWindowVerdict({ should: "maybe" })).toBeNull();
    expect(parseSendWindowVerdict(null)).toBeNull();
  });
});

describe("the line under the picker", () => {
  it("block reads as a blocked send, with the policy's reason", () => {
    const verdict = parseSendWindowVerdict({
      inside_window: false,
      enforcement: "block",
      should: "block",
      reason: "weekends excluded",
    })!;
    expect(sendWindowTone(verdict)).toBe("danger");
    const line = sendWindowLine(verdict);
    expect(line).toContain("would be blocked");
    expect(line).toContain("weekends excluded");
  });

  it("warn says it will still send", () => {
    const verdict = parseSendWindowVerdict({
      inside_window: false,
      enforcement: "warn",
      should: "warn",
    })!;
    expect(sendWindowTone(verdict)).toBe("warning");
    expect(sendWindowLine(verdict)).toContain("It will still send.");
  });

  it("inside an enforced window is said; no policy stays silent", () => {
    const enforced = parseSendWindowVerdict({
      inside_window: true,
      enforcement: "warn",
      should: "allow",
    })!;
    expect(sendWindowLine(enforced)).toBe(
      "Inside your workspace's send window.",
    );
    const none = parseSendWindowVerdict({
      inside_window: true,
      enforcement: "off",
      should: "allow",
    })!;
    expect(sendWindowLine(none)).toBeNull();
  });
});

describe("sendWindowCheckInstant", () => {
  it("truncates to the minute so a settling wheel shares one query key", () => {
    expect(
      sendWindowCheckInstant(new Date("2026-08-29T10:15:42.913Z")),
    ).toBe("2026-08-29T10:15:00.000Z");
  });
  it("is null for an invalid date", () => {
    expect(sendWindowCheckInstant(new Date(Number.NaN))).toBeNull();
  });
});
