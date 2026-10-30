// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Subscriber drill-down (web).
 *
 * Renders the same surface as the desktop slide-over, adapted to the
 * full-page web layout: header (avatar + status + engagement gauge),
 * stats grid, and tabbed body (Timeline / Lists & Tags / Engagement
 * chart). Mobile layouts collapse the tabs into a stacked accordion.
 *
 * Backend: GET /api/v1/subscribers/{id}/timeline aggregates every
 * relevant table. See apps/api/internal/subscribers/timeline.go.
 */
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Link2,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import {
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RecordLastViewed } from "@/components/record-last-viewed";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  SUBSCRIBER_TIMELINE_CATEGORIES,
  type SubscriberTimeline,
  type SubscriberTimelineCategory,
} from "@/lib/subscriber-timeline-api";
import {
  reauthorizeSubscriberMutation,
  subscriberAuthorityFromMe,
} from "@/lib/subscriber-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageShell } from "@/components/dashboard/page-shell";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { enumParam } from "@/lib/table-url-state";
import { getSubscriberNeighbors } from "@/lib/subscriber-nav-context";

import { SubscriberDetailSkeleton } from "./_detail-skeleton";
import {
  avatarHue,
  bucketTimeline,
  createTimelineAttemptGate,
  fmtDate,
  fmtPercent,
  initialsOf,
  isSuppressedStatus,
  isTimelineUnavailableError,
  profileSinceLabel,
  relTime,
  statusVariant,
} from "./subscriber-detail-helpers";
import { useSubscriberTimeline } from "./use-subscriber-timeline";

const TAB_IDS = [
  "timeline",
  "profile",
  "lists",
  "engagement",
  "preferences",
  "notes",
  "consent",
  "audit",
] as const;
type TabId = (typeof TAB_IDS)[number];
const tabUrlSchema = {
  tab: enumParam(TAB_IDS, "timeline"),
  timeline_category: enumParam(SUBSCRIBER_TIMELINE_CATEGORIES, "all"),
} as const;

const SubscriberDetailPanels = dynamic(
  () =>
    import("./subscriber-detail-panels").then(
      (module) => module.SubscriberDetailPanels,
    ),
  {
    ssr: false,
    loading: () => (
      <section
        role="status"
        aria-live="polite"
        aria-label="Loading subscriber details"
        className="min-h-40 rounded-lg border bg-card p-4 text-sm text-muted-foreground"
      >
        Loading subscriber activity…
      </section>
    ),
  },
);
const EmailHealthCard = dynamic(
  () => import("./_email-health-card").then((module) => module.EmailHealthCard),
  {
    ssr: false,
    loading: () => (
      <section
        aria-label="Email health"
        aria-busy="true"
        className="rounded-lg border bg-card p-4"
      >
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-muted-foreground"
        >
          Loading email health…
        </p>
      </section>
    ),
  },
);
const PredictionCards = dynamic(
  () => import("./_prediction-cards").then((module) => module.PredictionCards),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        Loading subscriber predictions…
      </p>
    ),
  },
);
const EditSubscriberDialog = dynamic(
  () => import("./_edit-dialog").then((module) => module.EditSubscriberDialog),
  {
    ssr: false,
    loading: () => (
      <span className="sr-only" role="status" aria-live="polite">
        Loading subscriber editor…
      </span>
    ),
  },
);
// The share-link button is a secondary header action; its module (and the
// entity route map behind it) loads after first paint so the route's eager
// chunk stays inside the bundle budget. The placeholder keeps the button's
// footprint so the header does not shift when it mounts.
const CopyEntityLink = dynamic(
  () =>
    import("@/components/copy-entity-link").then(
      (module) => module.CopyEntityLink,
    ),
  {
    loading: () => (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        aria-busy="true"
        aria-label="Copy link to this subscriber"
      >
        <Link2 className="h-4 w-4" />
        Copy link
      </Button>
    ),
  },
);

