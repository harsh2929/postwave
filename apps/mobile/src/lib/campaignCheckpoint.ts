/**
 * lib/campaignCheckpoint.ts — what a campaign's durable draft (ECO-03) looks
 * like on the wire, and the ONE rule that keeps a phone from deleting work it
 * cannot see.
 *
 * THE SHAPE IS SHARED, NOT MOBILE'S OWN. The server stores the checkpoint
 * content as opaque jsonb, so the only thing making a laptop's draft readable
 * on a phone is that both surfaces agree what the content means. Web writes
 * `buildCampaignUpdateInput` — the campaign PATCH body, snake_case wire names
 * (apps/web/.../use-campaign-save-workflow.ts) — and its restore is a spread
 * (`{...campaign, ...restored}`), so a partial body from a phone applies
 * cleanly there. This module therefore speaks the same snake_case vocabulary,
 * NOT the camelCase `CampaignFieldsDraft` the sheet holds. Inventing a second
 * shape would produce two checkpoints that look interchangeable and are not:
 * arriving on the second device you would be offered a draft whose fields
 * silently do not apply.
 *
 * WHAT THIS SURFACE CAN ACTUALLY EDIT is four fields (lib/campaignFields.ts):
 * subject, preview text, from-name, reply-to. The laptop's editor also holds
 * the BODY. That asymmetry is the whole reason this file exists:
 *
 *   - A write must MERGE over whatever the server already holds, never
 *     replace it. A phone that PUTs only its four fields over a checkpoint
 *     containing `body_html` deletes the laptop's half-written email, and the
 *     person who typed it is never told.
 *   - A DELETE is only ever safe for a checkpoint this surface could have
 *     written itself. Web discards on "the record was saved or the edit
 *     reverted", which is sound there because the editor holds the WHOLE
 *     draft — reverting really is abandoning all of it. On a phone, closing a
 *     four-field sheet says nothing about the body draft on the laptop, and
 *     saving those four fields does not put the body into the record either.
 *     So the phone declines to delete, stops writing, and lets the server's
 *     own retention sweep reclaim the row.
 *
 * The cost of that caution is a stale row that will not be offered again once
 * the record outlives it (isNewerThanRecord). Losing an OFFER is recoverable —
 * the laptop still holds the draft in its editor and re-checkpoints it on the
 * next keystroke. Losing the CONTENT is not.
 *
 * Pure: no React, no react-native, no transport. Every rule below is a unit
 * test in the node environment.
 */
import type { CampaignFieldsDraft } from "@/lib/campaignFields";

/**
 * The wire keys this surface owns. Same names as the campaign PATCH body, so
 * a checkpoint written here is directly restorable by the web editor.
 */
export const MOBILE_CHECKPOINT_FIELDS = [
  "subject",
  "preview_text",
  "from_name",
  "reply_to",
] as const;

export type MobileCheckpointField = (typeof MOBILE_CHECKPOINT_FIELDS)[number];

/**
 * A campaign checkpoint body. Deliberately open: the fields this surface does
 * not know about are the laptop's, and they travel through untouched.
 */
export type CampaignCheckpointContent = Record<string, unknown> &
  Partial<Record<MobileCheckpointField, string>>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * The four fields the sheet holds, expressed in the shared wire vocabulary.
 *
 * NOT trimmed. A checkpoint is what the person has typed so far, mid-word and
 * all; trimming here would hand back a draft that differs from the one they
 * left. The PATCH that eventually saves it trims (lib/campaignFields.ts) — the
 * two are different acts.
 */
export function checkpointFieldsFromDraft(
  draft: CampaignFieldsDraft,
): Record<MobileCheckpointField, string> {
  return {
    subject: draft.subject,
    preview_text: draft.previewText,
    from_name: draft.fromName,
    reply_to: draft.replyTo,
  };
}

/**
 * The body to PUT: this surface's fields laid over whatever the server already
 * holds.
 *
 * `held` is the content of the checkpoint currently on the server (null when
 * there is none). Spreading it first is what preserves the laptop's body draft
 * — see the header. A `held` that is not an object at all (a checkpoint some
 * other build wrote as an array or a string) is dropped rather than merged:
 * there is no meaningful way to lay four named fields over a string, and
 * guessing would corrupt both.
 */
export function mergeCampaignCheckpoint(
  held: unknown,
  fields: CampaignCheckpointContent,
): CampaignCheckpointContent {
  return { ...(asRecord(held) ?? {}), ...fields };
}

/**
 * The sheet's draft for a checkpoint the person chose to resume.
 *
 * `fallback` is the saved record's own field values, used for any field the
 * checkpoint does not carry — a checkpoint written by a surface that only
 * edited the body has no `subject` key, and seeding the sheet with an empty
 * string there would silently propose blanking the campaign's subject line.
 */
export function campaignDraftFromCheckpoint(
  content: unknown,
  fallback: CampaignFieldsDraft,
): CampaignFieldsDraft {
  const record = asRecord(content);
  if (!record) return fallback;
  return {
    subject: asString(record.subject) ?? fallback.subject,
    previewText: asString(record.preview_text) ?? fallback.previewText,
    fromName: asString(record.from_name) ?? fallback.fromName,
    replyTo: asString(record.reply_to) ?? fallback.replyTo,
  };
}

/**
 * True when the checkpoint holds nothing this surface cannot see — the only
 * case in which deleting it here is safe.
 *
 * Deliberately structural ("are all the keys mine?") rather than a judgement
 * about which values look like real work. `body_html: ""` and
 * `content_blocks: []` are how the web editor represents an empty body, and a
 * heuristic that read them as "nothing" would delete a checkpoint whose
 * `body_mjml` beside them was three paragraphs long. The conservative reading
 * costs an unreferenced row; the clever one costs someone's email.
 */
export function isMobileOwnedCheckpoint(content: unknown): boolean {
  const record = asRecord(content);
  if (!record) return false;
  const owned = new Set<string>(MOBILE_CHECKPOINT_FIELDS);
  return Object.keys(record).every((key) => owned.has(key));
}
