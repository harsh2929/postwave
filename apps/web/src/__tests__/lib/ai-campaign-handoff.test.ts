// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAiCampaignHandoff,
  setAiCampaignHandoff,
  takeAiCampaignHandoff,
} from "@/lib/ai-campaign-handoff";

afterEach(() => {
  clearAiCampaignHandoff();
  vi.useRealTimers();
});

describe("memory-only AI campaign handoff", () => {
  it("normalizes, deduplicates, and consumes a handoff exactly once", () => {
    setAiCampaignHandoff({
      mode: "ab_test",
      name: "  Launch  ",
      subject: "Primary",
      bodyHtml: "  <p>Draft</p>  ",
      subjectVariants: ["primary", " Alternative ", "ALTERNATIVE"],
    });

    expect(takeAiCampaignHandoff()).toMatchObject({
      mode: "ab_test",
      name: "Launch",
      subject: "Primary",
      bodyHtml: "<p>Draft</p>",
      subjectVariants: ["Primary", "Alternative"],
    });
    expect(takeAiCampaignHandoff()).toBeNull();
  });

  it("requires two distinct subjects for an A/B handoff", () => {
    expect(() =>
      setAiCampaignHandoff({
        mode: "ab_test",
        subject: "Same",
        subjectVariants: [" same "],
      }),
    ).toThrow(/two distinct subjects/iu);
  });

  it("expires confidential draft material after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T10:00:00Z"));
    setAiCampaignHandoff({ mode: "draft", subject: "Private draft" });
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(takeAiCampaignHandoff()).toBeNull();
  });

  it("never writes the handoff to browser storage", () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    setAiCampaignHandoff({ mode: "draft", subject: "Memory only" });
    expect(local).not.toHaveBeenCalled();
  });
});
