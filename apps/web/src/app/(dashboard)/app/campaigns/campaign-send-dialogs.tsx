// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";

import { useQuery } from "@tanstack/react-query";

import { CampaignSendCheckRows } from "@/components/campaigns/campaign-send-check-rows";
import { PreSendRefinePanel } from "@/components/campaigns/presend-refine-panel";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { sendGateDisabled } from "./campaign-send-gate";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  type Campaign,
  type ChecklistStatus,
  type SendPreviewResult,
  getCampaignChecklist,
  getSendPreview,
} from "@/lib/campaigns-api";
import { qk, STALE, type RoleKey } from "@/lib/query-keys";

import { CampaignAssuranceSendStatus } from "./[id]/campaign-assurance-panel";
import { InboxRealityBanner } from "./inbox-reality-banner";
import { VoiceDriftBanner } from "./voice-drift-banner";

// --- Schedule hold --------------------------------------------------------
// Retained as a defensive status dialog for any stale/deep-linked caller. The
// active campaign list and detail surfaces render disabled hold controls and do
// not import or open this component.

export function CampaignScheduleDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Campaign scheduling unavailable</DialogTitle>
          <DialogDescription>
            No delivery schedule will be created in this deployment.
          </DialogDescription>
        </DialogHeader>
        <p role="note" className="py-2 text-sm text-muted-foreground">
          {CAMPAIGN_SCHEDULING_RELEASE_HOLD}
        </p>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Send confirmation dialog (CAMP-002 / CAMP-011) -----------------------

const CHECK_ICON: Record<ChecklistStatus, typeof CheckCircle2> = {
  pass: CheckCircle2,
  warn: AlertTriangle,
  fail: XCircle,
};
const CHECK_COLOR: Record<ChecklistStatus, string> = {
  pass: "text-success",
  warn: "text-warning-emphasis",
  fail: "text-destructive",
};

function fromEmailOf(campaign: Campaign): string {
  const value = campaign.delivery_settings?.from_email;
  return typeof value === "string" ? value : "";
}

/**
 * The Audience line of the send review: the list's or segment's name, or a
 * phrase for its kind when the name could not be read. Never an id, and never
 * "Entire eligible audience" for a campaign that targets a list — the label
 * used to fall back to that for every kind but a segment.
 */
export function sendPreviewAudienceLabel(
  preview: SendPreviewResult | null,
): string {
  if (!preview) return "—";
  const name = (preview.audience_label || preview.segment_label || "").trim();
  const frozen = preview.audience_frozen ? " (frozen snapshot)" : "";
  switch (preview.audience_kind) {
    case "list":
      return `${name || "Selected list"}${frozen}`;
    case "segment":
      return `${name || "Selected segment"}${frozen}`;
    case "workspace":
      return "Everyone eligible in this workspace";
    default:
      return name || "Selected audience";
  }
}

