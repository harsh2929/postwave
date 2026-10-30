// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  type Campaign,
  type UpdateCampaignInput,
  sendCampaignTest,
  updateCampaign,
} from "@/lib/campaigns-api";
import { whoamiFresh, type MeResponse } from "@/lib/auth-api";
import {
  assertFreshCampaignWriteAuthority,
  CAMPAIGN_READ_ONLY_MESSAGE,
} from "@/lib/campaign-write-authority";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const CAMPAIGN_CONTENT_VALIDATION_UNAVAILABLE =
  "Campaign content could not be safety-checked. Retry before saving, scheduling, or sending.";

export function isValidCampaignEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

export function buildCampaignUpdateInput(
  campaign: Campaign,
): UpdateCampaignInput {
  const semantic = campaign.source_mode === "semantic";
  const common: UpdateCampaignInput = {
    name: campaign.name,
    subject: campaign.subject,
    campaign_type: campaign.campaign_type ?? "regular",
    editor_mode: campaign.editor_mode ?? "html",
    preview_text: campaign.preview_text ?? "",
    from_name: campaign.from_name ?? "",
    reply_to: campaign.reply_to ?? "",
    content_blocks: campaign.content_blocks ?? [],
    source_mode: semantic ? "semantic" : "legacy_html",
    content_schema_version: semantic ? 2 : 1,
    fact_contract: campaign.fact_contract ?? {},
    reusable_section_ids: campaign.reusable_section_ids ?? [],
    variants: campaign.variants ?? [],
    tracking_settings: campaign.tracking_settings ?? {},
    delivery_settings: campaign.delivery_settings ?? {},
    // The audience is always sent, both halves, with "" for "none". PATCH
    // reads a missing key as "leave unchanged" and JSON.stringify drops an
    // undefined value, so choosing "Everyone" used to save nothing: the server
    // kept the old segment, answered "Campaign saved.", and the picker snapped
    // back to it. A list and a segment are mutually exclusive, so switching
    // between them needs both fields in the same request.
    segment_id: campaign.segment_id ?? "",
    list_id: campaign.list_id ?? "",
    // scheduled_at is deliberately absent. PATCH /api/v1/campaigns/{id} refuses
    // ANY body carrying that key — including an explicit null, since the guard
    // tests for the field's presence, not its value — with 422
    // `campaign_dispatch_state_owned`. Sending it unconditionally meant every
    // save from this editor failed, not just scheduling ones.
    //
    // The send time belongs to POST /api/v1/campaigns/{id}/schedule.
  };
  if (semantic) {
    // HTML/text are projections of semantic nodes, not parallel authoring
    // authorities. Omitting them prevents a legacy editor snapshot from
    // drifting beside the exact tree the server will freeze and compile.
    return common;
  }
  return {
    ...common,
    body_html: campaign.body_html ?? "",
    body_mjml: campaign.body_mjml ?? "",
    plain_text: campaign.plain_text ?? "",
  };
}

/**
 * Fail closed at both the persistence and dispatch controls. Block rendering
 * removes unsafe destinations from its HTML projection, but the editable block
 * source, raw HTML/MJML modes, and variants are persisted too and therefore
 * need their own validation boundary.
 */
