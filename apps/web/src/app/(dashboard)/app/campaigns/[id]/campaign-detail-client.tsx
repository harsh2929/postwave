// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  Clock,
  FileWarning,
  FlaskConical,
  Loader2,
  Save,
  Send,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyEntityLink } from "@/components/copy-entity-link";
import { EntityPresence, entityRefFor } from "@/components/entity-presence";
import { RecordLastViewed } from "@/components/record-last-viewed";
import { RelativeTime } from "@/components/relative-time";
import { ApiError, apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami, whoamiFresh } from "@/lib/auth-api";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  type AudienceCountResult,
  type Campaign,
  type UpdateCampaignInput,
  countAudience,
  getCampaignETag,
  getCampaign,
  sendCampaign,
} from "@/lib/campaigns-api";
import { listSegments } from "@/lib/segments-api";
import { getFromNameSuggestions } from "@/lib/from-name-picker-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { toast } from "sonner";

import { campaignStatusLabel } from "../campaign-list-helpers";
import {
  blocksOf,
  type CampaignVariant,
  variantsOf,
} from "./campaign-detail-helpers";
import {
  campaignHasAuthoritativeSemanticPoll,
  ensureCurrentCampaignPollsReady,
} from "@/lib/campaign-polls-api";
import type { CampaignAudienceChoice } from "./campaign-audience-section";
import { CampaignDetailActions } from "./campaign-detail-actions";
import type { CampaignContentUpdate } from "./campaign-content-editor";
import {
  buildCampaignUpdateInput,
  useCampaignSaveWorkflow,
  validateCampaignContentLinks,
} from "./use-campaign-save-workflow";
import { EditLeaseBanner } from "@/components/campaigns/edit-lease-banner";
import { DraftCheckpointBanner } from "@/components/campaigns/draft-checkpoint-banner";
import { useEditLease } from "@/lib/use-edit-lease";
import { useEditorCheckpoint } from "@/lib/use-editor-checkpoint";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  assertFreshCampaignWriteAuthority,
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";

const CampaignIntelligencePanel = lazy(() =>
  import("@/components/mailchimp-parity/campaign-intelligence-panel").then(
    (mod) => ({ default: mod.CampaignIntelligencePanel }),
  ),
);

const CampaignContentEditor = lazy(() =>
  import("./campaign-content-editor").then((mod) => ({
    default: mod.CampaignContentEditor,
  })),
);

const CampaignSemanticSourceEditor = lazy(() =>
  import("./campaign-semantic-source-editor").then((mod) => ({
    default: mod.CampaignSemanticSourceEditor,
  })),
);

const SEMANTIC_AUTHORING_ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_CAMPAIGN_CONTENT_AST_V2 === "1";

const CampaignVariantsSection = lazy(() =>
  import("./campaign-variants-section").then((mod) => ({
    default: mod.CampaignVariantsSection,
  })),
);

const CampaignOperationalPanels = lazy(() =>
  import("./campaign-operational-panels").then((mod) => ({
    default: mod.CampaignOperationalPanels,
  })),
);

const CampaignAudienceSection = lazy(() =>
  import("./campaign-audience-section").then((mod) => ({
    default: mod.CampaignAudienceSection,
  })),
);

const CampaignFieldsSection = lazy(() =>
  import("./campaign-fields-section").then((mod) => ({
    default: mod.CampaignFieldsSection,
  })),
);

const CampaignTrackingSection = lazy(() =>
  import("./campaign-tracking-section").then((mod) => ({
    default: mod.CampaignTrackingSection,
  })),
);

const CampaignTestSendSection = lazy(() =>
  import("./campaign-test-send-section").then((mod) => ({
    default: mod.CampaignTestSendSection,
  })),
);

const CampaignActivityTimeline = lazy(() =>
  import("./campaign-activity-timeline").then((mod) => ({
    default: mod.CampaignActivityTimeline,
  })),
);

const CopilotRail = lazy(() =>
  import("@/components/ai/copilot-rail").then((mod) => ({
    default: mod.CopilotRail,
  })),
);

const EmailPreview = lazy(() =>
  import("@/components/campaigns/email-preview").then((mod) => ({
    default: mod.EmailPreview,
  })),
);

const CampaignSendDialog = lazy(() =>
  import("../campaign-send-dialogs").then((mod) => ({
    default: mod.CampaignSendDialog,
  })),
);

