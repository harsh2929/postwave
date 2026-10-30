import { describe, expect, it } from "vitest";

import type { SmsCampaign, SmsSenderProfile } from "../lib/sms-api";
import {
  appendSentence,
  buildSetupChecklist,
  campaignActionLabel,
  campaignTimestamp,
  filterCampaigns,
  formatDateTime,
  formatMicros,
  formatMicrosAggregate,
  formatPercent,
  isE164,
  isValidIanaTimeZone,
  ledgerModeLabel,
  parseConsentImport,
  pilotBadge,
  providerBrandPlaceholder,
  providerCampaignPlaceholder,
  renderSmsPreview,
  senderMetadata,
  senderPaused,
  senderQuietHours,
  senderServicePlaceholder,
  smsCredits,
  smsSegments,
  smsChecklistIdentity,
  statNumber,
} from "../app/(dashboard)/app/sms/page-helpers";

function campaign(overrides: Partial<SmsCampaign> = {}): SmsCampaign {
  return {
    id: "c1",
    name: "Flash sale",
    body: "Hello there",
    status: "draft",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function sender(
  metadata: Record<string, unknown>,
  provider: SmsSenderProfile["provider"] = "twilio",
): SmsSenderProfile {
  return {
    id: "sms_sender_1",
    provider,
    country: "US",
    sender_type: "10dlc",
    registration_status: "approved",
    metadata,
    created_at: "2026-06-27T00:00:00Z",
    updated_at: "2026-06-27T00:00:00Z",
  };
}

describe("SMS page helpers", () => {
  it("validates the same E.164 shape used by SMS phone inputs", () => {
    expect(isE164("+14155550100")).toBe(true);
    expect(isE164(" +14155550100 ")).toBe(true);
    expect(isE164("14155550100")).toBe(false);
    expect(isE164("+11552345678")).toBe(false);
    expect(isE164("+15551234567")).toBe(false);
    expect(isE164("+0123456789")).toBe(false);
    expect(isE164("+123")).toBe(false);
  });

  it("estimates SMS segments for GSM-like and non-GSM text", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("\u0100".repeat(70))).toBe(1);
    expect(smsSegments("\u0100".repeat(71))).toBe(2);
  });

  it("uses GSM-7 153-char and UCS-2 67-char concatenation boundaries", () => {
    // GSM-7: single 160, concat 153 -> 306 fits in 2, 307 spills to 3.
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
    // UCS-2: single 70, concat 67 -> 134 fits in 2, 135 spills to 3.
    expect(smsSegments("\u0100".repeat(134))).toBe(2);
    expect(smsSegments("\u0100".repeat(135))).toBe(3);
  });

  // An emoji is one code point but TWO UTF-16 code units, and UCS-2 SMS bills
  // by code unit. Counting code points previewed 70 emoji as a single segment
  // when the carrier splits it into two.
  it("bills astral characters as two UCS-2 units", () => {
    expect(smsSegments("\u{1F600}".repeat(35))).toBe(1); // 70 units exactly
    expect(smsSegments("\u{1F600}".repeat(36))).toBe(2); // 72 units -> spills
  });

  it("counts MMS media as two extra credits on top of text credits", () => {
    expect(smsCredits("hello")).toBe(1);
    expect(smsCredits("hello", "https://cdn.example.com/promo.jpg")).toBe(3);
    expect(smsCredits("", "https://cdn.example.com/promo.jpg")).toBe(3);
  });

  it("appends discount sentences with readable punctuation", () => {
    expect(appendSentence("", "Use code SAVE10 at checkout.")).toBe(
      "Use code SAVE10 at checkout.",
    );
    expect(appendSentence("Flash sale", "Use code SAVE10 at checkout.")).toBe(
      "Flash sale. Use code SAVE10 at checkout.",
    );
    expect(appendSentence("Flash sale!", "Use code SAVE10 at checkout.")).toBe(
      "Flash sale! Use code SAVE10 at checkout.",
    );
  });

  it("maps campaign lifecycle actions to toast copy", () => {
    expect(campaignActionLabel("pause")).toBe("paused");
    expect(campaignActionLabel("resume")).toBe("resumed");
    expect(campaignActionLabel("cancel")).toBe("cancelled");
    expect(campaignActionLabel("schedule")).toBe("scheduled");
  });

  it("uses provider-specific registration placeholders", () => {
    expect(senderServicePlaceholder("twilio")).toBe("MG...");
    expect(providerBrandPlaceholder("telnyx")).toBe("Telnyx Brand ID");
    expect(providerCampaignPlaceholder("bandwidth")).toBe(
      "Bandwidth Campaign ID",
    );
  });

  it("reads and writes quiet-hours metadata defensively", () => {
    expect(senderQuietHours(undefined)).toEqual({
      enabled: false,
      timezone: "America/New_York",
      start: "20:00",
      end: "08:00",
    });
    expect(
      senderQuietHours({
        quiet_hours: {
          timezone: "Europe/London",
          start: "21:30",
          end: "07:15",
        },
      }),
    ).toEqual({
      enabled: true,
      timezone: "Europe/London",
      start: "21:30",
      end: "07:15",
    });
    expect(
      senderMetadata(
        { quiet_hours: { timezone: "old" }, preserved: true },
        {
          quiet_hours_enabled: true,
          quiet_hours_timezone: " America/Los_Angeles ",
          quiet_hours_start: " 22:00 ",
          quiet_hours_end: " 06:00 ",
        },
      ),
    ).toEqual({
      preserved: true,
      quiet_hours: {
        timezone: "America/Los_Angeles",
        start: "22:00",
        end: "06:00",
      },
    });
    expect(
      senderMetadata(
        { quiet_hours: { timezone: "old" }, preserved: true },
        {
          quiet_hours_enabled: false,
          quiet_hours_timezone: "America/Los_Angeles",
          quiet_hours_start: "22:00",
          quiet_hours_end: "06:00",
        },
      ),
    ).toEqual({ preserved: true });
  });

  it("detects sender pause flags from legacy and nested metadata", () => {
    expect(senderPaused(sender({ paused: true }))).toBe(true);
    expect(senderPaused(sender({ sender_paused: "yes" }))).toBe(true);
    expect(senderPaused(sender({ sending: { kill_switch: "1" } }))).toBe(true);
    expect(senderPaused(sender({ sending: { paused: false } }))).toBe(false);
  });

  it("formats report metrics and ignores malformed stat values", () => {
    expect(statNumber({ queued: 12, failed: Number.NaN }, "queued")).toBe(12);
    expect(statNumber({ queued: 12, failed: Number.NaN }, "failed")).toBe(0);
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(Number.NaN)).toBe("0%");
    expect(formatMicros(1_250_000)).toBe("$1.2500");
    expect(formatMicros(-1)).toBe("$0.00");
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });

  it("formats aggregate costs at 2 decimal places", () => {
    expect(formatMicrosAggregate(12_340_000)).toBe("$12.34");
    expect(formatMicrosAggregate(1_250_000)).toBe("$1.25");
    expect(formatMicrosAggregate(0)).toBe("$0.00");
    expect(formatMicrosAggregate(-5)).toBe("$0.00");
  });

  it("maps ledger_mode to human copy and humanizes unknown modes", () => {
    expect(ledgerModeLabel("message_cost_ledger")).toBe("Metered credits");
    expect(ledgerModeLabel("prepaid")).toBe("Prepaid credits");
    expect(ledgerModeLabel("some_new_mode")).toBe("Some new mode");
    expect(ledgerModeLabel("")).toBe("");
  });

  it("maps pilot-readiness status to badge variant + label", () => {
    expect(pilotBadge("pass")).toEqual({ variant: "success", label: "Pass" });
    expect(pilotBadge("warning")).toEqual({
      variant: "warning",
      label: "Warning",
    });
    expect(pilotBadge("blocker")).toEqual({
      variant: "destructive",
      label: "Blocker",
    });
  });

  it("validates IANA timezones and rejects typos", () => {
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("Europe/London")).toBe(true);
    expect(isValidIanaTimeZone("America/New York")).toBe(false);
    expect(isValidIanaTimeZone("EST")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
  });

  it("filters campaigns by status and search query", () => {
    const list = [
      campaign({ id: "a", name: "Spring sale", status: "draft" }),
      campaign({ id: "b", name: "Winter promo", body: "Cozy", status: "sent" }),
      campaign({
        id: "c",
        name: "Flash",
        body: "spring is here",
        status: "draft",
      }),
    ];
    expect(filterCampaigns(list, { status: "sent" }).map((c) => c.id)).toEqual([
      "b",
    ]);
    expect(filterCampaigns(list, { query: "spring" }).map((c) => c.id)).toEqual(
      ["a", "c"],
    );
    expect(filterCampaigns(list, { status: "all", query: "" })).toHaveLength(3);
  });

  it("renders merge tags with sample values and humanizes unknown tags", () => {
    expect(renderSmsPreview("Save with {{discount_code}} today")).toBe(
      "Save with SAVE20 today",
    );
    expect(renderSmsPreview("Shop {{ link }}")).toBe(
      "Shop https://example.com/x",
    );
    expect(renderSmsPreview("Hi {{unknown_tag}}")).toBe("Hi unknown tag");
    expect(renderSmsPreview("no tags")).toBe("no tags");
  });

  it("parses bulk consent import and reports invalid rows", () => {
    const parsed = parseConsentImport(
      [
        "phone,email,proof",
        "+14155550100, alex@example.com, web form",
        "+14155550101",
        "not-a-phone",
        "+14155550100, dupe@example.com",
      ].join("\n"),
    );
    expect(parsed.rows).toEqual([
      {
        phone_e164: "+14155550100",
        subscriber_email: "alex@example.com",
        proof_text: "web form",
      },
      {
        phone_e164: "+14155550101",
        subscriber_email: undefined,
        proof_text: undefined,
      },
    ]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toContain("not-a-phone");
  });

  it("merges compliance + pilot into one ordered, deduplicated checklist", () => {
    const items = buildSetupChecklist(
      {
        can_send: false,
        senders: [],
        items: [
          { key: "sender", label: "SMS sender profile", complete: true },
          {
            key: "callback",
            label: "Public callback base URL",
            complete: false,
          },
          { key: "a2p", label: "A2P Brand registration", complete: false },
        ],
      },
      {
        can_pilot: false,
        counts: {},
        items: [
          // Duplicate of the compliance "SMS sender profile" tile.
          { key: "p_sender", label: "SMS sender profile", status: "pass" },
          { key: "p_a2p", label: "A2P Brand registration", status: "blocker" },
          {
            key: "p_consent",
            label: "Opted-in subscriptions",
            status: "warning",
          },
        ],
      },
    );
    // Deduplicated: sender appears once.
    expect(items.filter((i) => /sender profile/i.test(i.label))).toHaveLength(
      1,
    );
    // Blockers first, done last.
    expect(items[0].state).toBe("blocker");
    expect(items[items.length - 1].state).toBe("done");
    // Remediation targets resolve.
    const callback = items.find((i) => /callback/i.test(i.label));
    expect(callback?.remediation).toBe("settings");
    const consent = items.find((i) => /opted-in/i.test(i.label));
    expect(consent?.remediation).toBe("audience");
    const a2p = items.find((i) => /A2P Brand/i.test(i.label));
    expect(a2p?.remediation).toBe("registration");
  });

  it("keeps distinct checks with shared API keys uniquely identifiable", () => {
    const items = buildSetupChecklist(
      {
        can_send: false,
        senders: [],
        items: [
          {
            key: "approved_sender",
            label: "Sender registration approved",
            complete: true,
          },
          {
            key: "webhook_signature",
            label: "Provider webhook verification configured",
            complete: false,
          },
        ],
      },
      {
        can_pilot: false,
        counts: {},
        items: [
          {
            key: "approved_sender",
            label: "Approved active US/Canada sender",
            status: "pass",
          },
          {
            key: "webhook_signature",
            label: "Webhook signature secret",
            status: "blocker",
          },
        ],
      },
    );

    expect(items).toHaveLength(4);
    const identities = items.map(smsChecklistIdentity);
    expect(new Set(identities).size).toBe(items.length);
  });

  it("picks the most relevant campaign timestamp", () => {
    expect(
      campaignTimestamp(
        campaign({ status: "scheduled", scheduled_at: "2026-08-01T00:00:00Z" }),
      ),
    ).toEqual({ label: "Sends", iso: "2026-08-01T00:00:00Z" });
    expect(
      campaignTimestamp(
        campaign({ status: "sent", sent_at: "2026-07-02T00:00:00Z" }),
      ),
    ).toEqual({ label: "Sent", iso: "2026-07-02T00:00:00Z" });
    expect(campaignTimestamp(campaign({ status: "draft" }))).toEqual({
      label: "Created",
      iso: "2026-07-01T10:00:00Z",
    });
  });
});
