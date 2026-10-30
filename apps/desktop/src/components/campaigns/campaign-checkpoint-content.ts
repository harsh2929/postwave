/**
 * campaign-checkpoint-content — the shape a campaign draft takes ON THE SERVER
 * (ECO-03), and the two mappings between it and the desktop editor's draft.
 *
 * WHY THIS IS NOT THE DESKTOP DRAFT SHAPE. The checkpoint row is keyed by
 * (user, entity_key, entity_id) — ONE row per person per campaign, shared by
 * every client that person uses. apps/web already writes the campaign PATCH
 * body there (`buildCampaignUpdateInput`). If desktop wrote its own editor
 * shape (`fromEmail`, `previewText`, `body`) into the same row, the two clients
 * would take turns overwriting each other with a vocabulary the other cannot
 * read: web would spread `previewText` onto a Campaign and lose the preview
 * text it thought it was restoring. The clause this program is measured
 * against — "open another, see the exact authoritative checkpoint" — is only
 * satisfied if both clients agree what the checkpoint SAYS.
 *
 * So the content is the payload SAVE would send, exactly as on web. The keys
 * desktop writes are the keys `useCampaignEditorController.saveEdit` sends; a
 * key desktop does not send is a key desktop does not checkpoint, which is the
 * same fidelity its own save has.
 *
 * ABSENT ≠ EMPTY on the way back. A key missing from a checkpoint means the
 * client that wrote it does not edit that field, not that the field should be
 * cleared — so restore falls back to the SAVED record, mirroring web's
 * `{...campaign, ...restored}` spread.
 */

import type { CampaignDetail } from "../../lib/api-client";
import type {
  CampaignEditorDraft,
  CampaignEditorMode,
} from "../CampaignDetailEditor";
import { asCampaignString, resolveCampaignFromEmail } from "./useCampaignDetailData";

/**
 * The checkpoint body for a campaign. A superset-tolerant view of the campaign
 * PATCH shape: desktop writes the keys below, and reads any key it knows while
 * ignoring the ones only web authors (`content_blocks`, `variants`, …).
 */
export interface CampaignCheckpointContent {
  name?: string;
  subject?: string;
  preview_text?: string;
  body_html?: string;
  body_mjml?: string;
  plain_text?: string;
  from_name?: string;
  goal_event?: string;
  goal_window_hours?: number;
  audience_mode?: string;
  delivery_settings?: Record<string, unknown>;
  /** Keys authored by another surface travel through untouched. */
  [key: string]: unknown;
}

export type CampaignCheckpointRestore =
  | { status: "ready"; draft: CampaignEditorDraft }
  /**
   * The draft is real and readable, but THIS editor cannot open it. The clause
   * requires "a precise explanation of why only review mode is available", and
   * this is the case that produces one.
   */
  | { status: "review-only"; reason: string };

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Build the checkpoint body from the live editor draft.
 *
 * Mirrors `saveEdit`'s patch field for field, including the blocks-mode split
 * (`body_mjml` + an emptied `body_html`) — a checkpoint that disagreed with the
 * save would resume as a campaign the person never wrote.
 *
 * `delivery_settings` carries the record's current settings with `from_email`
 * overlaid, exactly as the save does, so restoring cannot silently drop a
 * sending setting the editor does not show.
 */
export function campaignCheckpointContent(
  draft: CampaignEditorDraft,
  detail: CampaignDetail,
  editorMode: CampaignEditorMode,
): CampaignCheckpointContent {
  const currentDelivery = (
    detail as { delivery_settings?: Record<string, unknown> }
  ).delivery_settings;
  const goalEvent = draft.goalEvent.trim();
  return {
    name: draft.name.trim(),
    subject: draft.subject.trim(),
    ...(editorMode === "blocks"
      ? { body_mjml: draft.body, body_html: "" }
      : { body_html: draft.body }),
    preview_text: draft.previewText.trim(),
    goal_event: goalEvent,
    goal_window_hours: goalEvent ? draft.goalWindowHours || 24 : 0,
    audience_mode: draft.audienceMode,
    from_name: draft.fromName.trim(),
    delivery_settings: {
      ...(currentDelivery ?? {}),
      from_email: draft.fromEmail.trim(),
    },
  };
}

/**
 * Map a stored checkpoint back onto the desktop editor draft, or explain why
 * this editor cannot open it.
 *
 * The one refusal is a BLOCK-COMPOSED body. Desktop's editor opens
 * `body_html`; a checkpoint holding `body_mjml` with an emptied `body_html`
 * (what web's block editor and desktop's own blocks mode both write) has its
 * real content in a field this HTML editor cannot represent. Loading it would
 * either show an empty body — silently losing the draft in the person's eyes —
 * or paste MJML into an HTML field, which the next save would persist as the
 * campaign body. Saying so is the honest answer; guessing is not.
 */
export function campaignDraftFromCheckpoint(
  content: unknown,
  detail: CampaignDetail,
): CampaignCheckpointRestore {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return {
      status: "review-only",
      reason:
        "The saved draft is not in a form this editor recognises, so nothing has been applied.",
    };
  }
  const record = content as CampaignCheckpointContent;
  const bodyHtml = str(record.body_html);
  const bodyMjml = str(record.body_mjml);
  if (!bodyHtml && bodyMjml) {
    return {
      status: "review-only",
      reason:
        "That draft's body was composed from blocks, and this window edits campaign HTML directly. Reopen it where you wrote it, or discard it here and keep the saved version.",
    };
  }

  const delivery =
    record.delivery_settings && typeof record.delivery_settings === "object"
      ? (record.delivery_settings as Record<string, unknown>)
      : undefined;
  const goalWindow = record.goal_window_hours;

  return {
    status: "ready",
    draft: {
      name: str(record.name) ?? detail.name ?? "",
      subject: str(record.subject) ?? detail.subject ?? "",
      fromName: str(record.from_name) ?? detail.from_name ?? "",
      fromEmail:
        str(delivery?.from_email) ??
        str(record.from_email) ??
        resolveCampaignFromEmail(detail),
      body:
        bodyHtml ??
        str(record.plain_text) ??
        asCampaignString(detail.body_html ?? detail.plain_text ?? ""),
      previewText: str(record.preview_text) ?? detail.preview_text ?? "",
      goalEvent: str(record.goal_event) ?? detail.goal_event ?? "",
      goalWindowHours:
        typeof goalWindow === "number" && Number.isFinite(goalWindow)
          ? goalWindow
          : (detail.goal_window_hours ?? 0),
      audienceMode:
        str(record.audience_mode) ?? detail.audience_mode ?? "dynamic",
    },
  };
}
