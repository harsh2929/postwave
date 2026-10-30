// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { OTP_LENGTH, isOtpComplete, sanitizeOtp } from "@/lib/otp";

describe("sanitizeOtp", () => {
  it("strips non-digits", () => {
    expect(sanitizeOtp("12a3 4-5")).toBe("12345");
  });
  it("clamps to the OTP length", () => {
    expect(sanitizeOtp("1234567890")).toBe("123456");
    expect(sanitizeOtp("1234567890").length).toBe(OTP_LENGTH);
  });
  it("passes through an empty string", () => {
    expect(sanitizeOtp("")).toBe("");
  });
});

describe("isOtpComplete", () => {
  it("is true only for exactly six digits", () => {
    expect(isOtpComplete("123456")).toBe(true);
    expect(isOtpComplete("12345")).toBe(false);
    expect(isOtpComplete("1234567")).toBe(false);
  });
  it("is false for non-digit content", () => {
    expect(isOtpComplete("12345a")).toBe(false);
  });
});