export function CampaignSendDialog({
  campaign,
  tenantId,
  role,
  onConfirm,
  onOpenChange,
  open,
  sending,
}: {
  campaign: Campaign | null;
  tenantId: string;
  role: RoleKey;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  sending: boolean;
}) {
  const enabled = open && Boolean(campaign);
  const campaignId = campaign?.id ?? "none";

  const previewQuery = useQuery({
    queryKey: [...qk.campaign(tenantId, role, campaignId), "send-preview"],
    queryFn: ({ signal }) => getSendPreview(campaignId, { signal }),
    enabled,
    staleTime: STALE.list,
  });
  const checklistQuery = useQuery({
    queryKey: [...qk.campaign(tenantId, role, campaignId), "checklist"],
    queryFn: () => getCampaignChecklist(campaignId),
    enabled,
    staleTime: STALE.list,
  });

  const preview = previewQuery.data ?? null;
  const checklist = checklistQuery.data ?? null;
  // Sending is irreversible, so never let it fire before the recipient count
  // and the pre-send checks have resolved. While loading → disabled. If the
  // preview COUNT itself errored (e.g. /send-preview 500s), we don't hard-lock
  // forever — but require an explicit acknowledgment before enabling Send, so a
  // mass send never goes out with an unverified audience (audit CAMP-002/011).
  const [ackNoCount, setAckNoCount] = useState(false);
  // A FAILED checklist request is not a cleared checklist. `sendGateDisabled`
  // only knows "still loading" and "resolved with a failing gate", so a 500 on
  // /checklist leaves every one of its flags false — no checks card, no
  // spinner, nothing on screen — and Send would go live having evaluated no
  // gate at all. Held to the same bar as the count failure above: name it,
  // offer a retry, and require its own explicit acknowledgment.
  const [ackNoChecklist, setAckNoChecklist] = useState(false);
  useEffect(() => {
    setAckNoCount(false);
    setAckNoChecklist(false);
  }, [open, campaignId]);
  const countPending = enabled && previewQuery.isPending;
  const countErrored = enabled && previewQuery.isError;
  const checklistPending = enabled && checklistQuery.isPending;
  const checklistErrored = enabled && checklistQuery.isError;
  const checklistBlocks = Boolean(checklist && !checklist.ready);
  const sendDisabled =
    sendGateDisabled({
      sending,
      countPending,
      countErrored,
      checklistPending,
      checklistBlocks,
      ackNoCount,
    }) ||
    (checklistErrored && !ackNoChecklist);

  const fromName = campaign?.from_name?.trim() || "(no from name)";
  const fromEmail = campaign ? fromEmailOf(campaign) : "";
  const isPlainTextCampaign =
    campaign?.editor_mode === "plain_text" ||
    campaign?.campaign_type === "plain_text";
  // A campaign can retain legacy HTML after switching editor modes. Do not let
  // that stale field mask the authoritative plain-text body in the drift check.
  const voiceBodyHtml = isPlainTextCampaign ? "" : (campaign?.body_html ?? "");
  const voiceBodyText = campaign?.plain_text ?? "";
  const audienceLabel = sendPreviewAudienceLabel(preview);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send campaign</DialogTitle>
          <DialogDescription>
            Review the details below — sending is immediate and cannot be
            undone.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2 rounded-md border bg-muted/20 p-3 text-sm">
            <dt className="text-muted-foreground">Campaign</dt>
            <dd
              className="col-span-2 truncate font-medium"
              title={campaign?.name}
            >
              {campaign?.name ?? "—"}
            </dd>
            <dt className="text-muted-foreground">Subject</dt>
            <dd className="col-span-2 truncate" title={campaign?.subject}>
              {campaign?.subject || "(no subject)"}
            </dd>
            <dt className="text-muted-foreground">From</dt>
            <dd
              className="col-span-2 truncate"
              title={`${fromName} <${fromEmail}>`}
            >
              {fromName}
              {fromEmail ? (
                <span className="text-muted-foreground">
                  {" "}
                  &lt;{fromEmail}&gt;
                </span>
              ) : (
                <span className="text-destructive">
                  {" "}
                  — missing from address
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">Audience</dt>
            <dd className="col-span-2 truncate" title={audienceLabel}>
              {countPending ? (
                <span className="text-muted-foreground">Checking…</span>
              ) : (
                audienceLabel
              )}
            </dd>
            <dt className="text-muted-foreground">Recipients</dt>
            <dd className="col-span-2 font-medium tabular-nums">
              {countPending ? (
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Counting…
                </span>
              ) : preview ? (
                <>
                  {preview.deliverable.toLocaleString()} deliverable
                  {preview.suppressed_excluded > 0 ? (
                    <span className="text-muted-foreground">
                      {" "}
                      ({preview.suppressed_excluded.toLocaleString()}{" "}
                      suppressed)
                    </span>
                  ) : null}
                </>
              ) : (
                <span className="text-warning-emphasis">Count unavailable</span>
              )}
            </dd>
          </dl>

          {campaign ? (
            <CampaignAssuranceSendStatus
              campaignId={campaign.id}
              tenantId={tenantId}
              role={role}
            />
          ) : null}

          {/* Advisory pre-send readings. Neither feeds `sendGateDisabled` —
              placement is a forecast and voice drift is a style signal, so
              neither may block an irreversible action the checklist already
              cleared. Both render an honest absence when their service or
              their inputs are missing. */}
          {campaign ? (
            <InboxRealityBanner
              bodyHtml={campaign.body_html ?? ""}
              campaignId={campaign.id}
              enabled={enabled}
              role={role}
              subject={campaign.subject ?? ""}
              tenantId={tenantId}
            />
          ) : null}
          {campaign ? (
            <VoiceDriftBanner
              bodyHtml={voiceBodyHtml}
              bodyText={voiceBodyText}
              campaignId={campaign.id}
              enabled={enabled}
              role={role}
              tenantId={tenantId}
            />
          ) : null}

          {countErrored ? (
            <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle/40 px-3 py-2 text-xs text-warning-emphasis">
              <Checkbox
                checked={ackNoCount}
                onChange={(e) => setAckNoCount(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                We couldn&apos;t verify the recipient count (the preview failed
                to load). I understand and want to send anyway.
              </span>
            </label>
          ) : null}

          {checklistPending ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Running pre-send checks…
            </p>
          ) : null}

          {checklistErrored ? (
            <div
              role="alert"
              className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <p className="flex items-start gap-2">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Pre-send checks could not be run — the checklist request
                  failed. The from address, subject, body and unsubscribe gates
                  were not evaluated.
                </span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={checklistQuery.isFetching}
                onClick={() => void checklistQuery.refetch()}
              >
                Retry checks
              </Button>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={ackNoChecklist}
                  onChange={(e) => setAckNoChecklist(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I understand the pre-send checks did not run and want to send
                  anyway.
                </span>
              </label>
            </div>
          ) : null}

          {preview?.over_cap ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle/40 px-3 py-2 text-xs text-warning-emphasis">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              This send exceeds today&apos;s warmup cap; some recipients may be
              deferred to a later window.
            </p>
          ) : null}

          {checklist && checklist.checks?.length > 0 ? (
            <div className="rounded-md border p-3">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Pre-send checks
              </div>
              <ul className="space-y-1.5">
                {checklist.checks.map((check) => {
                  const Icon = CHECK_ICON[check.status];
                  return (
                    <li
                      key={check.key}
                      className="flex items-start gap-2 text-sm"
                    >
                      <Icon
                        className={`mt-0.5 h-4 w-4 shrink-0 ${CHECK_COLOR[check.status]}`}
                      />
                      <span>
                        <span className="font-medium">{check.label}</span>
                        {check.detail ? (
                          <span className="text-muted-foreground">
                            {" "}
                            — {check.detail}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {checklistBlocks ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                  <MinusCircle className="h-3.5 w-3.5" />
                  Resolve the failing checks before you can send.
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Advisory content checks (a11y lint + link sweep) and the
              pre-send audience refinement. Like the banners above, neither
              feeds `sendGateDisabled`: the server checklist is the gate. */}
          {campaign ? (
            <CampaignSendCheckRows
              bodyHtml={voiceBodyHtml}
              campaignId={campaign.id}
              enabled={enabled}
              role={role}
              subject={campaign.subject ?? ""}
              tenantId={tenantId}
            />
          ) : null}
          {campaign ? (
            <PreSendRefinePanel
              campaignId={campaign.id}
              enabled={enabled}
              role={role}
              tenantId={tenantId}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={sendDisabled} onClick={onConfirm}>
            {sending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending…
              </>
            ) : (
              "Send now"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
