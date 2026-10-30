import { describe, expect, it } from "vitest";

// These helpers used to live in src/hooks/useCampaigns.ts. That module now
// transitively imports react-native (through lib/connectivity, for the
// offline snapshot) and therefore cannot be loaded in the node environment at
// all — mocking @/api/client was never going to be enough. The pure policy now
// lives in an import-free module and is imported directly.
import {
  CAMPAIGN_PAGE_SIZE,
  campaignLifecycleActions,
  isDraftCampaignStatus,
  isValidTestEmail,
  nextCampaignPage,
  resendSummaryMessage,
} from "../lib/campaignPolicy";

describe("campaign pagination", () => {
  it("requests another page only after a full server page", () => {
    const full = Array.from({ length: CAMPAIGN_PAGE_SIZE }, (_, index) => ({
      id: String(index),
    }));
    expect(nextCampaignPage(full, [full])).toBe(2);
    expect(
      nextCampaignPage(full.slice(0, 5), [full.slice(0, 5)]),
    ).toBeUndefined();
  });
});

describe("campaignLifecycleActions", () => {
  it("matches the backend transition states", () => {
    expect(campaignLifecycleActions("scheduled")).toEqual(["pause", "cancel"]);
    expect(campaignLifecycleActions("sending")).toEqual(["pause", "cancel"]);
    expect(campaignLifecycleActions("paused")).toEqual(["resume", "cancel"]);
    expect(campaignLifecycleActions("draft")).toEqual(["cancel"]);
    expect(campaignLifecycleActions("sent")).toEqual([]);
  });
});

describe("isDraftCampaignStatus", () => {
  it("only allows draft campaigns to be deleted from mobile", () => {
    expect(isDraftCampaignStatus("draft")).toBe(true);
    expect(isDraftCampaignStatus("DRAFT")).toBe(true);
    expect(isDraftCampaignStatus(undefined)).toBe(false);
    expect(isDraftCampaignStatus("scheduled")).toBe(false);
    expect(isDraftCampaignStatus("sending")).toBe(false);
    expect(isDraftCampaignStatus("sent")).toBe(false);
    expect(isDraftCampaignStatus("paused")).toBe(false);
    expect(isDraftCampaignStatus("cancelled")).toBe(false);
  });
});

describe("isValidTestEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidTestEmail("me@example.com")).toBe(true);
    expect(isValidTestEmail("a.b+tag@sub.example.co")).toBe(true);
    expect(isValidTestEmail("  trimmed@example.com  ")).toBe(true);
  });

  it("rejects empty / blank input", () => {
    expect(isValidTestEmail(undefined)).toBe(false);
    expect(isValidTestEmail(null)).toBe(false);
    expect(isValidTestEmail("")).toBe(false);
    expect(isValidTestEmail("   ")).toBe(false);
  });

  it("rejects obvious typos", () => {
    expect(isValidTestEmail("noatsign.com")).toBe(false);
    expect(isValidTestEmail("@example.com")).toBe(false);
    expect(isValidTestEmail("me@")).toBe(false);
    expect(isValidTestEmail("me@localhost")).toBe(false); // no dot in domain
    expect(isValidTestEmail("me@example.")).toBe(false); // trailing dot
    expect(isValidTestEmail("two@@example.com")).toBe(false);
    expect(isValidTestEmail("has space@example.com")).toBe(false);
  });

  it("rejects absurdly long input", () => {
    expect(isValidTestEmail(`${"a".repeat(250)}@example.com`)).toBe(false);
  });
});

describe("resendSummaryMessage", () => {
  it("reports the queued recipient count, pluralised", () => {
    expect(
      resendSummaryMessage({ recipients_queued: 12, non_openers_total: 12 }),
    ).toContain("12 non-openers");
  });

  it("uses the singular form for exactly one recipient", () => {
    const msg = resendSummaryMessage({
      recipients_queued: 1,
      non_openers_total: 1,
    });
    expect(msg).toContain("1 non-opener.");
    expect(msg).not.toContain("non-openers");
  });

  it("falls back to non_openers_total when queued count is absent", () => {
    expect(
      resendSummaryMessage({
        recipients_queued: undefined as unknown as number,
        non_openers_total: 5,
      }),
    ).toContain("5 non-openers");
  });

  it("reads cleanly when there are no non-openers to chase", () => {
    expect(
      resendSummaryMessage({ recipients_queued: 0, non_openers_total: 0 }),
    ).toContain("everyone who received this campaign opened it");
  });

  it("formats large counts with thousands separators", () => {
    expect(
      resendSummaryMessage({
        recipients_queued: 12345,
        non_openers_total: 12345,
      }),
    ).toContain((12345).toLocaleString());
  });
});