const EDITABLE_STATUSES: readonly Campaign["status"][] = [
  "draft",
  "scheduled",
  "paused",
  "failed",
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function DetailSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-md" />
      <div className="grid gap-4 rounded-md border bg-card p-4 md:grid-cols-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-md" />
        ))}
      </div>
      <Skeleton className="h-[360px] w-full rounded-md" />
    </div>
  );
}

export function CampaignDetailClient() {
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [draftCampaign, setCampaign] = useState<Campaign | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);

  // Guard browser unload + in-app navigation against silently dropping edits
  // (CAMP-003), matching the newsletter editor.
  useUnsavedChangesGuard(dirty);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const userId = meQuery.data?.user_id ?? "anon";
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  // Include the explicit viewer flag as a defensive fallback for a stale or
  // partially rolled-out whoami representation that omitted effective_role.
  const role = meQuery.data?.viewer_mode ? "viewer" : effectiveRole;
  const canWrite = canWriteCampaigns(meQuery.data);
  const campaignsBaseKey = useMemo(
    () => base("campaigns", tenantId, role),
    [role, tenantId],
  );
  const campaignKey = useMemo(
    () => qk.campaign(tenantId, role, id),
    [id, role, tenantId],
  );
  const segmentsKey = useMemo(
    () => qk.segments(tenantId, role, { surface: "campaign-editor" }),
    [role, tenantId],
  );
  const campaignQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(id),
    enabled: meQuery.isFetched,
    staleTime: STALE.detail,
  });
  const segmentsQuery = useQuery({
    queryKey: segmentsKey,
    // Do not swallow the failure into an empty list: an unreachable segments
    // endpoint would render as "this workspace has no segments".
    queryFn: () => listSegments(),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });
  const listsQuery = useQuery({
    queryKey: qk.lists(tenantId, role, { surface: "campaign-editor" }),
    // Same rule as segments: a failed catalogue is shown as a failure, never
    // as a workspace with no lists.
    // Loaded on demand: the list catalogue decoder is not needed to paint
    // the editor, so it stays out of the route's first chunk.
    queryFn: async ({ signal }) =>
      (await import("@/lib/audience-admin-api")).listAudienceLists("", signal),
    enabled: meQuery.isFetched,
    staleTime: STALE.list,
  });

  useEffect(() => {
    setCampaign(null);
    setDirty(false);
    setTestEmail("");
    setSendOpen(false);
  }, [id, role, tenantId, userId]);

  useEffect(() => {
    if (!campaignQuery.data || dirty) return;
    setCampaign(campaignQuery.data);
  }, [campaignQuery.data, dirty]);

  const campaign =
    draftCampaign?.id === id && draftCampaign.tenant_id === tenantId
      ? draftCampaign
      : null;
  const statusEditable = campaign
    ? EDITABLE_STATUSES.includes(campaign.status)
    : false;
  const isEditable = statusEditable && canWrite;

  // Hold the advisory single-writer lease only for a session that can really
  // write this record. Viewer mode must not POST, renew, or DELETE a lease.
  const editLease = useEditLease(isEditable ? id : undefined);
  const hasAuthoritativeSemanticPoll = campaignHasAuthoritativeSemanticPoll(
    campaign?.source_mode,
    campaign?.content_schema_version,
    campaign?.content_blocks,
  );
  const fromNameQuery = useQuery({
    queryKey: [...campaignsBaseKey, "from-name-picker", 180, 2],
    queryFn: ({ signal }) =>
      getFromNameSuggestions({ days: 180, minCampaigns: 2, signal }),
    enabled: meQuery.isSuccess && isEditable,
    staleTime: STALE.dashboard,
  });

  // Durable draft checkpoint (ECO-03). `useUnsavedChangesGuard` above is a
  // confirm dialog and nothing more — until now it was the ONLY thing between
  // an in-progress campaign and losing it, because nothing on any surface had
  // ever written to the checkpoint API the server has been serving all along.
  //
  // The content is the exact payload Save would send, so a resumed draft and a
  // saved one cannot diverge. Only sent while the editor is dirty: check
  // pointing a pristine record would create a draft identical to the saved
  // state, which the next open would then offer to "restore".
  const checkpointContent = useMemo(
    () => (dirty && campaign ? buildCampaignUpdateInput(campaign) : null),
    [campaign, dirty],
  );
  const restoreCheckpoint = useCallback(
    (restored: UpdateCampaignInput) => {
      if (!canWrite) return;
      // Applied to the in-memory draft only, and marked dirty. Restoring is not
      // saving: the person still decides whether this becomes the record.
      setCampaign((c) => (c ? { ...c, ...restored } : c));
      setDirty(true);
    },
    [canWrite],
  );
  const checkpoint = useEditorCheckpoint<UpdateCampaignInput>({
    entityKey: "campaign",
    entityId: id,
    content: checkpointContent,
    // The SAVED record's timestamp, not the local draft's — a checkpoint is
    // only worth offering when it holds work the record does not.
    recordUpdatedAt: campaignQuery.data?.updated_at,
    canEdit: isEditable,
    onRestore: restoreCheckpoint,
  });

  const segments = Array.isArray(segmentsQuery.data) ? segmentsQuery.data : [];
  const lists = Array.isArray(listsQuery.data) ? listsQuery.data : [];
  const audience: CampaignAudienceChoice = {
    list_id: campaign?.list_id ?? "",
    segment_id: campaign?.segment_id ?? "",
  };
  // A frozen campaign sends to its snapshot, so its list or segment's live
  // size would describe an audience it will not send to.
  const audienceFrozen = campaign?.audience_mode === "static";
  const countable =
    !audienceFrozen && Boolean(audience.list_id || audience.segment_id);
  const audienceCountKey = useMemo(
    () =>
      [
        ...campaignKey,
        "audience-count",
        audience.list_id,
        audience.segment_id,
      ] as const,
    [campaignKey, audience.list_id, audience.segment_id],
  );
  const audienceCountQuery = useQuery({
    queryKey: audienceCountKey,
    queryFn: ({ signal }) =>
      countAudience(
        audience.list_id
          ? { list_id: audience.list_id }
          : { segment_id: audience.segment_id },
        { signal },
      ),
    enabled: meQuery.isFetched && countable,
    staleTime: STALE.list,
  });
  const audienceCount: AudienceCountResult | null = countable
    ? (audienceCountQuery.data ?? null)
    : null;
  const audienceCountLoading =
    countable &&
    (audienceCountQuery.isPending || audienceCountQuery.isFetching);
  // A 422 names what is wrong with the choice (a list this workspace does not
  // have); anything else only means the count is unknown, never zero.
  const audienceCountError =
    countable && audienceCountQuery.isError
      ? audienceCountQuery.error instanceof ApiError &&
        audienceCountQuery.error.status === 422
        ? apiErrorMessage(audienceCountQuery.error)
        : "Couldn't count this audience right now — no number here means unknown, not zero recipients."
      : null;
  const loading = meQuery.isLoading || (campaignQuery.isPending && !campaign);
  const loadError =
    campaignQuery.error instanceof Error
      ? campaignQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : campaignQuery.isError
          ? "Could not load this campaign — this is a failed request, not an empty draft."
          : null;

  const setField = <K extends keyof Campaign>(key: K, value: Campaign[K]) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) => (c ? { ...c, [key]: value } : c));
  };

  // A list and a segment are mutually exclusive, so the audience changes as
  // one edit: both halves in the same state update.
  const setAudience = (next: CampaignAudienceChoice) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) =>
      c ? { ...c, list_id: next.list_id, segment_id: next.segment_id } : c,
    );
  };

  const setBlocks = ({
    blocks,
    bodyHtml,
    plainText,
  }: CampaignContentUpdate) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) =>
      c
        ? {
            ...c,
            editor_mode: "blocks",
            content_blocks: blocks,
            body_html: bodyHtml,
            plain_text: plainText,
          }
        : c,
    );
  };

  const setSemanticSource = ({
    nodes,
    factContract,
  }: {
    nodes: Array<Record<string, unknown>>;
    factContract: Record<string, unknown>;
  }) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((current) =>
      current
        ? {
            ...current,
            source_mode: "semantic",
            content_schema_version: 2,
            content_blocks: nodes,
            fact_contract: factContract,
          }
        : current,
    );
  };

  const setReusableSectionIds = (ids: string[]) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) => (c ? { ...c, reusable_section_ids: ids } : c));
  };

  const setVariants = (variants: CampaignVariant[]) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) => (c ? { ...c, variants } : c));
  };

  const patchTracking = (key: string, value: unknown) => {
    if (!isEditable) return;
    setDirty(true);
    setCampaign((c) =>
      c
        ? {
            ...c,
            tracking_settings: { ...(c.tracking_settings ?? {}), [key]: value },
          }
        : c,
    );
  };

  const { save, saving, sendTest } = useCampaignSaveWorkflow({
    campaign,
    campaignKey,
    campaignsBaseKey,
    queryClient,
    setCampaign,
    setDirty,
    testEmail,
    canWrite: isEditable,
    openedIdentity: meQuery.data,
  });

  /** Drop every cached campaign list view; the detail cache is set directly. */
  const invalidateCampaigns = (): void => {
    void queryClient.invalidateQueries({
      queryKey: campaignsBaseKey,
      exact: false,
    });
  };

  const applyUpdated = (next: Campaign) => {
    setCampaign(next);
    setDirty(false);
    queryClient.setQueryData<Campaign>(campaignKey, next);
    void queryClient.invalidateQueries({
      queryKey: campaignsBaseKey,
      exact: false,
    });
  };

  const verifySemanticPollContracts = async (): Promise<void> => {
    if (!campaign || !hasAuthoritativeSemanticPoll) return;
    try {
      await ensureCurrentCampaignPollsReady(campaign.id, {
        beforeWrite: () => confirmFreshCampaignWriteAuthority(meQuery.data),
      });
    } catch (error) {
      const detail =
        error instanceof Error && error.message.trim()
          ? ` ${error.message}`
          : "";
      throw new Error(
        `Exact semantic poll contracts could not be verified, so this campaign was not queued or scheduled.${detail}`,
      );
    } finally {
      await queryClient.invalidateQueries({
        queryKey: base("campaign-poll-receipts", tenantId, role),
        exact: false,
      });
    }
  };

  const handleSend = async () => {
    if (!campaign || !isEditable || !meQuery.data) {
      toast.error(CAMPAIGN_READ_ONLY_MESSAGE);
      return;
    }
    if (dirty) {
      toast.error("Save the current campaign changes before sending.");
      return;
    }
    const contentLinkError = await validateCampaignContentLinks(campaign);
    if (contentLinkError) {
      toast.error(contentLinkError);
      return;
    }
    setSending(true);
    try {
      assertFreshCampaignWriteAuthority(meQuery.data, await whoamiFresh());
      await verifySemanticPollContracts();
      assertFreshCampaignWriteAuthority(meQuery.data, await whoamiFresh());
      const res = await sendCampaign(campaign.id);
      if ("campaign_id" in res && res.status === "approval_required") {
        // The approval id is the only handle the operator has for chasing a
        // pending approval; the list page surfaces it and this one dropped it.
        toast.message("Approval requested.", {
          description: res.approval_id
            ? `Approval ${res.approval_id} is pending.`
            : undefined,
        });
        setSendOpen(false);
        invalidateCampaigns();
        return;
      }
      if ("id" in res) applyUpdated(res);
      setSendOpen(false);
      // Unconditionally, not just inside the `"id" in res` branch above. A real
      // queued send resolves to CampaignQueueResponse, which carries
      // `campaign_id` rather than `id`, so applyUpdated — the only thing that
      // invalidated the list here — ran exactly when the send had NOT queued.
      // The campaign moves to `sending` on the server while every cached view
      // of it keeps the pre-send status.
      invalidateCampaigns();
      if (
        "campaign_id" in res &&
        res.assurance_rollout_mode === "warn" &&
        res.assurance_status !== "ok"
      ) {
        toast.warning(
          "Campaign queued with a Campaign Assurance advisory. Review the current assurance result before warning mode advances to blocking.",
        );
      } else {
        toast.success("On its way - your campaign is sending.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start send.");
    } finally {
      setSending(false);
    }
  };

  if (loading) return <DetailSkeleton />;

  if (!campaign && loadError) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={FileWarning}
          title="Could not load this campaign"
          description={loadError}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void meQuery.refetch();
                  void campaignQuery.refetch();
                  void segmentsQuery.refetch();
                  void listsQuery.refetch();
                }}
              >
                Retry
              </Button>
              <Button asChild variant="ghost">
                <Link href="/app/campaigns">
                  <ArrowLeft className="h-4 w-4" />
                  Back to campaigns
                </Link>
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={FileWarning}
          title="Campaign not found"
          description="This campaign may have been deleted or never existed."
          action={
            <Button asChild>
              <Link href="/app/campaigns">
                <ArrowLeft className="h-4 w-4" />
                Back to campaigns
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  const blocks = blocksOf(campaign);
  const variants = variantsOf(campaign);
  const tracking = campaign.tracking_settings ?? {};
  const editorMode = campaign.editor_mode ?? "html";
  const isSent = campaign.status === "sent" || campaign.status === "sending";
  const previewHtml =
    editorMode === "plain_text"
      ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${escapeHtml(
          campaign.plain_text ?? "",
        )}</pre>`
      : (campaign.body_html ?? "");

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
      {/* Before the work, not after: a 409 on save has already cost the person
          the rewrite. */}
      <EditLeaseBanner holder={editLease.blockedBy} />
      {/* The other half of continuity: the cursor says WHICH campaign you were
          on, this says what you had actually typed into it. Offered, never
          applied — and on a sent campaign it is what explains why this surface
          can only review the draft. */}
      <DraftCheckpointBanner state={checkpoint} canEdit={isEditable} />
      <Breadcrumb
        items={[
          { label: "Campaigns", href: asRoute("/app/campaigns") },
          { label: campaign.name },
        ]}
      />
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <Button
            asChild
            variant="ghost"
            size="icon"
            aria-label="Back to campaigns"
            title="Back to campaigns"
          >
            <Link href="/app/campaigns">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {campaign.name}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {campaignStatusLabel(campaign.status)} · updated{" "}
              <RelativeTime iso={campaign.updated_at} />
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <EntityPresence entityRef={entityRefFor("campaign", campaign.id)} />
          <CopyEntityLink entity="campaign" id={campaign.id} />
          <RecordLastViewed entity="campaign" id={campaign.id} />
          <CampaignDetailActions campaign={campaign} identity={meQuery.data} />
          <Button asChild variant="outline">
            <Link href={`/app/campaigns/${campaign.id}/ab`}>
              <FlaskConical className="h-4 w-4" />
              A/B
            </Link>
          </Button>
          {isEditable ? (
            <>
              {/* Live save-state indicator so users always know whether their
                  work is persisted (CAMP-040). */}
              <span
                className="text-xs text-muted-foreground"
                aria-live="polite"
                data-testid="save-state"
              >
                {saving ? (
                  "Saving…"
                ) : dirty ? (
                  <>
                    {/* "Unsaved changes" alone was true and unhelpful: it said
                        nothing about whether closing the tab would cost them
                        the work. Now it can, because a checkpoint exists. */}
                    Unsaved changes
                    {checkpoint.saving ? (
                      " · keeping a draft…"
                    ) : checkpoint.lastSavedAt ? (
                      <>
                        {" · draft kept "}
                        <RelativeTime iso={checkpoint.lastSavedAt} />
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    Saved · <RelativeTime iso={campaign.updated_at} />
                  </>
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled
                title={CAMPAIGN_SCHEDULING_RELEASE_HOLD}
              >
                <Clock className="h-4 w-4" />
                Scheduling unavailable
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={dirty}
                title={
                  dirty ? "Save campaign changes before sending" : undefined
                }
                onClick={() => setSendOpen(true)}
              >
                <Send className="h-4 w-4" />
                Send
              </Button>
              <Button
                type="button"
                onClick={() => void save()}
                disabled={saving || !dirty}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </>
          ) : null}
        </div>
      </header>

      {!canWrite && statusEditable ? (
        <div
          role="status"
          className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
        >
          {CAMPAIGN_READ_ONLY_MESSAGE}
        </div>
      ) : null}

      {isSent ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-success/30 bg-success/5 p-4">
          <div>
            <div className="font-medium">This campaign has been sent.</div>
            <p className="text-sm text-muted-foreground">
              Editing is closed. See how it performed in the full report.
            </p>
          </div>
          <Button asChild>
            <Link href={`/app/inbox-reality/campaigns/${campaign.id}`}>
              <BarChart3 className="h-4 w-4" />
              View report
            </Link>
          </Button>
        </div>
      ) : null}

      <Suspense fallback={<Skeleton className="h-64 w-full rounded-md" />}>
        <CampaignOperationalPanels
          campaignId={campaign.id}
          tenantId={tenantId}
          role={role}
          identity={meQuery.data}
          canOverride={
            canWrite && (effectiveRole === "owner" || effectiveRole === "admin")
          }
          canEdit={isEditable}
          canApply={!dirty && isEditable}
          campaignETag={getCampaignETag(campaign.id)}
          canConfigureHoldout={
            isEditable &&
            (effectiveRole === "owner" || effectiveRole === "admin")
          }
          canConfigureVanity={isEditable}
          hasSemanticPoll={hasAuthoritativeSemanticPoll}
          canConfigurePolls={!dirty && !saving && isEditable && canWrite}
          pollConfigurationBlockedReason={
            dirty || saving
              ? "Save the campaign first. Revision freeze reads the persisted semantic draft, so this screen will not materialize poll keys while local changes are pending."
              : !isEditable
                ? "Poll contracts can be materialized only while the campaign is editable. Existing immutable receipts remain available above."
                : effectiveRole === "viewer"
                  ? "An editor, admin, or owner must freeze and materialize semantic poll contracts."
                  : undefined
          }
        />
      </Suspense>

      <Suspense fallback={<Skeleton className="h-32 w-full rounded-md" />}>
        <CampaignIntelligencePanel campaignId={campaign.id} />
      </Suspense>

      {isEditable ? (
        <>
          <Suspense fallback={<Skeleton className="h-32 w-full rounded-md" />}>
            <CampaignAudienceSection
              audience={audience}
              audienceCount={audienceCount}
              audienceCountError={audienceCountError}
              audienceCountLoading={audienceCountLoading}
              frozen={audienceFrozen}
              lists={lists}
              listsError={listsQuery.isError}
              listsLoading={listsQuery.isPending}
              onAudienceChange={setAudience}
              onRetryLists={() => void listsQuery.refetch()}
              onRetrySegments={() => void segmentsQuery.refetch()}
              segments={segments}
              segmentsError={segmentsQuery.isError}
              segmentsLoading={segmentsQuery.isPending}
            />
          </Suspense>

          <Suspense fallback={<Skeleton className="h-64 w-full rounded-md" />}>
            <CampaignFieldsSection
              campaign={campaign}
              editorMode={editorMode}
              identity={meQuery.data}
              fromNameSuggestions={{
                data: fromNameQuery.data,
                pending: fromNameQuery.isPending,
                error: fromNameQuery.isError,
                retrying: fromNameQuery.isFetching,
                onRetry: () => void fromNameQuery.refetch(),
              }}
              onFieldChange={setField}
            />
          </Suspense>

          {campaign.source_mode === "semantic" ? (
            <Suspense
              fallback={<Skeleton className="h-64 w-full rounded-md" />}
            >
              <CampaignSemanticSourceEditor
                enabled={SEMANTIC_AUTHORING_ENABLED}
                factContract={campaign.fact_contract ?? {}}
                nodes={campaign.content_blocks ?? []}
                onChange={setSemanticSource}
              />
            </Suspense>
          ) : null}

          {campaign.source_mode !== "semantic" && editorMode === "blocks" && (
            <Suspense
              fallback={<Skeleton className="h-64 w-full rounded-md" />}
            >
              <CampaignContentEditor
                campaignId={campaign.id}
                campaignName={campaign.name}
                campaignSubject={campaign.subject}
                blocks={blocks}
                selectedSectionIds={campaign.reusable_section_ids ?? []}
                onBlocksChange={setBlocks}
                onReusableSectionIdsChange={setReusableSectionIds}
              />
            </Suspense>
          )}

          <Suspense fallback={<Skeleton className="h-64 w-full rounded-md" />}>
            <EmailPreview html={previewHtml} />
          </Suspense>

          <Suspense fallback={<Skeleton className="h-40 w-full rounded-md" />}>
            <CampaignVariantsSection
              campaignBodyHtml={campaign.body_html ?? ""}
              campaignPreviewText={campaign.preview_text ?? ""}
              campaignSubject={campaign.subject}
              onChange={setVariants}
              variants={variants}
            />
          </Suspense>

          <Suspense fallback={<Skeleton className="h-40 w-full rounded-md" />}>
            <CopilotRail
              subject={campaign.subject ?? ""}
              campaignId={campaign.id}
              // Lab / brief / idea picks land in the draft as an unsaved edit
              // (setField itself refuses when the draft is not editable).
              onApplySubject={(next) => setField("subject", next)}
            />
            <CampaignTrackingSection
              onChange={patchTracking}
              tracking={tracking}
            />
            <CampaignTestSendSection
              onChangeEmail={setTestEmail}
              onSend={() => void sendTest()}
              testEmail={testEmail}
            />
          </Suspense>
        </>
      ) : (
        <Suspense fallback={<Skeleton className="h-64 w-full rounded-md" />}>
          <EmailPreview html={previewHtml} />
        </Suspense>
      )}

      <Suspense fallback={<Skeleton className="h-32 w-full rounded-md" />}>
        <CampaignActivityTimeline campaign={campaign} />
      </Suspense>

      {sendOpen ? (
        <Suspense
          fallback={
            <span role="status" className="sr-only">
              Loading send review…
            </span>
          }
        >
          <CampaignSendDialog
            campaign={campaign}
            tenantId={tenantId}
            role={role}
            onConfirm={handleSend}
            onOpenChange={setSendOpen}
            open
            sending={sending}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
