/**
 * Pure-logic tests for the Trigger delay preferences card (#29).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_DELAY_SECONDS,
  MAX_TRIGGER_DELAY_EVENT_NAME_BYTES,
  MAX_TRIGGER_DELAY_REASON_BYTES,
  delayLookupErrors,
  fmtConfidence,
  fmtDelay,
  parseDelaySeconds,
  triggerDelayReasonError,
  utf8ByteLength,
} from "../../components/automations/trigger-delay-helpers";

describe("delayLookupErrors", () => {
  it("requires both keys of the pair", () => {
    expect(
      Object.keys(
        delayLookupErrors({ subscriberId: "", eventName: "" }),
      ).sort(),
    ).toEqual(["eventName", "subscriberId"]);
    expect(
      delayLookupErrors({ subscriberId: "  ", eventName: "cart.abandoned" }),
    ).toEqual({ subscriberId: "Subscriber ID is required" });
    expect(
      delayLookupErrors({ subscriberId: "sub_1", eventName: "evt" }),
    ).toEqual({ subscriberId: "Subscriber ID must be a canonical UUID" });
    expect(
      delayLookupErrors({
        subscriberId: "11111111-1111-4111-8111-111111111111",
        eventName: "evt",
      }),
    ).toEqual({});
  });

  it("applies the server's UTF-8 byte bound to event names", () => {
    const subscriberId = "11111111-1111-4111-8111-111111111111";
    expect(
      delayLookupErrors({
        subscriberId,
        eventName: "a".repeat(MAX_TRIGGER_DELAY_EVENT_NAME_BYTES),
      }),
    ).toEqual({});
    expect(
      delayLookupErrors({
        subscriberId,
        eventName: "é".repeat(MAX_TRIGGER_DELAY_EVENT_NAME_BYTES / 2 + 1),
      }),
    ).toEqual({ eventName: "Event name must be 256 bytes or fewer" });
  });
});

describe("triggerDelayReasonError", () => {
  it("counts UTF-8 bytes rather than JavaScript code units", () => {
    expect(utf8ByteLength("é")).toBe(2);
    expect(
      triggerDelayReasonError("a".repeat(MAX_TRIGGER_DELAY_REASON_BYTES)),
    ).toBeNull();
    expect(
      triggerDelayReasonError(
        "é".repeat(MAX_TRIGGER_DELAY_REASON_BYTES / 2 + 1),
      ),
    ).toBe("Operator reason must be 500 bytes or fewer");
  });
});

describe("parseDelaySeconds", () => {
  it("accepts the full server-validated range, 0 included", () => {
    expect(parseDelaySeconds("0")).toEqual({ ok: true, seconds: 0 });
    expect(parseDelaySeconds(` ${MAX_DELAY_SECONDS} `)).toEqual({
      ok: true,
      seconds: MAX_DELAY_SECONDS,
    });
  });

  it("rejects empty, fractional, negative, and out-of-range values", () => {
    expect(parseDelaySeconds("").ok).toBe(false);
    expect(parseDelaySeconds("1.5").ok).toBe(false);
    expect(parseDelaySeconds("-1").ok).toBe(false);
    expect(parseDelaySeconds(String(MAX_DELAY_SECONDS + 1)).ok).toBe(false);
    expect(parseDelaySeconds("abc").ok).toBe(false);
  });

  it("mirrors the 30-day bound in the error copy", () => {
    const r = parseDelaySeconds(String(MAX_DELAY_SECONDS + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/30 days/);
  });
});

describe("fmtDelay", () => {
  it("says 'immediately' for zero", () => {
    expect(fmtDelay(0)).toBe("immediately");
  });

  it("humanizes mixed units and keeps the raw seconds", () => {
    expect(fmtDelay(5400)).toBe("1h 30m (5,400s)");
    expect(fmtDelay(90061)).toBe("1d 1h 1m 1s (90,061s)");
    expect(fmtDelay(45)).toBe("45s (45s)");
  });

  it("returns a dash for invalid input", () => {
    expect(fmtDelay(-3)).toBe("—");
    expect(fmtDelay(Number.NaN)).toBe("—");
  });
});

describe("fmtConfidence", () => {
  it("scales the 0..1 wire range to a percent", () => {
    expect(fmtConfidence(0)).toBe("0%");
    expect(fmtConfidence(0.42)).toBe("42%");
    expect(fmtConfidence(1)).toBe("100%");
  });

  it("passes values already > 1 through without double-scaling", () => {
    expect(fmtConfidence(87)).toBe("87%");
  });

  it("returns a dash for invalid input", () => {
    expect(fmtConfidence(-0.1)).toBe("—");
    expect(fmtConfidence(Number.NaN)).toBe("—");
  });
});
