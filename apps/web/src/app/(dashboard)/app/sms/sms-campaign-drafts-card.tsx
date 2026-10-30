// SPDX-License-Identifier: AGPL-3.0-only

import type { Dispatch, FormEvent, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  Clapperboard,
  Copy,
  Download,
  Eye,
  Gift,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react";

import { ActionMenu } from "@/components/ui/action-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import Link from "next/link";
import { asRoute } from "@/lib/typed-routes";
import {
  type SmsCampaign,
  type SmsCampaignReport,
  type SmsCreditBalance,
  type SmsCreditPreview,
  type SmsCreditTopUpQuote,
  type SmsDiscountCode,
  type SmsList,
  type SmsMmsReadiness,
  type SmsProgramRegion,
  type SmsQuickReply,
  type SmsSenderProfile,
  type SmsTemplate,
} from "@/lib/sms-api";
import {
  campaignTimestamp,
  datetimeLocalNow,
  filterCampaigns,
  formatDateTime,
  listOptionLabel,
  senderPaused,
  SMS_BODY_MAX,
  smsSegments,
  statNumber,
} from "./page-helpers";
import { CampaignReportPanel } from "./campaign-report-panel";
import { CardLoadError } from "./sms-card-states";
import { SmsCampaignPrepPanel } from "./sms-campaign-prep-panel";
import { SmsCharCount } from "./sms-char-count";
import { SmsPhonePreview } from "./sms-phone-preview";

// SMS-037: per-recipient send-time optimization mode. "fixed" keeps the
// single global datetime; "recipient_tz" delivers at local_time in each
// recipient's timezone; "sto" uses each recipient's learned best send hour.
export type SmsSendTiming = "fixed" | "recipient_tz" | "sto";

// SMS-036: one A/B message variant in the composer.
export interface SmsAbVariantDraft {
  label: string;
  body: string;
  weight: string;
}

export interface SmsCampaignDraft {
  sender_profile_id: string;
  list_id: string;
  name: string;
  body: string;
  media_url: string;
  status: string;
  scheduled_at: string;
  link_tracking: boolean;
  cost_cap_dollars: string;
  discount_code: string;
  send_timing: SmsSendTiming;
  local_time: string;
  fallback_tz: string;
  ab_enabled: boolean;
  ab_variants: SmsAbVariantDraft[];
  editing_id?: string;
}

type CampaignLifecycleAction = "pause" | "resume" | "cancel";
type ExportStatus = "all" | "problems" | "undelivered" | "blocked" | "failed";

const PAGE_STEP = 8;

/**
 * Why a store discount chip cannot be inserted. The server sets
 * currently_redeemable as "not past expires_at AND under max_redemptions"
 * (internal/sms/store.go), so the two causes are re-derivable here — and a
 * greyed-out chip whose only tooltip is the promotion's name leaves the
 * operator with nothing to act on, since the fix lives in the store.
 */
function discountChipBlock(
  item: SmsDiscountCode,
): { tag: string; reason: string } | null {
  if (item.currently_redeemable) return null;
  const expiresAtRaw = item.expires_at;
  if (expiresAtRaw) {
    const expiresAt = new Date(expiresAtRaw);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date()) {
      return {
        tag: "expired",
        reason: `Expired ${formatDateTime(expiresAtRaw)} — reopen or replace this code in the connected store before using it.`,
      };
    }
  }
  if (item.max_redemptions && item.times_redeemed >= item.max_redemptions) {
    return {
      tag: "fully redeemed",
      reason: `Fully redeemed — ${item.times_redeemed.toLocaleString()} of ${item.max_redemptions.toLocaleString()} uses claimed. Raise the limit in the connected store before using it.`,
    };
  }
  return {
    tag: "unavailable",
    reason:
      "Not currently redeemable in the connected store — check the code's expiry and redemption limit there.",
  };
}

