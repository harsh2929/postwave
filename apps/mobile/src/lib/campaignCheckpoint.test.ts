/**
 * The cross-surface half of ECO-03: a phone edits four of a campaign's fields,
 * a laptop edits all of them, and they share ONE checkpoint row per person per
 * campaign. Every assertion here is about not destroying the other surface's
 * work.
 */
import { describe, expect, it } from "vitest";

import {
  MOBILE_CHECKPOINT_FIELDS,
  campaignDraftFromCheckpoint,
  checkpointFieldsFromDraft,
  isMobileOwnedCheckpoint,
  mergeCampaignCheckpoint,
} from "./campaignCheckpoint";
import type { CampaignFieldsDraft } from "./campaignFields";

const DRAFT: CampaignFieldsDraft = {
  subject: "Half a thought",
  previewText: "…and the rest",
  fromName: "Ada",
  replyTo: "ada@example.com",
};

/** What apps/web's buildCampaignUpdateInput writes. */
const WEB_CHECKPOINT = {
  name: "August newsletter",
  subject: "Laptop subject",
  campaign_type: "regular",
  editor_mode: "html",
  preview_text: "",
  body_html: "<p>three paragraphs the phone cannot show</p>",
  body_mjml: "",
  plain_text: "",
  from_name: "",
  reply_to: "",
  content_blocks: [],
};

describe("checkpointFieldsFromDraft", () => {
  it("speaks the campaign PATCH vocabulary, not the sheet's", () => {
    // The web editor restores with `{...campaign, ...content}`. camelCase keys
    // would apply to nothing there — the draft would look restored and be
    // empty.
    expect(checkpointFieldsFromDraft(DRAFT)).toEqual({
      subject: "Half a thought",
      preview_text: "…and the rest",
      from_name: "Ada",
      reply_to: "ada@example.com",
    });
  });

  it("keeps what was typed, whitespace and all", () => {
    // A checkpoint is a mid-sentence snapshot. Trimming here hands back a
    // draft that differs from the one the person left; the PATCH that saves it
    // is the thing that trims.
    expect(checkpointFieldsFromDraft({ ...DRAFT, subject: "Half a " })).toMatchObject(
      { subject: "Half a " },
    );
  });
});

describe("mergeCampaignCheckpoint", () => {
  it("preserves every field this surface cannot edit", () => {
    const merged = mergeCampaignCheckpoint(
      WEB_CHECKPOINT,
      checkpointFieldsFromDraft(DRAFT),
    );
    expect(merged.body_html).toBe(WEB_CHECKPOINT.body_html);
    expect(merged.name).toBe("August newsletter");
    expect(merged.subject).toBe("Half a thought");
    expect(merged.reply_to).toBe("ada@example.com");
  });

  it("writes the bare fields when the server holds nothing", () => {
    expect(mergeCampaignCheckpoint(null, checkpointFieldsFromDraft(DRAFT))).toEqual(
      {
        subject: "Half a thought",
        preview_text: "…and the rest",
        from_name: "Ada",
        reply_to: "ada@example.com",
      },
    );
  });

  it("drops content it cannot lay fields over rather than corrupting it", () => {
    for (const held of ["a string", 42, [1, 2, 3]]) {
      expect(mergeCampaignCheckpoint(held, { subject: "x" })).toEqual({
        subject: "x",
      });
    }
  });
});

describe("campaignDraftFromCheckpoint", () => {
  it("reads a laptop's checkpoint into the sheet", () => {
    expect(campaignDraftFromCheckpoint(WEB_CHECKPOINT, DRAFT)).toEqual({
      subject: "Laptop subject",
      previewText: "",
      fromName: "",
      replyTo: "",
    });
  });

  it("falls back to the saved record for a field the checkpoint never carried", () => {
    // A checkpoint written by a surface that only touched the body has no
    // `subject` key. Seeding "" there proposes blanking the subject line.
    expect(
      campaignDraftFromCheckpoint({ body_html: "<p>x</p>" }, DRAFT),
    ).toEqual(DRAFT);
    expect(campaignDraftFromCheckpoint(null, DRAFT)).toEqual(DRAFT);
    expect(campaignDraftFromCheckpoint({ subject: 7 }, DRAFT)).toEqual(DRAFT);
  });
});

describe("isMobileOwnedCheckpoint", () => {
  it("is true only for a checkpoint this surface could have written", () => {
    expect(
      isMobileOwnedCheckpoint({
        subject: "x",
        preview_text: "",
        from_name: "",
        reply_to: "",
      }),
    ).toBe(true);
    expect(isMobileOwnedCheckpoint({ subject: "x" })).toBe(true);
    expect(isMobileOwnedCheckpoint({})).toBe(true);
  });

  it("refuses to claim a laptop's draft, even when its body looks empty", () => {
    // `body_html: ""` with three paragraphs in `body_mjml` beside it is a real
    // shape. A value-level "does this look like work?" guess deletes it.
    expect(isMobileOwnedCheckpoint(WEB_CHECKPOINT)).toBe(false);
    expect(isMobileOwnedCheckpoint({ subject: "x", body_html: "" })).toBe(false);
  });

  it("refuses content it cannot inspect at all", () => {
    for (const held of [null, undefined, "x", 3, [{ subject: "x" }]]) {
      expect(isMobileOwnedCheckpoint(held)).toBe(false);
    }
  });

  it("names exactly the fields the edit sheet can produce", () => {
    // The list is the deletion rule. If a field is added to the sheet without
    // being added here, this surface stops being able to clean up after
    // itself; if one is added here without being in the sheet, it starts
    // deleting other people's work.
    expect([...MOBILE_CHECKPOINT_FIELDS].sort()).toEqual([
      "from_name",
      "preview_text",
      "reply_to",
      "subject",
    ]);
    expect(Object.keys(checkpointFieldsFromDraft(DRAFT)).sort()).toEqual(
      [...MOBILE_CHECKPOINT_FIELDS].sort(),
    );
  });
});
