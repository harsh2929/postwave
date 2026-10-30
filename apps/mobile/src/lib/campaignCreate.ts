/**
 * lib/campaignCreate.ts — validation + payload building for creating a
 * campaign from a phone.
 *
 * Mobile could inspect and send existing work but could never START anything:
 * `find apps/mobile/app -path '*campaign*'` returned three routes and none of
 * them was a create surface, which is why the shared empty-state CTA had
 * nowhere to go.
 *
 * WIRE CONTRACT (verified against apps/api/internal/campaigns/authoring_input.go):
 *   POST /api/v1/campaigns accepts name, subject, preview_text, from_name,
 *   reply_to, body_html/body_mjml/plain_text, editor_mode, list_id,
 *   segment_id.
 *   It does NOT accept `from_email` — the sending address comes from the
 *   workspace's verified sender configuration, so the mobile sheet must not
 *   pretend to collect one.
 *   It REJECTS `status` and `scheduled_at` with 422
 *   `campaign_dispatch_state_owned`: dispatch state is owned by the
 *   lifecycle endpoints, so a create payload must never carry them.
 */

export interface CampaignDraftInput {
  name: string;
  subject: string;
  previewText?: string;
  fromName?: string;
  replyTo?: string;
}

export interface CampaignDraftValidation {
  valid: boolean;
  /** Field-keyed messages, rendered inline under each input. */
  errors: Partial<Record<keyof CampaignDraftInput, string>>;
  /** First error, for the submit button's accessibility hint. */
  firstError: string | null;
}

export const CAMPAIGN_NAME_MAX = 200;
export const CAMPAIGN_SUBJECT_MAX = 200;
/** Mirrors desktop's maxLength={200} on the preview-text field. */
export const CAMPAIGN_PREVIEW_MAX = 200;
export const CAMPAIGN_FROM_NAME_MAX = 100;

/** Same shape check desktop's submitCreate uses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidReplyTo(raw: string | null | undefined): boolean {
  const v = (raw ?? "").trim();
  if (v.length === 0) return true; // optional
  if (v.length > 254) return false;
  return EMAIL_RE.test(v);
}

export function validateCampaignDraft(
  input: CampaignDraftInput,
): CampaignDraftValidation {
  const errors: CampaignDraftValidation["errors"] = {};

  const name = input.name.trim();
  if (name.length === 0) {
    errors.name = "Give the campaign a name so you can find it later.";
  } else if (name.length > CAMPAIGN_NAME_MAX) {
    errors.name = `Name is too long (${name.length}/${CAMPAIGN_NAME_MAX}).`;
  }

  const subject = input.subject.trim();
  if (subject.length === 0) {
    errors.subject = "A subject line is required before this can send.";
  } else if (subject.length > CAMPAIGN_SUBJECT_MAX) {
    errors.subject = `Subject is too long (${subject.length}/${CAMPAIGN_SUBJECT_MAX}).`;
  }

  const preview = (input.previewText ?? "").trim();
  if (preview.length > CAMPAIGN_PREVIEW_MAX) {
    errors.previewText = `Preview text is too long (${preview.length}/${CAMPAIGN_PREVIEW_MAX}).`;
  }

  const fromName = (input.fromName ?? "").trim();
  if (fromName.length > CAMPAIGN_FROM_NAME_MAX) {
    errors.fromName = `From name is too long (${fromName.length}/${CAMPAIGN_FROM_NAME_MAX}).`;
  }

  if (!isValidReplyTo(input.replyTo)) {
    errors.replyTo = "Enter a valid reply-to email address, or leave it blank.";
  }

  const keys = Object.keys(errors) as (keyof CampaignDraftInput)[];
  return {
    valid: keys.length === 0,
    errors,
    firstError: keys.length > 0 ? (errors[keys[0]!] ?? null) : null,
  };
}

export interface CampaignCreatePayload {
  name: string;
  subject: string;
  preview_text?: string;
  from_name?: string;
  reply_to?: string;
}

/**
 * Build the POST body. Empty optional fields are OMITTED rather than sent as
 * "" so a draft created on a phone doesn't blank a workspace default, and
 * dispatch-owned fields are never included.
 */
export function campaignCreatePayload(
  input: CampaignDraftInput,
): CampaignCreatePayload {
  const preview = (input.previewText ?? "").trim();
  const fromName = (input.fromName ?? "").trim();
  const replyTo = (input.replyTo ?? "").trim();
  return {
    name: input.name.trim(),
    subject: input.subject.trim(),
    ...(preview ? { preview_text: preview } : {}),
    ...(fromName ? { from_name: fromName } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
  };
}

/**
 * A sensible default name derived from the subject, so the operator types
 * one field instead of two in the common case.
 */
export function suggestedCampaignName(subject: string): string {
  const s = subject.trim().replace(/\s+/g, " ");
  if (s.length === 0) return "";
  return s.length > CAMPAIGN_NAME_MAX ? s.slice(0, CAMPAIGN_NAME_MAX) : s;
}
