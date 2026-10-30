// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  entries,
  metric,
  pct,
  statusVariant,
} from "@/components/mailchimp-parity/product-panel-primitives";

describe("Mailchimp parity product panel primitives", () => {
  it("maps known status buckets to badge variants", () => {
    expect(statusVariant("ready")).toBe("success");
    expect(statusVariant("FAILED")).toBe("destructive");
    expect(statusVariant("requires_setup")).toBe("warning");
    expect(statusVariant("metadata")).toBe("secondary");
    expect(statusVariant("unexpected")).toBe("outline");
  });

  it("formats metric and percentage values with stable fallbacks", () => {
    expect(metric(1200)).toBe("1,200");
    expect(metric("custom")).toBe("custom");
    expect(metric("", "none")).toBe("none");
    expect(pct(0.482)).toBe("48%");
    expect(pct("0.5")).toBe("0%");
  });

  it("omits nullish record entries without dropping falsy values", () => {
    expect(entries({ a: 0, b: false, c: "", d: null, e: undefined })).toEqual([
      ["a", 0],
      ["b", false],
      ["c", ""],
    ]);
  });
});
