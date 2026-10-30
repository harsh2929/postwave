// The checkpoint row for a campaign is ONE row per person per campaign, shared
// by every client that person signs into. ECO-03's clause — "open another, see
// the exact authoritative checkpoint" — is only satisfied if the clients agree
// what the checkpoint SAYS, so desktop writes the campaign PATCH body web
// already writes (`buildCampaignUpdateInput`), not its own editor shape.
//
// These tests pin the two directions of that mapping and the one case desktop
// must refuse rather than guess.

import { describe, expect, it } from "vitest";

import type { CampaignDetail } from "../../lib/api-client";
import {
  campaignCheckpointContent,
  campaignDraftFromCheckpoint,
} from "../../components/campaigns/campaign-checkpoint-content";
import type { CampaignEditorDraft } from "../../components/CampaignDetailEditor";

const DETAIL = {
  id: "cam_1",
  name: "Saved name",
  subject: "Saved subject",
  status: "draft",
  body_html: "<p>saved</p>",
  preview_text: "saved preview",
  from_name: "Saved sender",
  goal_event: "purchase",
  goal_window_hours: 48,
  audience_mode: "static",
  updated_at: "2026-08-04T09:00:00Z",
  delivery_settings: { from_email: "saved@example.com", ip_pool: "warm" },
} as unknown as CampaignDetail;

const DRAFT: CampaignEditorDraft = {
  name: "  Draft name  ",
  subject: "  Draft subject  ",
  fromName: "  Draft sender  ",
  fromEmail: "  draft@example.com  ",
  body: "<p>draft</p>",
  previewText: "  draft preview  ",
  goalEvent: "  signup  ",
  goalWindowHours: 12,
  audienceMode: "dynamic",
};

describe("campaignCheckpointContent", () => {
  it("writes the payload SAVE would send, in web's vocabulary", () => {
    // Same keys, same trimming, same goal-window rule as
    // useCampaignEditorController.saveEdit. A checkpoint that disagreed with
    // the save would resume as a campaign the person never wrote.
    expect(campaignCheckpointContent(DRAFT, DETAIL, "html")).toEqual({
      name: "Draft name",
      subject: "Draft subject",
      body_html: "<p>draft</p>",
      preview_text: "draft preview",
      goal_event: "signup",
      goal_window_hours: 12,
      audience_mode: "dynamic",
      from_name: "Draft sender",
      delivery_settings: {
        from_email: "draft@example.com",
        ip_pool: "warm",
      },
    });
  });

  it("mirrors the blocks-mode body split", () => {
    const content = campaignCheckpointContent(
      { ...DRAFT, body: "<mjml/>" },
      DETAIL,
      "blocks",
    );
    expect(content.body_mjml).toBe("<mjml/>");
    expect(content.body_html).toBe("");
  });

  it("clears the goal window when the goal is cleared, exactly as save does", () => {
    const content = campaignCheckpointContent(
      { ...DRAFT, goalEvent: "   " },
      DETAIL,
      "html",
    );
    expect(content.goal_event).toBe("");
    expect(content.goal_window_hours).toBe(0);
  });

  it("carries sending settings the editor does not show", () => {
    // Restoring must not silently drop a delivery setting nobody edited.
    expect(
      campaignCheckpointContent(DRAFT, DETAIL, "html").delivery_settings,
    ).toMatchObject({ ip_pool: "warm" });
  });
});

describe("campaignDraftFromCheckpoint", () => {
  it("round-trips a draft this editor wrote", () => {
    const content = campaignCheckpointContent(DRAFT, DETAIL, "html");
    const restored = campaignDraftFromCheckpoint(content, DETAIL);
    expect(restored).toEqual({
      status: "ready",
      draft: {
        name: "Draft name",
        subject: "Draft subject",
        fromName: "Draft sender",
        fromEmail: "draft@example.com",
        body: "<p>draft</p>",
        previewText: "draft preview",
        goalEvent: "signup",
        goalWindowHours: 12,
        audienceMode: "dynamic",
      },
    });
  });

  it("reads a checkpoint written by the web editor", () => {
    // The cross-device case the clause is about. Web's payload carries keys
    // desktop does not author (`campaign_type`, `content_blocks`, …) and omits
    // the goal/audience keys web's editor does not own.
    const restored = campaignDraftFromCheckpoint(
      {
        name: "Written on the web",
        subject: "Half a subject",
        campaign_type: "regular",
        editor_mode: "html",
        preview_text: "web preview",
        body_html: "<p>web</p>",
        body_mjml: "",
        plain_text: "",
        from_name: "Web sender",
        reply_to: "",
        content_blocks: [],
        variants: [],
        delivery_settings: { from_email: "web@example.com" },
      },
      DETAIL,
    );
    expect(restored).toEqual({
      status: "ready",
      draft: {
        name: "Written on the web",
        subject: "Half a subject",
        fromName: "Web sender",
        fromEmail: "web@example.com",
        body: "<p>web</p>",
        previewText: "web preview",
        // ABSENT ≠ EMPTY: web does not checkpoint the goal or the audience
        // mode, so those keep the SAVED record's values rather than being
        // cleared by a client that never had an opinion about them.
        goalEvent: "purchase",
        goalWindowHours: 48,
        audienceMode: "static",
      },
    });
  });

  it("refuses a block-composed body instead of showing an empty editor", () => {
    // Desktop's editor opens `body_html`. A checkpoint whose real content is in
    // `body_mjml` would either look empty — the person's draft silently gone —
    // or paste MJML into an HTML field the next save persists as the body.
    const restored = campaignDraftFromCheckpoint(
      { name: "Blocks", subject: "s", body_html: "", body_mjml: "<mjml/>" },
      DETAIL,
    );
    expect(restored.status).toBe("review-only");
    expect(restored.status === "review-only" && restored.reason).toContain(
      "composed from blocks",
    );
  });

  it("keeps an empty body resumable — an emptied draft is still a draft", () => {
    const restored = campaignDraftFromCheckpoint(
      { name: "n", subject: "s", body_html: "" },
      DETAIL,
    );
    expect(restored.status).toBe("ready");
    expect(restored.status === "ready" && restored.draft.body).toBe("");
  });

  it("refuses a payload that is not a checkpoint at all", () => {
    for (const junk of [null, "a string", 42, ["a", "list"]]) {
      expect(campaignDraftFromCheckpoint(junk, DETAIL).status).toBe(
        "review-only",
      );
    }
  });
});
