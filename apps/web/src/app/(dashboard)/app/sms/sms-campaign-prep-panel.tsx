// SPDX-License-Identifier: AGPL-3.0-only

import { Clapperboard, MessageSquareText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type {
  SmsCreditBalance,
  SmsCreditPreview,
  SmsCreditTopUpQuote,
  SmsMmsReadiness,
  SmsProgramRegion,
  SmsQuickReply,
  SmsTemplate,
} from "@/lib/sms-api";

interface SmsCampaignPrepPanelProps {
  campaignCredits: number;
  campaignSendDuration: string;
  campaignSegments: number;
  creditBalance: SmsCreditBalance | null;
  creditPreview: SmsCreditPreview | null;
  hasMedia: boolean;
  loading: boolean;
  mmsReadiness: SmsMmsReadiness | null;
  pending: string | null;
  programRegions: SmsProgramRegion[];
  templates: SmsTemplate[];
  quickReplies: SmsQuickReply[];
  topUpQuote: SmsCreditTopUpQuote | null;
  onApplyTemplate: (template: SmsTemplate) => void;
  onApplyQuickReply: (reply: SmsQuickReply) => void;
  onSaveDraftAsTemplate: () => void | Promise<void>;
  onEditQuickReply: (reply: SmsQuickReply) => void | Promise<void>;
  onDeleteQuickReply: (reply: SmsQuickReply) => void | Promise<void>;
  onRecordMmsSmokePass: () => void | Promise<void>;
  onStartTopUpCheckout: () => void | Promise<void>;
}

export function SmsCampaignPrepPanel({
  campaignSegments,
  hasMedia,
  loading,
  programRegions,
  templates,
  quickReplies,
  onApplyTemplate,
  onApplyQuickReply,
  onSaveDraftAsTemplate,
  onEditQuickReply,
  onDeleteQuickReply,
}: SmsCampaignPrepPanelProps) {
  // Applying a template replaces the whole composed body: nothing autosaves the
  // draft first and there is no undo. Segments are 0 only for a blank body, so
  // this is the panel's one signal that a click would cost the operator text
  // they typed — say so on the control instead of leaving it unlabelled.
  const draftHasBody = campaignSegments > 0;
  const replaceHint = draftHasBody
    ? "Replaces the message in the composer. The text you typed is not saved anywhere."
    : "Applies to the draft message.";
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-md border p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <MessageSquareText className="h-4 w-4" />
          Templates
        </div>
        <div className="grid gap-2">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              className="rounded-md border px-3 py-2 text-left text-sm transition hover:bg-muted"
              title={replaceHint}
              onClick={() => onApplyTemplate(template)}
            >
              <span className="flex items-center justify-between gap-2 font-medium">
                {template.name}
                {template.media_allowed ? (
                  <Badge variant="secondary">MMS</Badge>
                ) : null}
              </span>
              <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                {template.body}
              </span>
            </button>
          ))}
          {!loading && templates.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No SMS templates are available.
            </div>
          ) : null}
        </div>

        {/* SMS-035: tenant-authored custom templates (saved/edited/deleted). */}
        <div className="mt-3 border-t pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Your templates</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void onSaveDraftAsTemplate()}
            >
              Save as template
            </Button>
          </div>
          <div className="grid gap-2">
            {quickReplies.map((reply) => (
              <div
                key={reply.id}
                className="rounded-md border px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left font-medium hover:underline"
                    onClick={() => onApplyQuickReply(reply)}
                    title={replaceHint}
                  >
                    {reply.label}
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => void onEditQuickReply(reply)}
                    >
                      Edit
                    </Button>
                    {/* Edit and Delete sit ~4px apart, the body lives only on
                        the server, and the delete has no undo — so it goes
                        through the same confirm every other destructive verb on
                        this page uses. ConfirmDialog also holds its own
                        in-flight lock, which is what stops a double-click firing
                        a second DELETE against an already-gone row. */}
                    <ConfirmDialog
                      title="Delete this custom template?"
                      description={`"${reply.label}" and the message saved with it are removed from your templates. Drafts you already composed keep their text. This cannot be undone.`}
                      confirmLabel="Delete"
                      confirmVariant="destructive"
                      onConfirm={() => onDeleteQuickReply(reply)}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 text-destructive hover:text-destructive"
                        >
                          Delete
                        </Button>
                      }
                    />
                  </div>
                </div>
                <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">
                  {reply.body}
                </span>
              </div>
            ))}
            {quickReplies.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Save the current draft to reuse it as a custom template.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      <div className="rounded-md border p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Clapperboard className="h-4 w-4" />
          Draft evidence and regions
        </div>
        <div className="space-y-2 text-sm">
          <div className="rounded-md bg-muted px-3 py-2">
            Local draft estimate: {campaignSegments} text segment
            {campaignSegments === 1 ? "" : "s"}
            {hasMedia ? " · media URL present" : ""}. This is not balance,
            price, reservation, dispatch, or delivery evidence.
          </div>
          <div className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
            <div className="font-medium">SMS financial ledger release-held</div>
            <div>
              Balance, usage, prices, top-up quotes, and checkout are
              unavailable ( <code>sms_financial_ledger_release_held</code>). No
              purchase or entitlement is available from this page.
            </div>
          </div>
          <div className="rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-emphasis">
            <div className="font-medium">MMS readiness is unverified</div>
            <div>
              End-to-end MMS readiness and smoke certification are release-held
              until durable inbound media and provider evidence exist ({" "}
              <code>sms_mms_readiness_release_held</code>).
            </div>
          </div>
          {programRegions.map((region) => (
            <div
              key={region.country}
              className="flex items-start justify-between gap-3"
            >
              <div>
                <div className="font-medium">
                  {region.country} · {region.label}
                </div>
                <div className="text-xs text-muted-foreground">
                  {region.compliance_summary}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Transport-region metadata only · live dispatch and MMS
                  readiness are not certified.
                </div>
              </div>
              <Badge variant="secondary">release held</Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
