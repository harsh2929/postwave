import { describe, expect, it } from "vitest";

import { campaignGates } from "./campaignDetailGates";

const WITH_BODY = { body_html: "<p>hi</p>" };

describe("campaignGates", () => {
  it("a draft with a body can be edited, scheduled, tested, sent and deleted", () => {
    const g = campaignGates({ status: "draft", ...WITH_BODY });
    expect(g).toMatchObject({
      isDraft: true,
      canEdit: true,
      canSchedule: true,
      canSend: true,
      canTest: true,
      canDelete: true,
      canResend: false,
    });
  });

  it("a draft with NO body cannot be sent, but can still be scheduled", () => {
    const g = campaignGates({ status: "draft" });
    expect(g.canSend).toBe(false);
    expect(g.canTest).toBe(false);
    expect(g.canSchedule).toBe(true);
  });

  it("accepts an MJML-only or plain-text-only body", () => {
    expect(campaignGates({ status: "draft", body_mjml: "<mj/>" }).canSend).toBe(
      true,
    );
    expect(campaignGates({ status: "draft", plain_text: "hi" }).canSend).toBe(
      true,
    );
  });

  it("a sent campaign offers resend and NOT delete", () => {
    const g = campaignGates({ status: "sent", ...WITH_BODY });
    expect(g.canResend).toBe(true);
    expect(g.canDelete).toBe(false);
    expect(g.canSend).toBe(false);
    expect(g.canEdit).toBe(false);
    // Re-checking inbox rendering after a send is legitimate.
    expect(g.canTest).toBe(true);
  });

  it("a paused campaign can be rescheduled", () => {
    expect(campaignGates({ status: "paused", ...WITH_BODY }).canSchedule).toBe(
      true,
    );
  });

  it("shows A/B results ONLY for an A/B parent", () => {
    expect(campaignGates({ status: "sent", ...WITH_BODY }).canViewAbResults).toBe(
      false,
    );
    expect(
      campaignGates({ status: "sent", is_ab_test: true, ...WITH_BODY })
        .canViewAbResults,
    ).toBe(true);
    expect(
      campaignGates({
        status: "sent",
        delivery_settings: { ab_test: { is_parent: true } },
        ...WITH_BODY,
      }).canViewAbResults,
    ).toBe(true);
  });

  it("treats an absent campaign / status as a bodyless draft", () => {
    const g = campaignGates(null);
    expect(g.isDraft).toBe(true);
    expect(g.canSend).toBe(false);
    expect(g.canDelete).toBe(true);
    expect(g.canViewAbResults).toBe(false);
  });

  it("normalises casing and whitespace on the status", () => {
    expect(campaignGates({ status: "  SENT " }).canResend).toBe(true);
  });

  it("gives an unrecognised future status no destructive affordances", () => {
    const g = campaignGates({ status: "queued_for_reprocess", ...WITH_BODY });
    expect(g.canDelete).toBe(false);
    expect(g.canSend).toBe(false);
    expect(g.canSchedule).toBe(false);
  });
});
