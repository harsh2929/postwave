/**
 * lib/subscriberChannelConsents — the presentation rules for SUB-042.
 *
 * The load-bearing claim: a channel with NO row is "no consent recorded",
 * which must never collapse into "opted out" — "we never asked" and "they
 * said no" are different facts in both compliance directions. And the verb
 * offered per row follows the ledger, not the UI's mood: only a recorded
 * opt-in can be revoked; everything else routes to a GRANT review.
 */
import { describe, expect, it } from "vitest";

import {
  CHANNEL_CONSENT_CHANNELS,
  channelConsentAction,
  channelConsentProvenance,
  channelConsentStatusLabel,
  mergeChannelConsentRows,
  parseChannelConsents,
} from "./subscriberChannelConsents";

const ROW = {
  channel: "sms",
  status: "opted_in",
  consentTimestamp: "2026-08-01T09:00:00Z",
  consentSource: "preference_center",
  frequencyCapUntil: null,
};

describe("parseChannelConsents", () => {
  it("reads the server's {items:[...]} body shape", () => {
    const rows = parseChannelConsents({
      items: [
        {
          channel: "SMS",
          status: "opted_in",
          consent_timestamp: "2026-08-01T09:00:00Z",
          consent_source: "preference_center",
          frequency_cap_until: null,
        },
      ],
    });
    expect(rows).toEqual([ROW]);
  });

  it("returns [] for the envelope, junk, and rows without a channel", () => {
    expect(parseChannelConsents({ data: { items: [ROW] } })).toEqual([]);
    expect(parseChannelConsents(null)).toEqual([]);
    expect(parseChannelConsents({ items: [{ status: "opted_in" }] })).toEqual(
      [],
    );
  });
});

describe("mergeChannelConsentRows", () => {
  it("presents all five channels; absent ones carry status '' (unrecorded)", () => {
    const merged = mergeChannelConsentRows([ROW]);
    expect(merged.map((r) => r.channel)).toEqual([
      ...CHANNEL_CONSENT_CHANNELS,
    ]);
    expect(merged.find((r) => r.channel === "sms")?.status).toBe("opted_in");
    expect(merged.find((r) => r.channel === "push")?.status).toBe("");
  });

  it("APPENDS a server row for a channel this build does not know", () => {
    const merged = mergeChannelConsentRows([
      { ...ROW, channel: "fax" },
    ]);
    expect(merged.map((r) => r.channel)).toContain("fax");
  });
});

describe("status + verb honesty", () => {
  it("labels the absent row 'No consent recorded' — never a refusal", () => {
    expect(channelConsentStatusLabel("")).toBe("No consent recorded");
    expect(channelConsentStatusLabel("opted_out")).toBe("Opted out");
  });

  it("only a recorded opt-in offers Opt out; everything else offers a reviewed grant", () => {
    expect(channelConsentAction("opted_in")).toEqual({
      nextStatus: "opted_out",
      label: "Opt out",
    });
    for (const status of ["", "opted_out", "pending", "unknown"]) {
      expect(channelConsentAction(status)).toEqual({
        nextStatus: "opted_in",
        label: "Opt in",
      });
    }
  });

  it("never invents provenance for an unrecorded channel", () => {
    expect(
      channelConsentProvenance({ ...ROW, status: "", consentSource: "" }),
    ).toMatch(/never had a consent decision/);
    expect(channelConsentProvenance(ROW)).toBe("via preference_center");
  });
});
