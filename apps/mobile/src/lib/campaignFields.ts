/**
 * lib/campaignFields.ts — editing a campaign's identity fields from a phone.
 *
 * Mobile could edit exactly ONE field: the subject. Preview text, from-name
 * and reply-to were all editable on desktop, all accepted by
 * PATCH /api/v1/campaigns/{id} (apps/api/internal/campaigns/
 * authoring_input.go updateAuthoringInput), and all invisible here — so a
 * typo'd reply-to address discovered on the way to a meeting could not be
 * fixed from the device in your hand.
 *
 * Preview text is the sharpest of the three: it is the line the inbox shows
 * under the subject, it is the second-highest-leverage word count in the whole
 * product, and it was unreachable.
 *
 * Pure: validation + the PATCH body. The sheet is just the surface.
 */
import {
  CAMPAIGN_FROM_NAME_MAX,
  CAMPAIGN_PREVIEW_MAX,
  CAMPAIGN_SUBJECT_MAX,
  isValidReplyTo,
} from "@/lib/campaignCreate";

export {
  CAMPAIGN_FROM_NAME_MAX,
  CAMPAIGN_PREVIEW_MAX,
  CAMPAIGN_SUBJECT_MAX,
};

export interface CampaignFieldsDraft {
  subject: string;
  previewText: string;
  fromName: string;
  replyTo: string;
}

export type CampaignFieldKey = keyof CampaignFieldsDraft;

export interface CampaignFieldsValidation {
  valid: boolean;
  errors: Partial<Record<CampaignFieldKey, string>>;
}

export function validateCampaignFields(
  draft: CampaignFieldsDraft,
): CampaignFieldsValidation {
  const errors: CampaignFieldsValidation["errors"] = {};

  const subject = draft.subject.trim();
  if (subject.length === 0) {
    errors.subject = "A subject line is required before this can send.";
  } else if (subject.length > CAMPAIGN_SUBJECT_MAX) {
    errors.subject = `Subject is too long (${subject.length}/${CAMPAIGN_SUBJECT_MAX}). Shorten it before saving.`;
  }

  const preview = draft.previewText.trim();
  if (preview.length > CAMPAIGN_PREVIEW_MAX) {
    errors.previewText = `Preview text is too long (${preview.length}/${CAMPAIGN_PREVIEW_MAX}).`;
  }

  const fromName = draft.fromName.trim();
  if (fromName.length > CAMPAIGN_FROM_NAME_MAX) {
    errors.fromName = `From name is too long (${fromName.length}/${CAMPAIGN_FROM_NAME_MAX}).`;
  }

  if (!isValidReplyTo(draft.replyTo)) {
    errors.replyTo = "Enter a valid reply-to email address, or leave it blank.";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** The campaign fields as they currently stand on the server. */
export interface CampaignFieldsSource {
  subject?: string | null | undefined;
  preview_text?: string | null | undefined;
  from_name?: string | null | undefined;
  reply_to?: string | null | undefined;
}

export function campaignFieldsFrom(
  campaign: CampaignFieldsSource | null | undefined,
): CampaignFieldsDraft {
  return {
    subject: campaign?.subject ?? "",
    previewText: campaign?.preview_text ?? "",
    fromName: campaign?.from_name ?? "",
    replyTo: campaign?.reply_to ?? "",
  };
}

/** The wire names of the fields this sheet owns. */
export interface CampaignFieldsPatch {
  subject?: string;
  preview_text?: string;
  from_name?: string;
  reply_to?: string;
}

/**
 * The PATCH body: ONLY the fields that actually changed.
 *
 * This matters beyond payload size. `updateAuthoringInput` decodes these as
 * POINTERS — a field present in the JSON is applied, a field absent is left
 * alone. Sending every field on every save would let a stale sheet (opened
 * before someone else edited the campaign on desktop) overwrite their change
 * with what the phone happened to be holding. Diffing means the phone can only
 * ever overwrite what its user actually touched.
 *
 * Clearing a field is still expressible: a value the user emptied is sent as
 * "" because it DIFFERS from the original, and the gateway applies it.
 */
export function campaignFieldsPatch(
  original: CampaignFieldsDraft,
  next: CampaignFieldsDraft,
): CampaignFieldsPatch {
  const patch: CampaignFieldsPatch = {};
  const subject = next.subject.trim();
  if (subject !== original.subject.trim()) patch.subject = subject;
  const preview = next.previewText.trim();
  if (preview !== original.previewText.trim()) patch.preview_text = preview;
  const fromName = next.fromName.trim();
  if (fromName !== original.fromName.trim()) patch.from_name = fromName;
  const replyTo = next.replyTo.trim();
  if (replyTo !== original.replyTo.trim()) patch.reply_to = replyTo;
  return patch;
}

export function hasCampaignFieldChanges(patch: CampaignFieldsPatch): boolean {
  return Object.keys(patch).length > 0;
}
