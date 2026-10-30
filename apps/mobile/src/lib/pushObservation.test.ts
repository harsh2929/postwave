import { describe, expect, it } from "vitest";

import {
  boundedHealthDuration,
  MAX_PUSH_HEALTH_DURATION_MS,
  pushErrorCode,
} from "./pushObservation";

describe("pushErrorCode", () => {
  it("maps each status class to the remedy it implies", () => {
    expect(pushErrorCode({ status: 401 })).toBe("authorization");
    expect(pushErrorCode({ status: 403 })).toBe("authorization");
    expect(pushErrorCode({ status: 429 })).toBe("rate_limit");
    expect(pushErrorCode({ status: 500 })).toBe("server");
    expect(pushErrorCode({ status: 503 })).toBe("server");
  });

  it("buckets a 4xx that is not an auth or rate problem as client-side", () => {
    expect(pushErrorCode({ status: 400 })).toBe("native_or_network");
    expect(pushErrorCode({ status: 404 })).toBe("native_or_network");
  });

  it("never lets the exception text become the reported code", () => {
    // The whole point of the bucket: a push-stack error message can carry an
    // Expo token, a device name, or a URL with a session in it.
    const leaky = new Error(
      "failed for ExponentPushToken[abc123] on Harsh's iPhone",
    );
    expect(pushErrorCode(leaky)).toBe("native_or_network");
    expect(pushErrorCode("ExponentPushToken[abc123]")).toBe("native_or_network");
    expect(pushErrorCode(null)).toBe("native_or_network");
    expect(pushErrorCode(undefined)).toBe("native_or_network");
  });

  it("ignores a non-numeric status rather than trusting its shape", () => {
    expect(pushErrorCode({ status: "401" })).toBe("native_or_network");
    expect(pushErrorCode({ status: { code: 500 } })).toBe("native_or_network");
  });
});

describe("boundedHealthDuration", () => {
  it("measures an ordinary elapsed window", () => {
    expect(boundedHealthDuration(1_000, 3_500)).toBe(2_500);
  });

  it("clamps a clock that jumped backwards to zero, never negative", () => {
    // NTP correction / timezone change / the user setting the date. A negative
    // duration poisons every percentile it lands in.
    expect(boundedHealthDuration(9_000, 1_000)).toBe(0);
  });

  it("clamps an absurd forward jump to a single day", () => {
    expect(boundedHealthDuration(0, 30 * 24 * 60 * 60 * 1000)).toBe(
      MAX_PUSH_HEALTH_DURATION_MS,
    );
  });

  it("reports zero rather than NaN when a clock reading is unusable", () => {
    expect(boundedHealthDuration(Number.NaN, 1_000)).toBe(0);
    expect(boundedHealthDuration(1_000, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
