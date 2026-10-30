// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  hasRatingSignal,
  ratingWidthPercent,
} from "@/components/mailchimp-parity/audience-intelligence-panel";

describe("AudienceIntelligencePanel helpers", () => {
  it("normalizes rating bars against the largest bucket", () => {
    expect(ratingWidthPercent(0, 500)).toBe(0);
    expect(ratingWidthPercent(4, 500)).toBe(5);
    expect(ratingWidthPercent(250, 500)).toBe(50);
    expect(ratingWidthPercent(500, 500)).toBe(100);
    expect(ratingWidthPercent(50_000, 50_000)).toBe(100);
    expect(ratingWidthPercent(500, 50_000)).toBe(5);
  });

  it("treats a zero-filled ratings map as no signal (empty state)", () => {
    expect(hasRatingSignal([])).toBe(false);
    expect(
      hasRatingSignal([
        ["1", 0],
        ["2", 0],
        ["3", 0],
        ["4", 0],
        ["5", 0],
      ]),
    ).toBe(false);
    expect(
      hasRatingSignal([
        ["1", 0],
        ["5", 3],
      ]),
    ).toBe(true);
  });
});
