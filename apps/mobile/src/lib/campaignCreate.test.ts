import { describe, expect, it } from "vitest";

import {
  CAMPAIGN_PREVIEW_MAX,
  campaignCreatePayload,
  isValidReplyTo,
  suggestedCampaignName,
  validateCampaignDraft,
} from "./campaignCreate";

const OK = { name: "July newsletter", subject: "What shipped in July" };

describe("validateCampaignDraft", () => {
  it("accepts the minimal two-field draft", () => {
    const v = validateCampaignDraft(OK);
    expect(v.valid).toBe(true);
    expect(v.firstError).toBeNull();
  });

  it("requires a name and a subject", () => {
    const v = validateCampaignDraft({ name: "   ", subject: "" });
    expect(v.valid).toBe(false);
    expect(v.errors.name).toBeTruthy();
    expect(v.errors.subject).toBeTruthy();
    expect(v.firstError).toBe(v.errors.name);
  });

  it("enforces the 200-char preview-text ceiling desktop uses", () => {
    const v = validateCampaignDraft({
      ...OK,
      previewText: "x".repeat(CAMPAIGN_PREVIEW_MAX + 1),
    });
    expect(v.valid).toBe(false);
    expect(v.errors.previewText).toContain("201");
  });

  it("accepts a preview exactly at the limit", () => {
    const v = validateCampaignDraft({
      ...OK,
      previewText: "x".repeat(CAMPAIGN_PREVIEW_MAX),
    });
    expect(v.valid).toBe(true);
  });

  it("rejects a malformed reply-to but allows a blank one", () => {
    expect(validateCampaignDraft({ ...OK, replyTo: "nope" }).valid).toBe(false);
    expect(validateCampaignDraft({ ...OK, replyTo: "  " }).valid).toBe(true);
    expect(validateCampaignDraft({ ...OK, replyTo: "a@b.co" }).valid).toBe(true);
  });

  it("rejects an over-long name and from-name", () => {
    expect(validateCampaignDraft({ ...OK, name: "n".repeat(201) }).valid).toBe(
      false,
    );
    expect(
      validateCampaignDraft({ ...OK, fromName: "f".repeat(101) }).valid,
    ).toBe(false);
  });
});

describe("isValidReplyTo", () => {
  it("mirrors desktop's email shape check", () => {
    expect(isValidReplyTo("ops@postwave.io")).toBe(true);
    expect(isValidReplyTo("ops@postwave")).toBe(false);
    expect(isValidReplyTo("ops @postwave.io")).toBe(false);
    expect(isValidReplyTo(`${"a".repeat(250)}@b.co`)).toBe(false);
    expect(isValidReplyTo(null)).toBe(true);
  });
});

describe("campaignCreatePayload", () => {
  it("omits blank optional fields rather than sending empty strings", () => {
    const body = campaignCreatePayload({
      name: "  July  ",
      subject: " Hello ",
      previewText: "   ",
      fromName: "",
      replyTo: "  ",
    });
    expect(body).toEqual({ name: "July", subject: "Hello" });
  });

  it("includes the optional fields the API actually accepts", () => {
    const body = campaignCreatePayload({
      name: "July",
      subject: "Hello",
      previewText: "A quick note",
      fromName: "Moosewave",
      replyTo: "ops@postwave.io",
    });
    expect(body.preview_text).toBe("A quick note");
    expect(body.from_name).toBe("Moosewave");
    expect(body.reply_to).toBe("ops@postwave.io");
  });

  it("never carries dispatch-owned fields the API rejects with 422", () => {
    const body = campaignCreatePayload(OK) as unknown as Record<string, unknown>;
    expect(body).not.toHaveProperty("status");
    expect(body).not.toHaveProperty("scheduled_at");
    expect(body).not.toHaveProperty("from_email");
  });
});

describe("suggestedCampaignName", () => {
  it("derives a name from the subject and collapses whitespace", () => {
    expect(suggestedCampaignName("  What   shipped  ")).toBe("What shipped");
    expect(suggestedCampaignName("   ")).toBe("");
  });

  it("truncates to the name ceiling", () => {
    expect(suggestedCampaignName("s".repeat(500))).toHaveLength(200);
  });
});
