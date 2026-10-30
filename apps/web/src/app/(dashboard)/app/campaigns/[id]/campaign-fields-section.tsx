// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { Campaign } from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";
import type { FromNamePickerResponse } from "@/lib/from-name-picker-api";

import {
  CAMPAIGN_TYPES,
  EDITOR_MODES,
  labelize,
} from "./campaign-detail-helpers";
import { isValidCampaignEmail } from "./use-campaign-save-workflow";
import { CampaignDynamicContentPanel } from "./campaign-dynamic-content-panel";
import { EmailBlockComposer } from "./email-block-composer";

export type CampaignFieldChange = <K extends keyof Campaign>(
  key: K,
  value: Campaign[K],
) => void;

type EditorMode = NonNullable<Campaign["editor_mode"]>;

/** Whether the given authoring surface currently holds content (used to warn
 *  before a mode switch strands it out of view). CAMP-055. */
function modeHasContent(campaign: Campaign, mode: EditorMode): boolean {
  switch (mode) {
    case "html":
      return Boolean(campaign.body_html?.trim());
    case "mjml":
      return Boolean(campaign.body_mjml?.trim());
    case "plain_text":
      return Boolean(campaign.plain_text?.trim());
    case "blocks":
      return (campaign.content_blocks?.length ?? 0) > 0;
  }
}

function fromEmailOf(campaign: Campaign): string {
  return typeof campaign.delivery_settings?.from_email === "string"
    ? campaign.delivery_settings.from_email
    : "";
}