interface SmsCampaignDraftsCardProps {
  campaignCredits: number;
  campaignSendDuration: string;
  campaignSegments: number;
  campaigns: SmsCampaign[];
  creditBalance: SmsCreditBalance | null;
  creditPreview: SmsCreditPreview | null;
  discountCodes: SmsDiscountCode[];
  dispatchAvailable: boolean;
  dispatchUnavailableReason?: string;
  reportExportAvailable: boolean;
  reportExportUnavailableReason?: string;
  draft: SmsCampaignDraft;
  lists: SmsList[];
  loading: boolean;
  loadError?: string | null;
  mmsReadiness: SmsMmsReadiness | null;
  pending: string | null;
  programRegions: SmsProgramRegion[];
  reports: Record<string, SmsCampaignReport>;
  senders: SmsSenderProfile[];
  setupCanSend: boolean;
  templates: SmsTemplate[];
  quickReplies: SmsQuickReply[];
  topUpQuote: SmsCreditTopUpQuote | null;
  setDraft: Dispatch<SetStateAction<SmsCampaignDraft>>;
  onApplyTemplate: (template: SmsTemplate) => void;
  onApplyQuickReply: (reply: SmsQuickReply) => void;
  onSaveDraftAsTemplate: () => void | Promise<void>;
  onEditQuickReply: (reply: SmsQuickReply) => void | Promise<void>;
  onDeleteQuickReply: (reply: SmsQuickReply) => void | Promise<void>;
  onBroadcastCampaign: (campaign: SmsCampaign) => void | Promise<void>;
  onCampaignLifecycle: (
    campaign: SmsCampaign,
    action: CampaignLifecycleAction,
  ) => void | Promise<void>;
  onDraftWithAI: () => void | Promise<void>;
  onDuplicateCampaign: (campaign: SmsCampaign) => void;
  onEditCampaign: (campaign: SmsCampaign) => void;
  onExportReport: (campaign: SmsCampaign, status: ExportStatus) => void;
  onInsertDiscountCode: (selectedCode?: string) => void;
  onLoadCampaignReport: (campaign: SmsCampaign) => void | Promise<void>;
  onRetryFailed: (campaign: SmsCampaign) => void | Promise<void>;
  onRecordMmsSmokePass: () => void | Promise<void>;
  onRetry?: () => void;
  onScheduleCampaign: (campaign: SmsCampaign) => void;
  onStartTopUpCheckout: () => void | Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function SmsCampaignDraftsCard(props: SmsCampaignDraftsCardProps) {
  const {
    campaignCredits,
    campaignSendDuration,
    campaignSegments,
    campaigns,
    creditBalance,
    creditPreview,
    discountCodes,
    dispatchAvailable,
    dispatchUnavailableReason,
    reportExportAvailable,
    reportExportUnavailableReason,
    draft,
    lists,
    loading,
    loadError,
    mmsReadiness,
    pending,
    programRegions,
    reports,
    senders,
    setupCanSend,
    templates,
    topUpQuote,
    setDraft,
    onApplyTemplate,
    quickReplies,
    onApplyQuickReply,
    onSaveDraftAsTemplate,
    onEditQuickReply,
    onDeleteQuickReply,
    onBroadcastCampaign,
    onCampaignLifecycle,
    onDraftWithAI,
    onDuplicateCampaign,
    onEditCampaign,
    onExportReport,
    onInsertDiscountCode,
    onLoadCampaignReport,
    onRetryFailed,
    onRecordMmsSmokePass,
    onRetry,
    onScheduleCampaign,
    onStartTopUpCheckout,
    onSubmit,
  } = props;

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [visible, setVisible] = useState(PAGE_STEP);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [broadcastTarget, setBroadcastTarget] = useState<SmsCampaign | null>(
    null,
  );
  const [cancelTarget, setCancelTarget] = useState<SmsCampaign | null>(null);
  const broadcastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [showComposerPreview, setShowComposerPreview] = useState(false);

  const filtered = useMemo(
    () => filterCampaigns(campaigns, { query, status: statusFilter }),
    [campaigns, query, statusFilter],
  );
  const shown = filtered.slice(0, visible);
  // Computed after mount so the datetime `min` attribute never differs between
  // the SSR HTML and the first client render (hydration-safe).
  const [now, setNow] = useState("");
  useEffect(() => setNow(datetimeLocalNow()), []);

  const listFor = (id?: string) => lists.find((list) => list.id === id);
  const broadcastList = broadcastTarget
    ? listFor(broadcastTarget.list_id)
    : undefined;
  const broadcastRecipients = broadcastList?.recipient_count ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Campaign Drafts</CardTitle>
        <CardDescription>
          Draft, scheduled, and paused SMS campaigns before broadcast execution.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!dispatchAvailable ? (
          <Alert>
            <AlertTitle>Broadcast dispatch is release-held</AlertTitle>
            <AlertDescription>
              {dispatchUnavailableReason ??
                "SMS broadcast dispatch is currently unavailable."}
            </AlertDescription>
          </Alert>
        ) : null}
        {!reportExportAvailable ? (
          <Alert>
            <AlertTitle>Campaign evidence is unavailable</AlertTitle>
            <AlertDescription>
              {reportExportUnavailableReason ??
                "Campaign evidence is release-held (sms_evidence_read_release_held). No campaign-evidence request will be sent."}
            </AlertDescription>
          </Alert>
        ) : null}
        <SmsCampaignPrepPanel
          campaignCredits={campaignCredits}
          campaignSendDuration={campaignSendDuration}
          campaignSegments={campaignSegments}
          creditBalance={creditBalance}
          creditPreview={creditPreview}
          hasMedia={draft.media_url.trim() !== ""}
          loading={loading}
          mmsReadiness={mmsReadiness}
          pending={pending}
          programRegions={programRegions}
          templates={templates}
          quickReplies={quickReplies}
          topUpQuote={topUpQuote}
          onApplyTemplate={onApplyTemplate}
          onApplyQuickReply={onApplyQuickReply}
          onSaveDraftAsTemplate={onSaveDraftAsTemplate}
          onEditQuickReply={onEditQuickReply}
          onDeleteQuickReply={onDeleteQuickReply}
          onRecordMmsSmokePass={onRecordMmsSmokePass}
          onStartTopUpCheckout={onStartTopUpCheckout}
        />
        <form
          className="space-y-3"
          onSubmit={(event) => {
            if (!dispatchAvailable && draft.status === "scheduled") {
              event.preventDefault();
              return;
            }
            onSubmit(event);
          }}
        >
          {draft.editing_id ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-info/40 bg-info-subtle px-3 py-2 text-xs text-info">
              <span>
                Editing an existing draft — saving updates it in place (no
                duplicate).
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    editing_id: undefined,
                    name: "",
                    body: "",
                    media_url: "",
                    cost_cap_dollars: "",
                    discount_code: "",
                  }))
                }
              >
                Clear
              </Button>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="campaign_name">Name</Label>
              <Input
                id="campaign_name"
                value={draft.name}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    name: e.target.value,
                  }))
                }
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_sender">Sender</Label>
              <Select
                id="campaign_sender"
                value={draft.sender_profile_id}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    sender_profile_id: e.target.value,
                  }))
                }
              >
                <option value="">No sender yet</option>
                {senders.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.phone_number || item.messaging_service_sid}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_list">Audience</Label>
              <Select
                id="campaign_list"
                value={draft.list_id}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    list_id: e.target.value,
                  }))
                }
              >
                <option value="">No audience yet</option>
                {lists.map((item) => (
                  <option key={item.id} value={item.id}>
                    {listOptionLabel(item)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_status">Status</Label>
              <Select
                id="campaign_status"
                value={draft.status}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    status: e.target.value,
                  }))
                }
              >
                <option value="draft">Draft</option>
                <option value="scheduled" disabled={!dispatchAvailable}>
                  Scheduled
                </option>
                <option value="paused">Paused</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_scheduled_at">Schedule time</Label>
              <Input
                id="campaign_scheduled_at"
                type="datetime-local"
                min={now}
                required={draft.status === "scheduled"}
                value={draft.scheduled_at}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    scheduled_at: e.target.value,
                  }))
                }
              />
              {draft.status === "scheduled" ? (
                <p className="text-xs text-muted-foreground">
                  Required for a scheduled draft — must be in the future.
                </p>
              ) : null}
            </div>
            {/* SMS-037: per-recipient send-time optimization. */}
            <div className="space-y-2">
              <Label htmlFor="campaign_send_timing">Send timing</Label>
              <Select
                id="campaign_send_timing"
                value={draft.send_timing}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    send_timing: e.target.value as SmsSendTiming,
                  }))
                }
              >
                <option value="fixed">
                  Fixed time (send now / at schedule)
                </option>
                <option value="recipient_tz">Recipient local time</option>
                <option value="sto">Send-time optimized (best hour)</option>
              </Select>
              {draft.send_timing === "recipient_tz" ? (
                <p className="text-xs text-muted-foreground">
                  Each recipient receives the message at{" "}
                  {draft.local_time || "09:00"} their local time.
                </p>
              ) : draft.send_timing === "sto" ? (
                <p className="text-xs text-muted-foreground">
                  Each recipient is sent at their learned best send hour (within
                  the next week).
                </p>
              ) : null}
            </div>
            {draft.send_timing === "recipient_tz" ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="campaign_local_time">Local send time</Label>
                  <Input
                    id="campaign_local_time"
                    type="time"
                    value={draft.local_time}
                    onChange={(e) =>
                      setDraft((current) => ({
                        ...current,
                        local_time: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="campaign_fallback_tz">
                    Fallback timezone
                  </Label>
                  <Input
                    id="campaign_fallback_tz"
                    placeholder="UTC"
                    value={draft.fallback_tz}
                    onChange={(e) =>
                      setDraft((current) => ({
                        ...current,
                        fallback_tz: e.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Used for recipients with no known timezone.
                  </p>
                </div>
              </>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="campaign_cost_cap">Cost cap (USD)</Label>
              <Input
                id="campaign_cost_cap"
                type="number"
                min="0"
                step="0.01"
                placeholder="Optional"
                value={draft.cost_cap_dollars}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    cost_cap_dollars: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_media_url">MMS media URL</Label>
              <Input
                id="campaign_media_url"
                type="url"
                placeholder="https://cdn.example.com/offer.jpg"
                value={draft.media_url}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    media_url: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="campaign_discount_code">Discount code</Label>
              <div className="flex gap-2">
                <Input
                  id="campaign_discount_code"
                  placeholder="SAVE20"
                  value={draft.discount_code}
                  onChange={(e) =>
                    setDraft((current) => ({
                      ...current,
                      discount_code: e.target.value,
                    }))
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onInsertDiscountCode()}
                >
                  <Gift className="h-4 w-4" />
                  Insert
                </Button>
              </div>
              {discountCodes.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {discountCodes.slice(0, 5).map((item) => {
                    const block = discountChipBlock(item);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="rounded-md border px-2 py-1 text-xs transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={Boolean(block)}
                        onClick={() => onInsertDiscountCode(item.code)}
                        title={
                          block ? `${item.label} — ${block.reason}` : item.label
                        }
                      >
                        {item.code} · {item.label}
                        {block ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {block.tag}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  No store discount codes found. Enter a code manually or{" "}
                  <Link
                    href={asRoute("/app/settings/integrations")}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    connect ecommerce discounts
                  </Link>{" "}
                  first.
                </div>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="campaign_body">
                Message ({campaignSegments} segment
                {campaignSegments === 1 ? "" : "s"} · local estimate only)
              </Label>
              <div className="flex items-center gap-3">
                <SmsCharCount body={draft.body} max={SMS_BODY_MAX} />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowComposerPreview((open) => !open)}
                >
                  <Eye className="mr-1.5 h-4 w-4" />
                  {showComposerPreview ? "Hide preview" : "Preview"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void onDraftWithAI()}
                  disabled={pending !== null}
                >
                  {pending === "campaign-ai" ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  Write with AI
                </Button>
              </div>
            </div>
            <Textarea
              id="campaign_body"
              value={draft.body}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  body: e.target.value,
                }))
              }
              rows={4}
              maxLength={SMS_BODY_MAX}
              required
            />
            {showComposerPreview ? (
              <SmsPhonePreview body={draft.body} mediaUrl={draft.media_url} />
            ) : null}
          </div>
          {/* SMS-036: A/B message variants. */}
          <div className="space-y-2 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox
                checked={draft.ab_enabled}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    ab_enabled: e.target.checked,
                  }))
                }
              />
              A/B test the message
            </label>
            {draft.ab_enabled ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Recipients are split deterministically across variants by
                  weight. Needs at least two variants with a body; otherwise the
                  main message above is sent.
                </p>
                {draft.ab_variants.map((variant, index) => (
                  <div
                    key={index}
                    className="space-y-2 rounded-md border border-dashed p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        Variant{" "}
                        {variant.label || String.fromCharCode(65 + index)}
                      </span>
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`ab_weight_${index}`}
                          className="text-xs text-muted-foreground"
                        >
                          Weight
                        </Label>
                        <Input
                          id={`ab_weight_${index}`}
                          type="number"
                          min="0"
                          className="h-8 w-20"
                          value={variant.weight}
                          onChange={(e) =>
                            setDraft((current) => ({
                              ...current,
                              ab_variants: current.ab_variants.map((v, i) =>
                                i === index
                                  ? { ...v, weight: e.target.value }
                                  : v,
                              ),
                            }))
                          }
                        />
                        {draft.ab_variants.length > 2 ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                ab_variants: current.ab_variants.filter(
                                  (_, i) => i !== index,
                                ),
                              }))
                            }
                          >
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <Textarea
                      aria-label={`Variant ${variant.label || String.fromCharCode(65 + index)} body`}
                      value={variant.body}
                      onChange={(e) =>
                        setDraft((current) => ({
                          ...current,
                          ab_variants: current.ab_variants.map((v, i) =>
                            i === index ? { ...v, body: e.target.value } : v,
                          ),
                        }))
                      }
                      rows={3}
                      maxLength={SMS_BODY_MAX}
                    />
                    <SmsCharCount body={variant.body} max={SMS_BODY_MAX} />
                  </div>
                ))}
                {draft.ab_variants.length < 5 ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        ab_variants: [
                          ...current.ab_variants,
                          {
                            label: String.fromCharCode(
                              65 + current.ab_variants.length,
                            ),
                            body: "",
                            weight: "0",
                          },
                        ],
                      }))
                    }
                  >
                    Add variant
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={draft.link_tracking}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  link_tracking: e.target.checked,
                }))
              }
            />
            Track SMS link clicks
          </label>
          <Button
            type="submit"
            disabled={
              pending === "campaign" ||
              (!dispatchAvailable && draft.status === "scheduled")
            }
          >
            {draft.editing_id ? "Save changes" : "Save draft"}
          </Button>
        </form>

        {campaigns.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Search campaigns"
              placeholder="Search campaigns"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setVisible(PAGE_STEP);
              }}
              className="h-9 max-w-xs"
            />
            <Select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setVisible(PAGE_STEP);
              }}
              className="h-9 max-w-[10rem]"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="scheduled">Scheduled</option>
              <option value="sending">Sending</option>
              <option value="sent">Sent</option>
              <option value="paused">Paused</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </Select>
            <span className="text-xs text-muted-foreground">
              {filtered.length} of {campaigns.length}
            </span>
          </div>
        ) : null}

        <div className="space-y-2">
          {shown.map((item) => {
            const campaignSender = senders.find(
              (senderProfile) => senderProfile.id === item.sender_profile_id,
            );
            const senderIsPaused = campaignSender
              ? senderPaused(campaignSender)
              : false;
            const timestamp = campaignTimestamp(item);
            const canQueue = ["draft", "scheduled", "paused"].includes(
              item.status,
            );
            const canExport =
              reportExportAvailable &&
              ["sending", "sent", "paused", "failed", "cancelled"].includes(
                item.status,
              );
            const canCancel = [
              "draft",
              "scheduled",
              "paused",
              "sending",
            ].includes(item.status);
            const menuItems = [
              {
                label: "Edit draft",
                icon: <Pencil className="h-4 w-4" />,
                onSelect: () => onEditCampaign(item),
              },
              {
                label: "Duplicate",
                icon: <Copy className="h-4 w-4" />,
                onSelect: () => onDuplicateCampaign(item),
              },
              ...(canExport
                ? ([
                    {
                      label: "Export all recipients",
                      icon: <Download className="h-4 w-4" />,
                      onSelect: () => onExportReport(item, "all"),
                    },
                    {
                      label: "Export failures",
                      icon: <Download className="h-4 w-4" />,
                      onSelect: () => onExportReport(item, "problems"),
                    },
                    {
                      label: "Export undelivered",
                      icon: <Download className="h-4 w-4" />,
                      onSelect: () => onExportReport(item, "undelivered"),
                    },
                    {
                      label: "Export blocked",
                      icon: <Download className="h-4 w-4" />,
                      onSelect: () => onExportReport(item, "blocked"),
                    },
                  ] as const)
                : []),
              ...(canCancel
                ? ([
                    {
                      label: "Cancel campaign",
                      destructive: true,
                      onSelect: () => {
                        cancelTriggerRef.current =
                          document.activeElement instanceof HTMLButtonElement
                            ? document.activeElement
                            : null;
                        setCancelTarget(item);
                      },
                    },
                  ] as const)
                : []),
            ];
            return (
              <div key={item.id} className="rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">{item.name}</div>
                  <div className="flex items-center gap-2">
                    {senderIsPaused ? (
                      <Badge variant="destructive">sender paused</Badge>
                    ) : null}
                    <Badge variant="secondary">{item.status}</Badge>
                  </div>
                </div>
                <div className="mt-1 text-muted-foreground">{item.body}</div>
                {item.media_url ? (
                  <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    <Clapperboard className="h-3.5 w-3.5" />
                    MMS media attached
                  </div>
                ) : null}
                {timestamp ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {timestamp.label} {formatDateTime(timestamp.iso)}
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    {smsSegments(item.body)} segment
                    {smsSegments(item.body) === 1 ? "" : "s"} · local estimate
                    only
                    {item.metadata?.link_tracking
                      ? " · link tracking requested; click resolver release-held"
                      : ""}
                    {item.stats ? (
                      <>
                        {" "}
                        · {statNumber(item.stats, "queued")} queued ·{" "}
                        {statNumber(item.stats, "sent")} sent ·{" "}
                        {statNumber(item.stats, "failed")} failed
                      </>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setPreviewId((current) =>
                          current === item.id ? null : item.id,
                        )
                      }
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      Preview
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void onLoadCampaignReport(item)}
                      disabled={
                        !reportExportAvailable ||
                        pending === `report:${item.id}`
                      }
                    >
                      <BarChart3 className="mr-2 h-4 w-4" />
                      Report
                    </Button>
                    {canQueue ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={(event) => {
                          broadcastTriggerRef.current = event.currentTarget;
                          setBroadcastTarget(item);
                        }}
                        disabled={
                          !dispatchAvailable ||
                          pending === `broadcast:${item.id}` ||
                          !setupCanSend ||
                          senderIsPaused
                        }
                      >
                        <Send className="mr-2 h-4 w-4" />
                        Queue
                      </Button>
                    ) : null}
                    {["draft", "paused"].includes(item.status) ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onScheduleCampaign(item)}
                        disabled={
                          !dispatchAvailable ||
                          pending === `schedule:${item.id}`
                        }
                      >
                        Schedule
                      </Button>
                    ) : null}
                    {item.status === "sending" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void onCampaignLifecycle(item, "pause")}
                        disabled={pending === `pause:${item.id}`}
                      >
                        Pause
                      </Button>
                    ) : null}
                    {item.status === "paused" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void onCampaignLifecycle(item, "resume")}
                        disabled={
                          !dispatchAvailable || pending === `resume:${item.id}`
                        }
                      >
                        Resume
                      </Button>
                    ) : null}
                    <ActionMenu
                      label={`Actions for ${item.name}`}
                      items={menuItems}
                    />
                  </div>
                </div>
                {previewId === item.id ? (
                  <div className="mt-3">
                    <SmsPhonePreview
                      body={item.body}
                      mediaUrl={item.media_url}
                    />
                  </div>
                ) : null}
                {reports[item.id] ? (
                  <CampaignReportPanel
                    dispatchAvailable={dispatchAvailable}
                    report={reports[item.id]}
                    onRetryFailed={() => onRetryFailed(item)}
                    retrying={pending === `retry:${item.id}`}
                  />
                ) : null}
              </div>
            );
          })}
          {visible < filtered.length ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => setVisible((v) => v + PAGE_STEP)}
            >
              Show {Math.min(PAGE_STEP, filtered.length - visible)} more
            </Button>
          ) : null}
          {loadError && campaigns.length === 0 ? (
            <CardLoadError
              message="SMS campaigns could not be loaded."
              onRetry={onRetry}
            />
          ) : !loading && campaigns.length === 0 ? (
            <EmptyState
              icon={MessageSquarePlus}
              title="No SMS campaign drafts yet"
              description="Compose a message above, pick an audience, and save your first draft before broadcasting."
            />
          ) : !loading && filtered.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No campaigns match your search or filter.
            </div>
          ) : null}
        </div>
      </CardContent>

      {dispatchAvailable && broadcastTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setBroadcastTarget(null);
          }}
          title="Send this SMS broadcast now?"
          description={`This immediately queues "${broadcastTarget.name}" to ${broadcastRecipients.toLocaleString()} opted-in recipient${
            broadcastRecipients === 1 ? "" : "s"
          } in ${broadcastList?.name ?? "the selected list"}. Opted-out numbers are skipped. Provider effects cannot be undone; no balance or purchase entitlement is inferred here.`}
          confirmLabel="Send broadcast"
          confirmVariant="default"
          fallbackFocusRef={broadcastTriggerRef}
          onConfirm={async () => {
            const target = broadcastTarget;
            setBroadcastTarget(null);
            await onBroadcastCampaign(target);
          }}
        />
      ) : null}
      {cancelTarget ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setCancelTarget(null);
          }}
          title="Cancel this campaign?"
          description={`Cancelling "${cancelTarget.name}" is terminal — an in-flight or scheduled send stops and cannot be resumed.`}
          confirmLabel="Cancel campaign"
          fallbackFocusRef={cancelTriggerRef}
          onConfirm={async () => {
            const target = cancelTarget;
            setCancelTarget(null);
            await onCampaignLifecycle(target, "cancel");
          }}
        />
      ) : null}
    </Card>
  );
}