export async function validateCampaignContentLinks(
  campaign: Campaign,
): Promise<string | null> {
  // sanitize-html is deliberately loaded only at the persistence/dispatch
  // boundary. Keeping its parser out of the editor's initial route bundle is
  // not merely a size optimisation: draft checkpoint projection happens on
  // every keystroke and must remain synchronous, while the authoritative save,
  // schedule and send controls can await a complete parser-backed inspection.
  try {
    // Keep the import inside the attempt. A failed chunk load must block this
    // invocation without becoming a permanent in-memory rejection: the next
    // operator click invokes import() again and can recover after a transient
    // deployment/network failure.
    const {
      campaignBlockLinkError,
      campaignHTMLLinkError,
      campaignPlainTextLinkError,
      campaignSemanticLinkError,
    } = await import("@/lib/campaign-block-renderer");
    const semantic = campaign.source_mode === "semantic";
    if (semantic) {
      const semanticError = campaignSemanticLinkError(
        campaign.content_blocks ?? [],
      );
      if (semanticError) return semanticError;
    } else {
      const blockError = campaignBlockLinkError(campaign.content_blocks ?? []);
      if (blockError) return blockError;

      const htmlError = campaignHTMLLinkError(
        campaign.body_html ?? "",
        "Campaign HTML",
      );
      if (htmlError) return htmlError;
      const mjmlError = campaignHTMLLinkError(
        campaign.body_mjml ?? "",
        "Campaign MJML",
      );
      if (mjmlError) return mjmlError;
      const textError = campaignPlainTextLinkError(campaign.plain_text ?? "");
      if (textError) return textError;
    }

    for (const [index, variant] of (campaign.variants ?? []).entries()) {
      const blocks = Array.isArray(variant.content_blocks)
        ? (variant.content_blocks as Array<Record<string, unknown>>)
        : [];
      const blockError = campaignBlockLinkError(blocks);
      if (blockError) return `Variant ${index + 1}: ${blockError}`;
      const semanticError = campaignSemanticLinkError(blocks);
      if (semanticError) return `Variant ${index + 1}: ${semanticError}`;
      for (const [field, label] of [
        ["body_html", "HTML"],
        ["body_mjml", "MJML"],
      ] as const) {
        const value = variant[field];
        const error = campaignHTMLLinkError(
          typeof value === "string" ? value : "",
          `Variant ${index + 1} ${label}`,
        );
        if (error) return error;
      }
      const plainText = variant.plain_text;
      const textError = campaignPlainTextLinkError(
        typeof plainText === "string" ? plainText : "",
        `Variant ${index + 1} plain text`,
      );
      if (textError) return textError;
    }
    return null;
  } catch {
    // Parser/chunk failures are safety failures, not permission to persist or
    // dispatch uninspected content. Do not surface bundler or parser internals.
    return CAMPAIGN_CONTENT_VALIDATION_UNAVAILABLE;
  }
}

export function validateReplyTo(campaign: Campaign): string | null {
  if (campaign.reply_to && !isValidCampaignEmail(campaign.reply_to)) {
    return "Reply-to is not a valid email address.";
  }
  return null;
}

export function validateFromEmail(campaign: Campaign): string | null {
  const fromEmail = campaign.delivery_settings?.from_email;
  if (typeof fromEmail !== "string" || !isValidCampaignEmail(fromEmail)) {
    return "From email is required and must be a valid email address.";
  }
  return null;
}

export function validateTestRecipient(email: string): string | null {
  if (!email.trim()) return "Test recipient is required.";
  if (!isValidCampaignEmail(email)) return "Enter a valid email address.";
  return null;
}

