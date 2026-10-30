// Tests for the pure logic behind the Consent-Safe Activation Firewall
// preview UI (feature #2). The honest-UI invariants are load-bearing: a
// -1 sentinel must render "—" / "unavailable", NEVER "0 excluded"; the
// will-sync math must never fabricate a difference when an input is
// unknown; and the purpose disclosure must echo the server string, never
// invent a label.

import { describe, expect, it } from "vitest";

import type { SyncExclusionPreview } from "../lib/consent-firewall-helpers";
import {
  COUNT_UNAVAILABLE,
  exclusionBreakdown,
  excludedTotal,
  formatCount,
  isPreviewUnavailable,
  purposeDisclosure,
  purposeLabel,
  runButtonLabel,
  shouldConfirmRun,
  willSyncCount,
} from "../lib/consent-firewall-helpers";

function preview(over: Partial<SyncExclusionPreview> = {}): SyncExclusionPreview {
  return {
    audience_count: 100,
    excluded_consent: 8,
    excluded_suppression: 4,
    excluded_total: 12,
    purpose: "targeted_ads",
    computed_at: "2026-06-15T00:00:00Z",
    ...over,
  };
}

describe("isPreviewUnavailable", () => {
  it("is false for a resolved audience", () => {
    expect(isPreviewUnavailable(preview())).toBe(false);
  });
  it("is true when audience_count is the -1 sentinel", () => {
    expect(isPreviewUnavailable(preview({ audience_count: COUNT_UNAVAILABLE }))).toBe(
      true,
    );
  });
});

describe("formatCount", () => {
  it("renders the -1 sentinel as an em dash, never 0", () => {
    expect(formatCount(COUNT_UNAVAILABLE)).toBe("—");
  });
  it("renders missing/non-finite as an em dash, never 0", () => {
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(null)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });
  it("groups real counts", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(12345)).toBe((12345).toLocaleString());
  });
});

describe("excludedTotal", () => {
  it("returns the total when available", () => {
    expect(excludedTotal(preview({ excluded_total: 12 }))).toBe(12);
  });
  it("returns 0 for a real zero (knowable answer)", () => {
    expect(excludedTotal(preview({ excluded_total: 0 }))).toBe(0);
  });
  it("returns null (not 0) when the preview is unavailable", () => {
    expect(
      excludedTotal(preview({ audience_count: COUNT_UNAVAILABLE })),
    ).toBeNull();
  });
  it("returns null when the total itself is the sentinel", () => {
    expect(excludedTotal(preview({ excluded_total: COUNT_UNAVAILABLE }))).toBeNull();
  });
});

describe("willSyncCount", () => {
  it("computes audience minus excluded", () => {
    expect(willSyncCount(preview({ audience_count: 100, excluded_total: 12 }))).toBe(
      88,
    );
  });
  it("never goes negative", () => {
    expect(
      willSyncCount(preview({ audience_count: 5, excluded_total: 12 })),
    ).toBe(0);
  });
  it("returns null when unavailable rather than a fabricated difference", () => {
    expect(
      willSyncCount(preview({ audience_count: COUNT_UNAVAILABLE })),
    ).toBeNull();
  });
});

describe("runButtonLabel", () => {
  it("is the plain verb when count is zero", () => {
    expect(runButtonLabel(preview({ excluded_total: 0 }))).toBe("Run now");
  });
  it("is the plain verb when preview is null", () => {
    expect(runButtonLabel(null)).toBe("Run now");
  });
  it("is the plain verb when count is unavailable (never −0)", () => {
    expect(runButtonLabel(preview({ audience_count: COUNT_UNAVAILABLE }))).toBe(
      "Run now",
    );
  });
  it("appends the count when positive", () => {
    expect(runButtonLabel(preview({ excluded_total: 12 }))).toBe(
      "Run now (−12 excluded)",
    );
  });
  it("honours a custom verb", () => {
    expect(runButtonLabel(preview({ excluded_total: 3 }), "Sync now")).toBe(
      "Sync now (−3 excluded)",
    );
  });
});

describe("shouldConfirmRun", () => {
  it("confirms only when there is a non-zero count to disclose", () => {
    expect(shouldConfirmRun(preview({ excluded_total: 12 }))).toBe(true);
  });
  it("skips the confirm step on a zero count (no friction)", () => {
    expect(shouldConfirmRun(preview({ excluded_total: 0 }))).toBe(false);
  });
  it("skips the confirm step when the preview failed (advisory, not a gate)", () => {
    expect(shouldConfirmRun(null)).toBe(false);
    expect(shouldConfirmRun(preview({ audience_count: COUNT_UNAVAILABLE }))).toBe(
      false,
    );
  });
});

describe("purposeLabel", () => {
  it("maps known purposes to friendly copy", () => {
    expect(purposeLabel("targeted_ads")).toBe("targeted ads");
    expect(purposeLabel("email_marketing")).toBe("email marketing");
    expect(purposeLabel("profiling")).toBe("profiling");
  });
  it("falls back to the raw server string for unknown enums", () => {
    expect(purposeLabel("some_new_purpose")).toBe("some_new_purpose");
    expect(purposeLabel("")).toBe("unknown");
  });
});

describe("purposeDisclosure", () => {
  it("includes the destination parenthetical when supplied", () => {
    expect(purposeDisclosure(preview({ purpose: "targeted_ads" }), "meta")).toBe(
      "Purpose: targeted ads (meta destination)",
    );
  });
  it("omits the parenthetical when no destination given", () => {
    expect(purposeDisclosure(preview({ purpose: "profiling" }))).toBe(
      "Purpose: profiling",
    );
  });
});

describe("exclusionBreakdown", () => {
  it("renders both components", () => {
    expect(
      exclusionBreakdown(preview({ excluded_consent: 8, excluded_suppression: 4 })),
    ).toBe("(8 by consent · 4 by suppression)");
  });
  it("renders only the non-zero component", () => {
    expect(
      exclusionBreakdown(preview({ excluded_consent: 8, excluded_suppression: 0 })),
    ).toBe("(8 by consent)");
  });
  it("is empty when nothing to break down", () => {
    expect(
      exclusionBreakdown(preview({ excluded_consent: 0, excluded_suppression: 0 })),
    ).toBe("");
  });
  it("treats negative sentinels as unknown and omits them", () => {
    expect(
      exclusionBreakdown(
        preview({ excluded_consent: COUNT_UNAVAILABLE, excluded_suppression: COUNT_UNAVAILABLE }),
      ),
    ).toBe("");
  });
});