/* ----- circular engagement gauge (pure SVG) ---------------------- */
function Gauge({ score }: { score: number }): JSX.Element {
  const clamped = Math.max(0, Math.min(1, score));
  const r = 28;
  const c = 2 * Math.PI * r;
  const dash = c * clamped;
  // Theme-aware status tokens (flip correctly in dark mode) instead of fixed hex.
  const tone =
    clamped >= 0.6
      ? "hsl(var(--success))"
      : clamped >= 0.3
        ? "hsl(var(--warning-emphasis))"
        : "hsl(var(--destructive))";
  return (
    <svg
      width="72"
      height="72"
      viewBox="0 0 72 72"
      role="img"
      aria-label={`Engagement ${Math.round(clamped * 100)}%`}
    >
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        opacity="0.15"
      />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c}`}
        transform="rotate(-90 36 36)"
      />
      <text
        x="36"
        y="40"
        textAnchor="middle"
        fontSize="15"
        fontWeight={700}
        fill="currentColor"
      >
        {Math.round(clamped * 100)}
      </text>
    </svg>
  );
}

/* ----- page --------------------------------------------------------- */

export default function SubscriberDetailPage() {
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  // Header action (suppress/delete) feedback + locally-reflected status so
  // the drill-down isn't a read-only dead-end for actions.
  const [actionPending, setActionPending] = useState(false);
  const [suppressed, setSuppressed] = useState<boolean | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const editTriggerRef = useRef<HTMLButtonElement>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const actionGenerationRef = useRef(0);
  const initialRetryGate = useMemo(createTimelineAttemptGate, []);
  const { state: tabState, setState: setTabState } =
    useTableUrlState(tabUrlSchema);
  const tab = tabState.tab;
  const timelineCategory = tabState.timeline_category;
  const setTab = (next: TabId) => setTabState({ tab: next });
  const setTimelineCategory = (next: SubscriberTimelineCategory) =>
    setTabState({ timeline_category: next });

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const authority = meQuery.data
    ? subscriberAuthorityFromMe(meQuery.data)
    : null;
  // Suppression removal and paid-member grants are mounted under ScopeAdmin
  // server-side, so an editor holding write authority would only ever get a
  // 403 from them. Gate those two the way the list view does.
  const canAdmin = authority?.role === "owner" || authority?.role === "admin";
  const subscribersBaseKey = useMemo(
    () => base("subscribers", tenantId, role),
    [role, tenantId],
  );
  const subscriberDetailKey = useMemo(
    () => qk.subscriber(tenantId, role, id),
    [id, role, tenantId],
  );
  const {
    hasMore: hasMoreTimeline,
    loadMore,
    loadMoreError,
    loadingMore: loadingMoreTimeline,
    timeline,
    timelineKey,
    timelineQuery,
  } = useSubscriberTimeline({
    enabled: meQuery.isSuccess,
    id,
    role,
    tenantId,
    category: timelineCategory,
  });

  // Full record (tags / custom fields / status / version) powering the edit
  // dialog and the canonical Lists & Tags panel. Kept separate from the
  // timeline so a record-fetch failure doesn't hide the activity view.
  const recordKey = useMemo(
    () => [...subscriberDetailKey, "record"] as const,
    [subscriberDetailKey],
  );
  const recordQuery = useQuery({
    queryKey: recordKey,
    // The subscriber record client is only touched from this query and the
    // header mutations below; it loads on first use (bundle budget), the same
    // way the paywall client does.
    queryFn: async () =>
      (await import("@/lib/subscribers-api")).getSubscriber(id),
    enabled: meQuery.isSuccess,
    staleTime: STALE.detail,
  });
  const record = recordQuery.data;

  // Prev/next seeded from the list order the operator arrived through.
  const neighbors = useMemo(() => getSubscriberNeighbors(id), [id]);

  useEffect(() => {
    setSuppressed(null);
    actionGenerationRef.current += 1;
    actionAbortRef.current?.abort();
    actionAbortRef.current = null;
    setActionPending(false);
  }, [id]);

  useEffect(
    () => () => {
      actionGenerationRef.current += 1;
      actionAbortRef.current?.abort();
    },
    [],
  );

  const mutationIdentity = () =>
    `subscriber-detail:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;

  const runHeaderMutation = async (
    operation: (signal: AbortSignal, idempotencyKey: string) => Promise<void>,
    success: () => void | Promise<void>,
    fallback: string,
  ): Promise<void> => {
    if (!authority || actionPending) return;
    const generation = ++actionGenerationRef.current;
    const controller = new AbortController();
    actionAbortRef.current?.abort();
    actionAbortRef.current = controller;
    setActionPending(true);
    let committed = false;
    try {
      await reauthorizeSubscriberMutation(authority);
      await operation(controller.signal, mutationIdentity());
      committed = true;
      await reauthorizeSubscriberMutation(authority);
      if (generation !== actionGenerationRef.current) return;
      await success();
    } catch (err) {
      if (generation !== actionGenerationRef.current) return;
      if (committed) {
        void recordQuery.refetch();
        toast.info(
          "The change saved, but workspace access changed afterward. Reloading the profile.",
        );
      } else if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        [409, 412, 428].includes(Number((err as { status?: unknown }).status))
      ) {
        toast.error(
          "This subscriber changed while you were reviewing it. Reload and try again.",
        );
        void recordQuery.refetch();
      } else {
        toast.error(fallback);
      }
    } finally {
      if (generation === actionGenerationRef.current) {
        actionAbortRef.current = null;
        setActionPending(false);
      }
    }
  };

  const handleSuppress = async (): Promise<void> => {
    const recordId = record?.id;
    if (!recordId) return;
    await runHeaderMutation(
      async (signal, idempotencyKey) =>
        (await import("@/lib/subscribers-api")).suppressSubscriber(recordId, {
          expectedVersion: record.version,
          idempotencyKey,
          signal,
        }),
      async () => {
        setSuppressed(true);
        queryClient.setQueryData<
          InfiniteData<SubscriberTimeline, string | undefined>
        >(timelineKey, (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page, index) =>
                  index === 0
                    ? {
                        ...page,
                        stats: {
                          ...page.stats,
                          current_status: "suppressed",
                        },
                      }
                    : page,
                ),
              }
            : current,
        );
        void queryClient.invalidateQueries({
          queryKey: subscriberDetailKey,
          exact: false,
        });
        void queryClient.invalidateQueries({
          queryKey: subscribersBaseKey,
          exact: false,
        });
        toast.success("Subscriber suppressed.");
      },
      "Suppress failed. No change was confirmed.",
    );
  };

  // Remove only the reviewed reversible suppression. The canonical endpoint
  // intentionally does not restore status or consent; those require a
  // separate evidence-bearing review.
  const handleUnsuppress = async (): Promise<void> => {
    const recordId = record?.id;
    if (!recordId) return;
    await runHeaderMutation(
      async (signal, idempotencyKey) => {
        const { unsuppressSubscriber } = await import("@/lib/subscribers-api");
        const result = await unsuppressSubscriber(recordId, record.email, {
          idempotencyKey,
          signal,
        });
        if (result.subscriber_status_changed) {
          throw new Error("Unexpected subscriber status transition.");
        }
      },
      async () => {
        // Keep the visible status suppressed until the server says otherwise.
        // Removing one manual send gate is not proof of eligibility.
        void queryClient.invalidateQueries({
          queryKey: subscriberDetailKey,
          exact: false,
        });
        void queryClient.invalidateQueries({
          queryKey: subscribersBaseKey,
          exact: false,
        });
        toast.success(
          "Reviewed suppression removed. Subscriber status and consent were not changed.",
        );
      },
      "Could not confirm that the reviewed suppression was removed.",
    );
  };

  const handleDelete = async (): Promise<void> => {
    const recordId = record?.id;
    if (!recordId) return;
    await runHeaderMutation(
      async (signal, idempotencyKey) =>
        (await import("@/lib/subscribers-api")).deleteSubscriber(recordId, {
          expectedVersion: record.version,
          idempotencyKey,
          signal,
        }),
      async () => {
        queryClient.removeQueries({
          queryKey: subscriberDetailKey,
          exact: false,
        });
        void queryClient.invalidateQueries({
          queryKey: subscribersBaseKey,
          exact: false,
        });
        toast.success("Subscriber deleted.");
        router.push("/app/subscribers");
      },
      "Delete failed. No deletion was confirmed.",
    );
  };

  const buckets = useMemo(() => bucketTimeline(timeline?.events), [timeline]);
  const loadError = timelineQuery.error ?? meQuery.error;
  const loading = meQuery.isLoading || (timelineQuery.isPending && !timeline);
  const unavailable =
    !timeline && isTimelineUnavailableError(timelineQuery.error);
  const error =
    !timeline && loadError && !unavailable
      ? loadError instanceof Error
        ? loadError.message
        : "Could not load timeline."
      : null;
  const initialRetryPending =
    !timeline && (meQuery.isFetching || timelineQuery.isFetching);
  const retryInitialLoad = async (): Promise<void> => {
    const source = meQuery.isError ? "identity" : "timeline";
    const release = initialRetryGate.begin(
      JSON.stringify(["timeline-initial", id, source]),
    );
    if (!release) return;
    try {
      if (meQuery.isError) await meQuery.refetch();
      else await timelineQuery.refetch();
    } catch {
      // Query state owns the visible error and retry transition.
    } finally {
      release();
    }
  };

  if (loading) {
    return <SubscriberDetailSkeleton />;
  }
  if (error) {
    return (
      <div className="space-y-3 p-8">
        <p
          role="alert"
          className="break-words text-sm text-destructive-emphasis"
        >
          Could not load subscriber: {error}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-8"
          aria-busy={initialRetryPending}
          disabled={initialRetryPending}
          onClick={() => void retryInitialLoad()}
        >
          {initialRetryPending ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }
  if (unavailable) {
    return (
      <div className="space-y-3 p-8">
        <div className="text-sm text-muted-foreground">
          Activity timeline unavailable. The drill-down endpoint
          (/api/v1/subscribers/{id}/timeline) is not reachable on this
          deployment — falling back to the subscribers list.
        </div>
        <Link
          href="/app/subscribers"
          className="text-sm underline underline-offset-4"
        >
          Back to subscribers
        </Link>
      </div>
    );
  }
  if (!timeline) {
    return (
      <div className="p-8 text-sm text-muted-foreground">
        No data for this subscriber.
      </div>
    );
  }

  const stats = timeline.stats;
  const hue = avatarHue(timeline.email);
  const initials = initialsOf(timeline.email);
  // Reflect a successful in-page suppress without a refetch. The
  // already-suppressed case is handled structurally below (SUB-034 renders
  // Re-enable instead of Suppress), so `actionPending` is the only guard the
  // buttons need.
  const displayStatus =
    suppressed === true
      ? "suppressed"
      : suppressed === false
        ? "enabled"
        : stats.current_status;

  return (
    <PageShell className="max-w-5xl">
      <div className="flex items-center justify-between gap-2">
        <Breadcrumb
          items={[
            { label: "Subscribers", href: "/app/subscribers" },
            { label: timeline.email },
          ]}
        />
        {/* Prev/next navigation seeded from the list order the operator came
            through (SUB-008). Hidden when there's no list context. */}
        {neighbors.index >= 0 && neighbors.total > 1 ? (
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Previous subscriber"
              title="Previous subscriber"
              disabled={!neighbors.prev}
              onClick={() =>
                neighbors.prev &&
                router.push(
                  `/app/subscribers/${encodeURIComponent(neighbors.prev)}`,
                )
              }
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="tabular-nums">
              {neighbors.index + 1} / {neighbors.total}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Next subscriber"
              title="Next subscriber"
              disabled={!neighbors.next}
              onClick={() =>
                neighbors.next &&
                router.push(
                  `/app/subscribers/${encodeURIComponent(neighbors.next)}`,
                )
              }
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-6">
        <div
          data-testid="subscriber-avatar"
          className="pw-avatar flex h-16 w-16 items-center justify-center rounded-full text-xl font-semibold"
          style={{ "--pw-avatar-hue": String(hue) } as React.CSSProperties}
          aria-hidden="true"
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="font-display truncate text-xl font-semibold tracking-tight">
            {timeline.email}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge
              data-testid="subscriber-status"
              variant={statusVariant(displayStatus)}
            >
              {displayStatus}
            </Badge>
            <span>
              · {profileSinceLabel(stats.current_status)}{" "}
              {fmtDate(stats.subscribed_at)}
            </span>
            {stats.last_active_at ? (
              <span>· Last active {relTime(stats.last_active_at)}</span>
            ) : null}
          </div>
        </div>
        <div className="flex w-full min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center md:w-auto md:justify-end">
          {/* Header actions — wired to the real endpoints so the drill-down
              isn't a read-only dead-end. */}
          <div className="flex flex-wrap items-center gap-2 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-8">
            {record && authority ? (
              <Button
                ref={editTriggerRef}
                type="button"
                variant="outline"
                size="sm"
                aria-haspopup="dialog"
                aria-expanded={editOpen}
                onClick={() => setEditOpen(true)}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            ) : null}
            {/* Cross-entity action (SUB-008): grant this contact paid access. */}
            {canAdmin ? (
              <ConfirmDialog
                trigger={
                  <Button variant="outline" size="sm" disabled={actionPending}>
                    Grant paid access
                  </Button>
                }
                title="Grant paid access?"
                description={`${timeline.email} will be added to the paid-members registry with active access.`}
                confirmLabel="Grant access"
                confirmVariant="default"
                onConfirm={async () => {
                  await runHeaderMutation(
                    async () => {
                      // Only the grant verb needs the paywall client; load it
                      // when the action runs instead of with the page.
                      const { grantPaidMember } =
                        await import("@/lib/paywall-api");
                      await grantPaidMember({
                        subscriber_email: timeline.email,
                      });
                    },
                    () => {
                      toast.success("Granted paid access.");
                    },
                    "Could not grant paid access.",
                  );
                }}
              />
            ) : null}
            {isSuppressedStatus(displayStatus) ? (
              // An editor gets no control on an already-suppressed contact:
              // removal is admin-only, and offering Suppress instead would
              // repeat an action that already happened.
              canAdmin ? (
                <ConfirmDialog
                  trigger={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionPending}
                    >
                      <RotateCcw aria-hidden="true" />
                      Remove suppression
                    </Button>
                  }
                  title="Remove the reviewed suppression?"
                  description="This removes only a reversible suppression entry. It does not restore subscriber status, consent, or sending eligibility; review those separately afterward."
                  confirmLabel="Remove suppression"
                  confirmVariant="default"
                  onConfirm={handleUnsuppress}
                />
              ) : null
            ) : authority ? (
              <ConfirmDialog
                trigger={
                  <Button variant="outline" size="sm" disabled={actionPending}>
                    <Ban aria-hidden="true" />
                    Suppress
                  </Button>
                }
                title="Suppress subscriber?"
                description="They'll be blocklisted and excluded from future sends. Removing a suppression later will not restore consent or sending eligibility automatically."
                confirmLabel="Suppress"
                onConfirm={handleSuppress}
              />
            ) : null}
            {authority ? (
              <ConfirmDialog
                trigger={
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Delete subscriber"
                    title="Delete subscriber"
                    disabled={actionPending}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                }
                title="Delete subscriber?"
                description="This subscriber and their activity will be permanently erased. This cannot be undone. To remove reversibly, use the archive action on the list instead."
                confirmationToken={timeline.email}
                confirmLabel="Delete permanently"
                onConfirm={handleDelete}
              />
            ) : null}
          </div>
          <CopyEntityLink entity="subscriber" id={id} />
          <RecordLastViewed entity="subscriber" id={id} />
          <div data-testid="subscriber-engagement-score">
            <Gauge score={stats.engagement_score ?? 0} />
          </div>
        </div>
      </div>

      {/* The record query is deliberately separate from the timeline, so its
          failure is silent: Edit disappears and Lists & Tags renders "No tags
          yet." Say it failed instead of implying the contact has none. */}
      {recordQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load this subscriber&apos;s record — tags, custom fields and
          editing are unavailable until it loads.
        </p>
      ) : null}

      <EmailHealthCard
        email={timeline.email}
        subscriberId={id}
        tenantId={tenantId}
        role={role}
      />

      {/* Stats grid — 2 cols on mobile, 5 on desktop */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Sent" value={stats.sent_count} />
        <StatCard
          label="Opened"
          value={stats.opened_count}
          sub={fmtPercent(stats.open_rate)}
        />
        <StatCard
          label="Clicked"
          value={stats.clicked_count}
          sub={fmtPercent(stats.click_rate)}
        />
        <StatCard label="Replied" value={stats.replied_count} />
        <StatCard label="Bounced" value={stats.bounced_count} />
      </div>

      {/* Per-contact predictive intelligence (churn / CLV / best-send-time /
          next-order). Renders nothing until the backend has scored the
          contact. (SUB-039) */}
      <PredictionCards id={id} tenantId={tenantId} role={role} />

      <SubscriberDetailPanels
        tab={tab}
        onTabChange={setTab}
        timeline={timeline}
        record={record}
        id={id}
        tenantId={tenantId}
        role={role}
        authority={authority}
        buckets={buckets}
        hasMore={hasMoreTimeline}
        onLoadMore={() => void loadMore()}
        loadingMore={loadingMoreTimeline}
        loadMoreError={loadMoreError}
        category={timelineCategory}
        onCategoryChange={setTimelineCategory}
        onRecordRefetch={() => void recordQuery.refetch()}
      />

      {editOpen && record && authority ? (
        <EditSubscriberDialog
          open={editOpen}
          onOpenChange={(next) => {
            setEditOpen(next);
            if (!next) {
              window.requestAnimationFrame(() =>
                editTriggerRef.current?.focus(),
              );
            }
          }}
          subscriber={record}
          authority={authority}
          onReload={async () => {
            const result = await recordQuery.refetch();
            if (result.error) throw result.error;
          }}
          onSaved={(updated) => {
            queryClient.setQueryData(recordKey, updated);
            void queryClient.invalidateQueries({
              queryKey: subscriberDetailKey,
              exact: false,
            });
            void queryClient.invalidateQueries({
              queryKey: subscribersBaseKey,
              exact: false,
            });
          }}
        />
      ) : null}
    </PageShell>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: number;
  sub?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
