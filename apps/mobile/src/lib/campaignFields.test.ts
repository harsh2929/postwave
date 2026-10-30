import { describe, expect, it } from "vitest";

import {
  campaignFieldsFrom,
  campaignFieldsPatch,
  hasCampaignFieldChanges,
  validateCampaignFields,
  type CampaignFieldsDraft,
} from "./campaignFields";

function draft(over: Partial<CampaignFieldsDraft> = {}): CampaignFieldsDraft {
  return {
    subject: "March promo",
    previewText: "Inside: 50% off",
    fromName: "Acme",
    replyTo: "support@acme.com",
    ...over,
  };
}

describe("campaignFieldsFrom", () => {
  it("maps the wire names onto the sheet's fields", () => {
    expect(
      campaignFieldsFrom({
        subject: "s",
        preview_text: "p",
        from_name: "f",
        reply_to: "r",
      }),
    ).toEqual({
      subject: "s",
      previewText: "p",
      fromName: "f",
      replyTo: "r",
    });
  });

  it("renders an absent campaign as empty strings, never undefined", () => {
    expect(campaignFieldsFrom(null)).toEqual({
      subject: "",
      previewText: "",
      fromName: "",
      replyTo: "",
    });
  });
});

describe("validateCampaignFields", () => {
  it("accepts a well-formed draft", () => {
    expect(validateCampaignFields(draft()).valid).toBe(true);
  });

  it("requires a subject", () => {
    const v = validateCampaignFields(draft({ subject: "   " }));
    expect(v.valid).toBe(false);
    expect(v.errors.subject).toContain("required");
  });

  it("enforces the same 200-char preview ceiling desktop does", () => {
    const v = validateCampaignFields(draft({ previewText: "x".repeat(201) }));
    expect(v.errors.previewText).toContain("too long");
  });

  it("rejects a malformed reply-to but allows an empty one", () => {
    expect(validateCampaignFields(draft({ replyTo: "nope" })).valid).toBe(false);
    expect(validateCampaignFields(draft({ replyTo: "" })).valid).toBe(true);
  });
});

describe("campaignFieldsPatch", () => {
  it("sends ONLY what changed", () => {
    // updateAuthoringInput decodes these as pointers: an absent field is left
    // alone. Sending everything would let a stale sheet overwrite an edit
    // someone else made on desktop while this sheet was open.
    const patch = campaignFieldsPatch(draft(), draft({ previewText: "New" }));
    expect(patch).toEqual({ preview_text: "New" });
  });

  it("is empty when nothing changed", () => {
    expect(campaignFieldsPatch(draft(), draft())).toEqual({});
    expect(hasCampaignFieldChanges(campaignFieldsPatch(draft(), draft()))).toBe(
      false,
    );
  });

  it("ignores whitespace-only edits", () => {
    expect(
      campaignFieldsPatch(draft(), draft({ subject: "  March promo  " })),
    ).toEqual({});
  });

  it("can still CLEAR a field", () => {
    // An emptied field differs from the original, so it is sent as "" and the
    // gateway applies it — clearing has to stay expressible.
    expect(campaignFieldsPatch(draft(), draft({ fromName: "" }))).toEqual({
      from_name: "",
    });
  });

  it("carries several changes at once", () => {
    const patch = campaignFieldsPatch(
      draft(),
      draft({ subject: "April promo", replyTo: "hi@acme.com" }),
    );
    expect(patch).toEqual({
      subject: "April promo",
      reply_to: "hi@acme.com",
    });
    expect(hasCampaignFieldChanges(patch)).toBe(true);
  });
});
