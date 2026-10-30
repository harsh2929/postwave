import { describe, expect, it } from "vitest";

import {
  REPLY_INTENTS,
  REPLY_INTENT_LABELS,
  parseCampaignReplies,
  replyClassifyBlockedReason,
  replyClassifyErrorMessage,
  replyIsClassifiable,
} from "./replyClassification";

const reply = (extra: Record<string, unknown> = {}) => ({
  id: "r1",
  from_email: "a@example.com",
  subject: "Re: Launch",
  received_at: "today",
  body_redacted: false,
  ...extra,
});

describe("REPLY_INTENTS", () => {
  it("matches the labels the handler accepts", () => {
    // campaign_replies.go:193 — anything else is 400 invalid_intent.
    expect([...REPLY_INTENTS]).toEqual([
      "question",
      "praise",
      "unsub",
      "ooo",
      "other",
    ]);
    for (const intent of REPLY_INTENTS) {
      expect(REPLY_INTENT_LABELS[intent]).toBeTruthy();
    }
  });
});

describe("parseCampaignReplies", () => {
  it("reads both envelope shapes", () => {
    expect(parseCampaignReplies({ items: [reply()] })).toHaveLength(1);
    expect(parseCampaignReplies({ replies: [reply()] })).toHaveLength(1);
    expect(parseCampaignReplies([reply()])).toHaveLength(1);
    expect(parseCampaignReplies(null)).toEqual([]);
  });

  it("drops a row with no id", () => {
    // No id means it came from the analytics rollup, whose `recent` rows are
    // unaddressable — classifying one is impossible, so it must not be listed
    // with a control beside it.
    expect(parseCampaignReplies([reply({ id: "" })])).toEqual([]);
  });

  it("reads either intent field", () => {
    expect(
      parseCampaignReplies([reply({ intent_label: "question" })])[0]?.intentLabel,
    ).toBe("question");
    expect(
      parseCampaignReplies([reply({ classification: "praise" })])[0]?.intentLabel,
    ).toBe("praise");
  });

  it("treats an ABSENT body_redacted as not redacted", () => {
    // Only an explicit true withholds the control; assuming redaction would hide
    // a usable verb on every deployment that omits the field.
    expect(parseCampaignReplies([reply({ body_redacted: undefined })])[0]?.bodyRedacted).toBe(
      false,
    );
    expect(parseCampaignReplies([reply({ body_redacted: "true" })])[0]?.bodyRedacted).toBe(
      false,
    );
  });
});

describe("replyIsClassifiable", () => {
  it("refuses a redacted reply, which the server answers 409 for", () => {
    const [redacted] = parseCampaignReplies([reply({ body_redacted: true })]);
    expect(replyIsClassifiable(redacted!)).toBe(false);
    expect(replyClassifyBlockedReason(redacted!)).toContain("privacy request");
  });

  it("allows an ordinary reply and gives it no blocked reason", () => {
    const [ok] = parseCampaignReplies([reply()]);
    expect(replyIsClassifiable(ok!)).toBe(true);
    expect(replyClassifyBlockedReason(ok!)).toBeNull();
  });
});

describe("replyClassifyErrorMessage", () => {
  it("distinguishes an unconfigured classifier from a redacted body", () => {
    const a = replyClassifyErrorMessage("classifier_unavailable", "x");
    const b = replyClassifyErrorMessage("reply_body_redacted", "x");
    expect(a).not.toBe(b);
    expect(a).toContain("no reply classifier configured");
    expect(b).toContain("erased");
  });

  it("falls back for an unknown code", () => {
    expect(replyClassifyErrorMessage("teapot", "FALLBACK")).toBe("FALLBACK");
  });
});