export function useCampaignSaveWorkflow({
  campaign,
  campaignKey,
  campaignsBaseKey,
  queryClient,
  setCampaign,
  setDirty,
  testEmail,
  canWrite,
  openedIdentity,
}: {
  campaign: Campaign | null;
  campaignKey: QueryKey;
  campaignsBaseKey: QueryKey;
  queryClient: QueryClient;
  setCampaign: Dispatch<SetStateAction<Campaign | null>>;
  setDirty: (dirty: boolean) => void;
  testEmail: string;
  /** Includes both record-state editability and the opened session authority. */
  canWrite: boolean;
  /** Identity that opened the editor; every write is compared with a fresh read. */
  openedIdentity: MeResponse | null | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const campaignRef = useRef(campaign);
  const operationInFlightRef = useRef(false);
  campaignRef.current = campaign;

  const beginOperation = (): boolean => {
    // React state is intentionally not the authority here: two click handlers
    // can run before a `saving` render commits. The ref closes that same-tick
    // window synchronously and covers validation as well as network I/O.
    if (operationInFlightRef.current) return false;
    operationInFlightRef.current = true;
    setSaving(true);
    return true;
  };

  const finishOperation = () => {
    operationInFlightRef.current = false;
    setSaving(false);
  };

  const persistSnapshot = async (
    snapshot: Campaign,
    submittedDraft: Campaign,
  ): Promise<boolean> => {
    if (
      snapshot.source_mode !== "semantic" &&
      snapshot.editor_mode === "blocks" &&
      (snapshot.content_blocks?.length ?? 0) > 0
    ) {
      // Switching back from another editor keeps the blocks, but its HTML
      // projection may still belong to that other mode. Persist the selected
      // block source, even when no individual block was edited after switching.
      const { renderCampaignBlocksToHTML, renderCampaignBlocksToText } =
        await import("@/lib/campaign-block-renderer");
      snapshot.body_html = renderCampaignBlocksToHTML(snapshot.content_blocks!);
      snapshot.plain_text = renderCampaignBlocksToText(
        snapshot.content_blocks!,
      );
    }
    const contentLinkError = await validateCampaignContentLinks(snapshot);
    if (contentLinkError) {
      toast.error(contentLinkError);
      return false;
    }
    const fromEmailError = validateFromEmail(snapshot);
    if (fromEmailError) {
      toast.error(fromEmailError);
      return false;
    }
    const replyToError = validateReplyTo(snapshot);
    if (replyToError) {
      toast.error(replyToError);
      return false;
    }
    try {
      assertFreshCampaignWriteAuthority(openedIdentity, await whoamiFresh());
      const next = await updateCampaign(
        snapshot.id,
        buildCampaignUpdateInput(snapshot),
      );
      // Do not let a slower save response overwrite keystrokes made while the
      // request was in flight.  Only replace the draft when it is still the
      // exact object that was submitted; otherwise retain the newer edits.
      if (campaignRef.current === submittedDraft) {
        setCampaign(next);
        setDirty(false);
      }
      queryClient.setQueryData<Campaign>(campaignKey, next);
      void queryClient.invalidateQueries({
        queryKey: campaignKey,
        exact: false,
      });
      void queryClient.invalidateQueries({
        queryKey: campaignsBaseKey,
        exact: false,
      });
      toast.success("Campaign saved.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
      return false;
    }
  };

  const save = async (): Promise<boolean> => {
    if (!canWrite || !openedIdentity) {
      toast.error(CAMPAIGN_READ_ONLY_MESSAGE);
      return false;
    }
    if (!campaign || !beginOperation()) return false;
    const submittedDraft = campaign;
    try {
      // Campaigns are JSON resources. A deep clone taken before the first
      // await guarantees that nested blocks/variants validated are exactly the
      // nested blocks/variants persisted, even if an editor mutates its draft
      // while the lazy parser chunk is loading.
      const snapshot = structuredClone(submittedDraft);
      return await persistSnapshot(snapshot, submittedDraft);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
      return false;
    } finally {
      finishOperation();
    }
  };

  const sendTest = async (): Promise<void> => {
    if (!canWrite || !openedIdentity) {
      toast.error(CAMPAIGN_READ_ONLY_MESSAGE);
      return;
    }
    if (!campaign || !beginOperation()) return;
    const submittedDraft = campaign;
    const recipientSnapshot = testEmail.trim();
    try {
      const recipientError = validateTestRecipient(recipientSnapshot);
      if (recipientError) {
        toast.error(recipientError);
        return;
      }
      const snapshot = structuredClone(submittedDraft);
      const saved = await persistSnapshot(snapshot, submittedDraft);
      if (!saved) return;
      assertFreshCampaignWriteAuthority(openedIdentity, await whoamiFresh());
      await sendCampaignTest(snapshot.id, recipientSnapshot);
      toast.success("Test accepted.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test send failed.");
    } finally {
      finishOperation();
    }
  };

  return { save, saving, sendTest };
}
