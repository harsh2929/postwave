// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  RESEND_COOLDOWN_SECONDS,
  remainingCooldownSeconds,
} from "@/lib/resend-cooldown";

describe("remainingCooldownSeconds", () => {
  it("returns the full duration at the start", () => {
    const endsAt = 1_000 + RESEND_COOLDOWN_SECONDS * 1000;
    expect(remainingCooldownSeconds(1_000, endsAt)).toBe(RESEND_COOLDOWN_SECONDS);
  });
  it("clamps to zero at and past the end", () => {
    expect(remainingCooldownSeconds(31_000, 31_000)).toBe(0);
    expect(remainingCooldownSeconds(31_001, 31_000)).toBe(0);
  });
  it("rounds up partial seconds so it never flashes 0 prematurely", () => {
    expect(remainingCooldownSeconds(1_500, 31_000)).toBe(30);
    expect(remainingCooldownSeconds(30_500, 31_000)).toBe(1);
  });
});