export function CampaignFieldsSection({
  campaign,
  editorMode,
  fromNameSuggestions,
  identity,
  onFieldChange,
}: {
  campaign: Campaign;
  editorMode: EditorMode;
  identity?: MeResponse;
  fromNameSuggestions?: {
    data?: FromNamePickerResponse;
    pending: boolean;
    error: boolean;
    retrying: boolean;
    onRetry: () => void;
  };
  onFieldChange: CampaignFieldChange;
}) {
  const [touched, setTouched] = useState<{ from?: boolean; reply?: boolean }>(
    {},
  );

  const fromEmail = fromEmailOf(campaign);
  const fromEmailError = !fromEmail.trim()
    ? "From email is required."
    : !isValidCampaignEmail(fromEmail)
      ? "Enter a valid email address."
      : null;
  const replyTo = campaign.reply_to ?? "";
  const replyToError =
    replyTo.trim() && !isValidCampaignEmail(replyTo)
      ? "Enter a valid email address."
      : null;

  const showFromError = touched.from && fromEmailError;
  const showReplyError = touched.reply && replyToError;
  const semantic = campaign.source_mode === "semantic";

  const changeEditorMode = (next: EditorMode) => {
    // Legacy data is never deleted (buildCampaignUpdateInput sends every
    // legacy body), but switching modes hides the populated surface — warn so
    // it doesn't read as a wipe. Semantic campaigns cannot enter this branch.
    if (next !== editorMode && modeHasContent(campaign, editorMode)) {
      toast.info(
        `Your ${labelize(editorMode)} content is preserved but only shown in ${labelize(
          editorMode,
        )} mode.`,
      );
    }
    onFieldChange("editor_mode", next);
  };

  return (
    <section className="grid gap-4">
      <div className="grid gap-4 rounded-md border bg-card p-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="campaign-name">Name</Label>
          <Input
            id="campaign-name"
            value={campaign.name}
            onChange={(event) => onFieldChange("name", event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="campaign-subject">Subject</Label>
          <Input
            id="campaign-subject"
            value={campaign.subject}
            onChange={(event) => onFieldChange("subject", event.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="campaign-type">Campaign type</Label>
          <Select
            id="campaign-type"
            value={campaign.campaign_type ?? "regular"}
            onChange={(event) =>
              onFieldChange(
                "campaign_type",
                event.target.value as Campaign["campaign_type"],
              )
            }
          >
            {CAMPAIGN_TYPES.map((type) => (
              <option key={type} value={type}>
                {labelize(type)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="editor-mode">Editor mode</Label>
          <Select
            id="editor-mode"
            disabled={semantic}
            value={campaign.editor_mode ?? "html"}
            onChange={(event) =>
              changeEditorMode(event.target.value as EditorMode)
            }
          >
            {EDITOR_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {labelize(mode)}
              </option>
            ))}
          </Select>
          {semantic ? (
            <p className="text-xs text-muted-foreground">
              Semantic campaigns are edited in their AST v2 source below; a
              legacy editor mode cannot replace that source.
            </p>
          ) : null}
        </div>
        <div className="grid gap-2 md:col-span-2">
          <Label htmlFor="preview-text">Preview text</Label>
          <Input
            id="preview-text"
            value={campaign.preview_text ?? ""}
            onChange={(event) =>
              onFieldChange("preview_text", event.target.value)
            }
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="from-name">From name</Label>
          <Input
            id="from-name"
            value={campaign.from_name ?? ""}
            onChange={(event) => onFieldChange("from_name", event.target.value)}
          />
          {fromNameSuggestions ? (
            <FromNameSuggestions
              current={campaign.from_name ?? ""}
              state={fromNameSuggestions}
              onApply={(fromName) => onFieldChange("from_name", fromName)}
            />
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="from-email">
            From email <span className="text-destructive">*</span>
          </Label>
          <Input
            id="from-email"
            type="email"
            required
            aria-required
            value={fromEmail}
            aria-invalid={showFromError ? true : undefined}
            aria-describedby={showFromError ? "from-email-error" : undefined}
            onBlur={() => setTouched((t) => ({ ...t, from: true }))}
            onChange={(event) =>
              onFieldChange("delivery_settings", {
                ...(campaign.delivery_settings ?? {}),
                from_email: event.target.value,
              })
            }
          />
          {showFromError ? (
            <p id="from-email-error" className="text-xs text-destructive">
              {fromEmailError}
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <Label htmlFor="reply-to">Reply-to</Label>
          <Input
            id="reply-to"
            type="email"
            value={replyTo}
            aria-invalid={showReplyError ? true : undefined}
            aria-describedby={showReplyError ? "reply-to-error" : undefined}
            onBlur={() => setTouched((t) => ({ ...t, reply: true }))}
            onChange={(event) => onFieldChange("reply_to", event.target.value)}
          />
          {showReplyError ? (
            <p id="reply-to-error" className="text-xs text-destructive">
              {replyToError}
            </p>
          ) : null}
        </div>
      </div>

      {!semantic && editorMode === "html" && (
        <div className="grid gap-2">
          <Label htmlFor="campaign-html">HTML</Label>
          <Textarea
            id="campaign-html"
            className="min-h-[360px] font-mono text-xs"
            value={campaign.body_html ?? ""}
            onChange={(event) => onFieldChange("body_html", event.target.value)}
          />
        </div>
      )}
      {!semantic && editorMode === "plain_text" && (
        <div className="grid gap-2">
          <Label htmlFor="plain-text">Plain text</Label>
          <Textarea
            id="plain-text"
            className="min-h-[360px] font-mono text-xs"
            value={campaign.plain_text ?? ""}
            onChange={(event) =>
              onFieldChange("plain_text", event.target.value)
            }
          />
        </div>
      )}
      {!semantic && editorMode === "mjml" && (
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="mjml-body">MJML</Label>
            <Textarea
              id="mjml-body"
              className="min-h-[360px] font-mono text-xs"
              value={campaign.body_mjml ?? ""}
              onChange={(event) => onFieldChange("body_mjml", event.target.value)}
            />
          </div>
          {identity ? (
            <EmailBlockComposer
              identity={identity}
              subject={campaign.subject}
              onApply={(mjml) => onFieldChange("body_mjml", mjml)}
            />
          ) : null}
        </div>
      )}
      {/* Conditional regions (campaigns-54). Semantic campaigns carry their
          content in AST v2 nodes, which the regions route does not parse. */}
      {!semantic && campaign.id ? (
        <CampaignDynamicContentPanel
          campaign={campaign}
          editorMode={editorMode}
          identity={identity}
          onInsert={(field, nextBody) => onFieldChange(field, nextBody)}
        />
      ) : null}
    </section>
  );
}

function FromNameSuggestions({
  current,
  onApply,
  state,
}: {
  current: string;
  onApply: (fromName: string) => void;
  state: NonNullable<
    Parameters<typeof CampaignFieldsSection>[0]["fromNameSuggestions"]
  >;
}) {
  const descriptionBaseId = useId();
  if (state.pending) {
    return (
      <div role="status" aria-label="Loading from-name suggestions">
        <Skeleton className="h-8 w-3/4" />
      </div>
    );
  }
  if (state.error) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      >
        <span>Historical from-name performance could not be loaded.</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={state.retrying}
          onClick={state.onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  const rows = Array.isArray(state.data?.from_names)
    ? state.data.from_names.slice(0, 5)
    : [];
  if (rows.length === 0) return null;

  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted-foreground">
        Top historical performers · {state.data?.window_days ?? 0}-day window
      </p>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((row, index) => {
          const descriptionId = `${descriptionBaseId}-${index}`;
          const selected = current.trim() === row.from_name;
          return (
            <Button
              key={row.from_name}
              type="button"
              size="sm"
              variant={selected ? "secondary" : "outline"}
              aria-pressed={selected}
              aria-describedby={descriptionId}
              onClick={() => onApply(row.from_name)}
            >
              <span className="max-w-40 truncate">{row.from_name}</span>
              <span aria-hidden className="tabular-nums text-muted-foreground">
                {(row.open_rate * 100).toFixed(1)}%
              </span>
              <span id={descriptionId} className="sr-only">
                Historical performance: {(row.open_rate * 100).toFixed(1)}% open
                rate, {(row.click_rate * 100).toFixed(1)}% click rate, used by{" "}
                {row.campaigns_using.toLocaleString()} campaigns, with
                {(row.confidence * 100).toFixed(0)}% confidence. Activate to
                apply this from name.
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
