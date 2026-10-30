// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for suppression reason metadata (node env).

import { describe, it, expect } from "vitest";

import {
  MANUAL_SUPPRESSION_REASONS,
  SUPPRESSION_REASON_LABELS,
  isSystemReason,
  reasonBadgeVariant,
  reasonLabel,
} from "@/lib/suppression-reasons";

describe("reasonBadgeVariant", () => {
  it("maps severe deliverability failures to destructive", () => {
    for (const r of [
      "hard_bounce",
      "spam_complaint",
      "spamtrap",
      "dns_failure",
      "invalid_address",
    ]) {
      expect(reasonBadgeVariant(r)).toBe("destructive");
    }
  });

  it("maps soft bounce to warning", () => {
    expect(reasonBadgeVariant("soft_bounce")).toBe("warning");
  });

  it("maps manual/unknown/empty reasons to secondary", () => {
    expect(reasonBadgeVariant("list_manual")).toBe("secondary");
    expect(reasonBadgeVariant("manual_unsubscribe")).toBe("secondary");
    expect(reasonBadgeVariant("something_new")).toBe("secondary");
    expect(reasonBadgeVariant(undefined)).toBe("secondary");
    expect(reasonBadgeVariant("")).toBe("secondary");
  });

  it("is case-insensitive", () => {
    expect(reasonBadgeVariant("HARD_BOUNCE")).toBe("destructive");
  });
});

describe("reasonLabel", () => {
  it("returns the human label for a known reason", () => {
    expect(reasonLabel("hard_bounce")).toBe("Hard bounce");
  });
  it("falls back to the raw value for an unknown reason", () => {
    expect(reasonLabel("weird_reason")).toBe("weird_reason");
  });
  it("returns an em-dash for empty", () => {
    expect(reasonLabel(undefined)).toBe("—");
    expect(reasonLabel("")).toBe("—");
  });
});

describe("MANUAL_SUPPRESSION_REASONS", () => {
  it("excludes pipeline-only reasons", () => {
    for (const r of MANUAL_SUPPRESSION_REASONS) {
      expect(isSystemReason(r)).toBe(false);
    }
    expect(MANUAL_SUPPRESSION_REASONS).not.toContain("hard_bounce");
    expect(MANUAL_SUPPRESSION_REASONS).not.toContain("spam_complaint");
    expect(MANUAL_SUPPRESSION_REASONS).not.toContain("soft_bounce");
  });

  it("only lists reasons that have labels", () => {
    for (const r of MANUAL_SUPPRESSION_REASONS) {
      expect(SUPPRESSION_REASON_LABELS[r]).toBeTruthy();
    }
  });
});

describe("isSystemReason", () => {
  it("is true for pipeline reasons only", () => {
    expect(isSystemReason("hard_bounce")).toBe(true);
    expect(isSystemReason("soft_bounce")).toBe(true);
    expect(isSystemReason("list_manual")).toBe(false);
    expect(isSystemReason(undefined)).toBe(false);
  });
});
