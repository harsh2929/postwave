// SPDX-License-Identifier: AGPL-3.0-only
//
// Read-only segment overview (SEG-012): definition, live count, usage, size
// trend (SEG-039), engagement summary (SEG-053), definition history (SEG-041),
// and two-segment overlap (SEG-042). Each section degrades gracefully so one
// unavailable endpoint (or an insufficient role) never blanks the page.
"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, Download, Megaphone, Pencil } from "lucide-react";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { DeferredConfirmDialog } from "@/components/ui/deferred-confirm-dialog";
import { Select } from "@/components/ui/select";
import { Sparkline } from "@/components/dashboard/sparkline";
import { LiveCount } from "@/components/segments/live-count";
import {
  SegmentDefinitionView,
  type DefinitionContext,
} from "@/components/segments/segment-definition-view";
import { useSegmentCatalogue } from "@/components/segments/use-segment-catalogue";
import { PageHeaderSkeleton } from "@/components/dashboard/skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { ApiError, fetchTextAuthed } from "@/lib/api";
import { base, qk, STALE } from "@/lib/query-keys";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  reauthorizeSubscriberMutation,
  subscriberAuthorityFromMe,
  type SubscriberAuthority,
} from "@/lib/subscriber-authority";
import { downloadTextFile } from "@/lib/download";
import {
  createSegment,
  deleteSegmentHoldout,
  dismissDecayEvent,
  getDecayEventMembers,
  getDefinitionHistory,
  getEngagementSummary,
  getSegment,
  getSegmentOverlap,
  getSegmentPnL,
  getSegmentUsage,
  getSizeHistory,
  listDecayEvents,
  listSegments,
  narrateDecayEvent,
  segmentGrowthReportCsvPath,
  setSegmentHoldout,
  updateSegment,
  type DecayEvent,
  type DefinitionHistoryEntry,
  type OverlapResponse,
} from "@/lib/segments-api";
import { formatCents } from "@/lib/analytics-format";
import { duplicateSegmentInput } from "@/components/segments/segment-logic";

import { MembersSection } from "./members-section";

export default function SegmentDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params?.id ?? "";

  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  // Effective role (View-as-Viewer preview) — the server gates on
  // EffectiveRoleOrDurable(), so the segment write controls must too.
  const role = me.data ? effectiveAuthRole(me.data) : null;
  const authority = me.data ? subscriberAuthorityFromMe(me.data) : null;
  const principalKey = me.data
    ? `${me.data.tenant_id}:${me.data.user_id}:${role}:${me.data.viewer_mode ? "viewer" : "member"}`
    : "unresolved";
  const identityResolved = me.isSuccess && Boolean(me.data);
  const scoped = (name: string) => [
    ...base(name, tenantId, role),
    principalKey,
    id,
  ];
  const topActionRef = React.useRef<"campaign" | "duplicate" | null>(null);
  const [topAction, setTopAction] = React.useState<
    "campaign" | "duplicate" | null
  >(null);
  const previousPrincipalRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const previous = previousPrincipalRef.current;
    if (previous && previous !== principalKey) {
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
    }
    previousPrincipalRef.current =
      principalKey === "unresolved" ? null : principalKey;
  }, [principalKey, queryClient]);

  const segmentQuery = useQuery({
    queryKey: scoped("segment"),
    enabled: Boolean(id) && identityResolved,
    queryFn: () => getSegment(id),
    staleTime: STALE.detail,
  });
  const usageQuery = useQuery({
    queryKey: scoped("segment-usage"),
    enabled: Boolean(id) && identityResolved,
    queryFn: () => getSegmentUsage(id),
    staleTime: STALE.detail,
  });
  const sizeQuery = useQuery({
    queryKey: scoped("segment-size"),
    enabled: Boolean(id) && identityResolved,
    queryFn: () => getSizeHistory(id, 90),
    staleTime: STALE.detail,
    retry: false,
  });
  const engagementQuery = useQuery({
    queryKey: scoped("segment-engagement"),
    enabled: Boolean(id) && identityResolved,
    queryFn: () => getEngagementSummary(id),
    staleTime: STALE.detail,
    retry: false,
  });
  const historyQuery = useQuery({
    queryKey: scoped("segment-defhistory"),
    enabled: Boolean(id) && identityResolved,
    queryFn: () => getDefinitionHistory(id),
    staleTime: STALE.detail,
    retry: false,
  });

  const segment = segmentQuery.data;

  // Name fields and referenced segments in the definition the way the builder
  // does, not by their keys and ids.
  const catalogueQuery = useSegmentCatalogue(tenantId, role, identityResolved);
  // The segments list's own cache entry (and its invalidation), not a copy per
  // overview.
  const allSegmentsQuery = useQuery({
    queryKey: qk.segments(tenantId, role, null),
    enabled: Boolean(id) && identityResolved,
    queryFn: listSegments,
    staleTime: STALE.list,
  });
  const definitionContext = React.useMemo(
    () => ({
      fields: catalogueQuery.data?.fields,
      segmentNames: Array.isArray(allSegmentsQuery.data)
        ? new Map(allSegmentsQuery.data.map((s) => [s.id, s.name]))
        : undefined,
    }),
    [catalogueQuery.data, allSegmentsQuery.data],
  );

  async function onExport() {
    if (!segment) return;
    try {
      const csv = await fetchTextAuthed(segmentGrowthReportCsvPath(segment.id));
      downloadTextFile(
        `segment-${segment.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-growth.csv`,
        csv,
        "text/csv;charset=utf-8",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed.");
    }
  }
  async function onUseInCampaign() {
    if (!segment || !authority || topActionRef.current) return;
    const intent = {
      name: `Campaign for ${segment.name}`,
      subject: `Message to ${segment.name}`,
      segment_id: segment.id,
    } as const;
    topActionRef.current = "campaign";
    setTopAction("campaign");
    try {
      await reauthorizeSubscriberMutation(authority);
      // The campaigns client is only needed for this verb; loading it here
      // keeps the segment route's eager chunk inside the bundle budget.
      const { createCampaign } = await import("@/lib/campaigns-api");
      const c = await createCampaign(intent);
      toast.success("Draft campaign created.");
      router.push(`/app/campaigns/${c.id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create campaign.",
      );
    } finally {
      topActionRef.current = null;
      setTopAction(null);
    }
  }
  async function onDuplicate() {
    if (!segment || !authority || topActionRef.current) return;
    const intent = duplicateSegmentInput(segment, {
      description: segment.description,
      queryAst: structuredClone(segment.queryAst),
    });
    topActionRef.current = "duplicate";
    setTopAction("duplicate");
    try {
      // Through the shared builder: this hand-rolled the input and dropped
      // `includeArchived`, so duplicating an archive-scoped segment produced a
      // copy with a DIFFERENT audience — the same defect the editor's Duplicate
      // had. It also re-implemented the copy-name suffix without the collision
      // check, so two duplicates could land on the same name.
      await reauthorizeSubscriberMutation(authority);
      const copy = await createSegment(intent);
      toast.success("Segment duplicated.");
      router.push(`/app/subscribers/segments/${copy.id}/edit`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not duplicate.");
    } finally {
      topActionRef.current = null;
      setTopAction(null);
    }
  }

  if (me.isError) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Segment unavailable
        </h1>
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-emphasis"
        >
          Your workspace identity could not be verified. No segment data was
          requested.
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => void me.refetch()}
        >
          Retry identity
        </Button>
      </div>
    );
  }

  if (segmentQuery.isError) {
    const notFound =
      segmentQuery.error instanceof ApiError &&
      segmentQuery.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Segment unavailable
        </h1>
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive-emphasis"
        >
          {notFound
            ? "This segment no longer exists."
            : "Couldn't load this segment."}
        </div>
        <Button asChild variant="outline">
          <Link href="/app/subscribers/segments">Back to segments</Link>
        </Button>
      </div>
    );
  }

  if (!segment) {
    return (
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="sr-only">Loading segment</h1>
        <Skeleton className="h-4 w-64" />
        <PageHeaderSkeleton />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
    );
  }

  const series = Array.isArray(sizeQuery.data?.series)
    ? sizeQuery.data?.series
    : [];
  const netDelta =
    series.length >= 2
      ? series[series.length - 1]!.count - series[0]!.count
      : null;
  const dependents = Array.isArray(usageQuery.data?.items)
    ? usageQuery.data?.items
    : [];
  const engagement = engagementQuery.data;
  const history = Array.isArray(historyQuery.data?.items)
    ? historyQuery.data?.items
    : [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <Breadcrumb
        items={[
          { label: "Subscribers", href: "/app/subscribers" },
          { label: "Segments", href: "/app/subscribers/segments" },
          { label: segment.name },
        ]}
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {segment.name}
          </h1>
          {segment.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {segment.description}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">
            {segment.lastEvaluatedAt ? (
              <>
                {typeof segment.lastCount === "number"
                  ? `${segment.lastCount.toLocaleString()} ${segment.lastCount === 1 ? "member" : "members"} when last counted `
                  : "Last counted "}
                <span title={absoluteTime(segment.lastEvaluatedAt)}>
                  {timeAgo(segment.lastEvaluatedAt)}
                </span>
              </>
            ) : (
              "Not counted yet. The live count shows who matches now."
            )}
          </p>
        </div>
        <LiveCount
          ast={segment.queryAst}
          includeArchived={segment.includeArchived ?? false}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {authority ? (
          <>
            <Button asChild>
              <Link href={`/app/subscribers/segments/${segment.id}/edit`}>
                <Pencil className="h-4 w-4" /> Edit
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={topAction !== null}
              onClick={() => void onUseInCampaign()}
            >
              <Megaphone className="h-4 w-4" />
              {topAction === "campaign" ? "Creating…" : "Use in a campaign"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={topAction !== null}
              onClick={() => void onDuplicate()}
            >
              <Copy className="h-4 w-4" />
              {topAction === "duplicate" ? "Duplicating…" : "Duplicate"}
            </Button>
          </>
        ) : null}
        <Button type="button" variant="outline" onClick={() => void onExport()}>
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Definition */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">Definition</h2>
          <SegmentDefinitionView
            ast={segment.queryAst}
            context={definitionContext}
          />
          {allSegmentsQuery.isError ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              Segment names couldn&apos;t be loaded, so any segment this one
              refers to is shown by its ID.{" "}
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 text-xs"
                onClick={() => void allSegmentsQuery.refetch()}
              >
                Try again
              </Button>
            </p>
          ) : null}
        </section>

        {/* Size trend (SEG-039) */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium">Size trend</h2>
          {sizeQuery.isLoading ? (
            <Skeleton className="mt-3 h-16 w-full" />
          ) : sizeQuery.isError ? (
            // Distinct from "not enough history yet" — that would read as a
            // young segment rather than a failed request.
            <p role="alert" className="mt-3 text-sm text-destructive">
              Could not load the size trend.
            </p>
          ) : series.length >= 2 ? (
            <div className="mt-3">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {series[series.length - 1]!.count.toLocaleString()}
                  </div>
                  {netDelta !== null ? (
                    <div
                      className={`text-xs ${netDelta > 0 ? "text-success" : netDelta < 0 ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {netDelta > 0 ? "+" : ""}
                      {netDelta.toLocaleString()} over {series.length} points
                    </div>
                  ) : null}
                </div>
                <Sparkline
                  data={series.map((p) => p.count)}
                  width={140}
                  height={40}
                />
              </div>
            </div>
          ) : series.length === 1 ? (
            // One point: today's size, with the server's explanation of why
            // there is no line yet (written for the reader, shown verbatim).
            <div className="mt-3">
              <div className="text-2xl font-semibold tabular-nums">
                {series[0]!.count.toLocaleString()}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {sizeQuery.data?.note ??
                  "A size is recorded once a day; the trend appears after the second day."}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              {sizeQuery.data?.note ??
                "A size is recorded once a day; the trend appears after the second day."}
            </p>
          )}
        </section>

        {/* Engagement summary (SEG-053, partial) */}
        {engagement ? (
          <section className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">
              Engagement · last {engagement.window_days} days
            </h2>
            <div className="grid grid-cols-3 gap-3 text-center">
              <Metric label="Open rate" value={pct(engagement.open_rate)} />
              <Metric label="Click rate" value={pct(engagement.click_rate)} />
              <Metric label="Unsub rate" value={pct(engagement.unsub_rate)} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              {engagement.member_count.toLocaleString()} members · basis:{" "}
              {engagement.rate_basis}
            </p>
          </section>
        ) : engagementQuery.isLoading ? (
          <section className="rounded-lg border bg-card p-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="mt-3 h-12 w-full" />
          </section>
        ) : engagementQuery.isError ? (
          // Without this the whole section silently vanishes on a 500.
          <section className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-medium">Engagement</h2>
            <p role="alert" className="text-sm text-destructive">
              Could not load the engagement summary.
            </p>
          </section>
        ) : null}

        {/* Usage (SEG-010) */}
        <section className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-medium">Used by</h2>
          {usageQuery.isError ? (
            // "Nothing references this segment yet" would be a dangerous lie
            // here — an operator may delete a segment on the strength of it.
            <p role="alert" className="text-sm text-destructive">
              Could not load what references this segment.
            </p>
          ) : dependents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing references this segment yet.
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {dependents.slice(0, 10).map((d) => (
                <li
                  key={`${d.kind}-${d.id}`}
                  className="flex items-center gap-2"
                >
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {d.kind.replace("_", " ")}
                  </span>
                  <span>{d.name}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Live members, with snapshots underneath (SEG-015, SEG-053) */}
      <MembersSection
        // Keyed by segment too: moving between overviews starts on page one.
        key={`members:${principalKey}:${segment.id}`}
        segmentId={segment.id}
        includeArchived={segment.includeArchived ?? false}
        tenantId={tenantId}
        role={role}
        principalKey={principalKey}
        authority={authority}
        enabled={identityResolved}
      />

      {/* Profit & loss + holdout lift (SEG-053) */}
      <ProfitabilitySection
        key={`profitability:${principalKey}`}
        segmentId={segment.id}
        tenantId={tenantId}
        role={role}
        principalKey={principalKey}
        authority={authority}
        enabled={identityResolved}
      />

      {/* Decay radar — who left & why, with AI narration (SEG-051) */}
      <DecaySection
        key={`decay:${principalKey}`}
        segmentId={segment.id}
        tenantId={tenantId}
        role={role}
        principalKey={principalKey}
        authority={authority}
        enabled={identityResolved}
      />

      {/* Overlap comparison (SEG-042) */}
      <OverlapSection
        key={`overlap:${principalKey}`}
        segmentId={segment.id}
        tenantId={tenantId}
        role={role}
        principalKey={principalKey}
        enabled={identityResolved}
      />

      {/* Definition history + compare/restore (SEG-041). A failed fetch would
          otherwise render as "no edits ever made" — the section hides itself
          when the entry list is empty. */}
      {historyQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load the definition history.
        </p>
      ) : null}
      <DefinitionHistorySection
        key={`history:${principalKey}`}
        segmentId={segment.id}
        entries={history}
        role={role}
        tenantId={tenantId}
        principalKey={principalKey}
        authority={authority}
        definitionContext={definitionContext}
      />
    </div>
  );
}

function DecaySection({
  segmentId,
  tenantId,
  role,
  principalKey,
  authority,
  enabled,
}: {
  segmentId: string;
  tenantId: string;
  role: string | null;
  principalKey: string;
  authority: SubscriberAuthority | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const canWrite = Boolean(authority);
  const decayKey = [
    ...base("segment-decay", tenantId, role),
    principalKey,
    segmentId,
  ];
  const decayQuery = useQuery({
    queryKey: decayKey,
    enabled: Boolean(segmentId) && enabled,
    queryFn: () => listDecayEvents(segmentId, { undismissed: true, limit: 20 }),
    staleTime: STALE.detail,
    retry: false,
  });
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [direction, setDirection] = React.useState<"left" | "entered">("left");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const mutationRef = React.useRef(false);

  const membersQuery = useQuery({
    queryKey: [...decayKey, "members", expanded, direction],
    enabled: Boolean(expanded),
    queryFn: () =>
      getDecayEventMembers(segmentId, expanded as string, {
        direction,
        perPage: 50,
      }),
    staleTime: STALE.detail,
    retry: false,
  });

  const events = Array.isArray(decayQuery.data) ? decayQuery.data : [];

  async function onDismiss(eventId: string) {
    if (!authority || mutationRef.current) return;
    const intent = { segmentId, eventId } as const;
    mutationRef.current = true;
    setBusyId(eventId);
    try {
      await reauthorizeSubscriberMutation(authority);
      await dismissDecayEvent(intent.segmentId, intent.eventId);
      toast.success("Decay event dismissed.");
      if (expanded === eventId) setExpanded(null);
      await queryClient.invalidateQueries({ queryKey: decayKey });
    } catch {
      toast.error("Could not dismiss the event.");
    } finally {
      mutationRef.current = false;
      setBusyId(null);
    }
  }

  async function onNarrate(eventId: string) {
    if (!authority || mutationRef.current) return;
    const intent = { segmentId, eventId } as const;
    mutationRef.current = true;
    setBusyId(eventId);
    try {
      await reauthorizeSubscriberMutation(authority);
      const updated = await narrateDecayEvent(intent.segmentId, intent.eventId);
      // Optimistically patch the narration into the cached list.
      queryClient.setQueryData<DecayEvent[]>(decayKey, (cur) =>
        (cur ?? []).map((e) => (e.id === eventId ? updated : e)),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 503
          ? "AI narration is temporarily unavailable."
          : "Could not generate a narration.",
      );
    } finally {
      mutationRef.current = false;
      setBusyId(null);
    }
  }

  if (decayQuery.error instanceof ApiError && decayQuery.error.status === 503) {
    return null; // decay radar not configured for this deployment
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Decay radar</h2>
        <span className="text-xs text-muted-foreground">
          Membership swings the anomaly worker flagged
        </span>
      </div>

      {decayQuery.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : decayQuery.isError ? (
        // The 503 "not configured" case already returned null above, so this
        // is a real failure — never report it as "no anomalies flagged".
        <p role="alert" className="text-sm text-destructive">
          Could not load decay events.
        </p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No anomalies flagged. Sudden gains or losses in this segment&apos;s
          membership will appear here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((ev) => {
            const isOpen = expanded === ev.id;
            const busy = busyId === ev.id;
            return (
              <li key={ev.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                    {ev.anomaly_kind.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {ev.snapshot_date}
                  </span>
                  <span className="text-sm tabular-nums">
                    {ev.prior_count.toLocaleString()} →{" "}
                    {ev.new_count.toLocaleString()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({ev.leaver_count.toLocaleString()} left,{" "}
                    {ev.entrant_count.toLocaleString()} entered)
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setExpanded(isOpen ? null : ev.id)}
                    >
                      {isOpen ? "Hide members" : "View members"}
                    </Button>
                    {canWrite ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void onNarrate(ev.id)}
                        >
                          {ev.narration ? "Re-narrate" : "AI narrate"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void onDismiss(ev.id)}
                        >
                          Dismiss
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {ev.narration ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {ev.narration}
                    {ev.narration_model ? (
                      <span className="ml-1 text-xs">
                        (via {ev.narration_model})
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {isOpen ? (
                  <div className="mt-3 border-t pt-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Select
                        aria-label="Member direction"
                        className="h-8 w-28"
                        value={direction}
                        onChange={(e) =>
                          setDirection(e.target.value as "left" | "entered")
                        }
                      >
                        <option value="left">Left</option>
                        <option value="entered">Entered</option>
                      </Select>
                      {membersQuery.data?.bounded_by_log_cap ? (
                        <span className="text-xs text-muted-foreground">
                          Showing a bounded sample (log cap reached).
                        </span>
                      ) : null}
                    </div>
                    {membersQuery.isPending ? (
                      <Skeleton className="h-10 w-full" />
                    ) : membersQuery.isError ? (
                      <p role="alert" className="text-xs text-destructive">
                        Could not load the{" "}
                        {direction === "left" ? "leavers" : "entrants"} for this
                        event.
                      </p>
                    ) : (membersQuery.data?.items?.length ?? 0) === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No {direction === "left" ? "leavers" : "entrants"}{" "}
                        recorded.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1 text-sm">
                        {membersQuery.data?.items?.map((m) => (
                          <li key={m.subscriber_id}>
                            <Link
                              href={`/app/subscribers?q=${encodeURIComponent(m.email)}`}
                              className="hover:underline underline-offset-4"
                            >
                              {m.email}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Both holdout routes are registered on the admin-scoped router
// (RequireScope(ScopeAdmin) in internal/segments/handlers.go), and for a
// session cookie that scope resolves to owner/admin only. Gating the controls
// on canWrite (editor and up) would hand an editor buttons that can only ever
// 403 — surfaced as "Could not configure holdout", which reads as a bad
// percentage rather than a missing role.
const HOLDOUT_ADMIN_ONLY =
  "Configuring a holdout requires an owner or admin role";

function canConfigureHoldout(authority: SubscriberAuthority | null): boolean {
  return authority?.role === "owner" || authority?.role === "admin";
}

function ProfitabilitySection({
  segmentId,
  tenantId,
  role,
  principalKey,
  authority,
  enabled,
}: {
  segmentId: string;
  tenantId: string;
  role: string | null;
  principalKey: string;
  authority: SubscriberAuthority | null;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();
  const canWrite = Boolean(authority);
  const holdoutAdmin = canConfigureHoldout(authority);
  const pnlKey = [
    ...base("segment-pnl", tenantId, role),
    principalKey,
    segmentId,
  ];
  const pnlQuery = useQuery({
    queryKey: pnlKey,
    enabled: Boolean(segmentId) && enabled,
    queryFn: () => getSegmentPnL(segmentId, { includeLift: true }),
    staleTime: STALE.detail,
    retry: false,
  });
  const [holdoutBusy, setHoldoutBusy] = React.useState(false);
  const holdoutBusyRef = React.useRef(false);
  const [holdoutPct, setHoldoutPct] = React.useState("10");
  const pnl = pnlQuery.data;

  const refresh = () => queryClient.invalidateQueries({ queryKey: pnlKey });

  async function enableHoldout() {
    if (!authority || holdoutBusyRef.current) return;
    if (!canConfigureHoldout(authority)) return;
    const percent = Number(holdoutPct);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 50) {
      toast.error("Holdout percent must be between 1 and 50.");
      return;
    }
    const intent = { segmentId, percent } as const;
    holdoutBusyRef.current = true;
    setHoldoutBusy(true);
    try {
      await reauthorizeSubscriberMutation(authority);
      await setSegmentHoldout(intent.segmentId, { percent: intent.percent });
      toast.success(
        `Holdout enabled at ${percent}%. Lift populates as sends and conversions accrue.`,
      );
      await refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not configure holdout.",
      );
    } finally {
      holdoutBusyRef.current = false;
      setHoldoutBusy(false);
    }
  }

  async function removeHoldout() {
    if (!authority || holdoutBusyRef.current) return;
    if (!canConfigureHoldout(authority)) return;
    const intentSegmentId = segmentId;
    holdoutBusyRef.current = true;
    setHoldoutBusy(true);
    try {
      await reauthorizeSubscriberMutation(authority);
      await deleteSegmentHoldout(intentSegmentId);
      toast.success("Holdout removed.");
      await refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not remove holdout.",
      );
    } finally {
      holdoutBusyRef.current = false;
      setHoldoutBusy(false);
    }
  }

  // P&L is best-effort — a failure never blocks the rest of the page.
  if (pnlQuery.isError) return null;
  if (!pnl && pnlQuery.isLoading) {
    return (
      <section className="rounded-lg border bg-card p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-3 h-24 w-full" />
      </section>
    );
  }
  if (!pnl) return null;

  const currency = pnl.currency || pnl.cost_currency || "USD";
  const lift = pnl.lift ?? null;
  const tooLarge =
    pnl.lift_skipped_reason === "segment_too_large_for_in_process_lift";
  const tiles: { label: string; value: string }[] = [
    { label: "Revenue", value: formatCents(pnl.revenue_cents, currency) },
    {
      label: "Revenue / member",
      value:
        pnl.revenue_per_member_cents != null
          ? formatCents(pnl.revenue_per_member_cents, currency)
          : "—",
    },
    {
      label: "Net contribution",
      value:
        pnl.net_contribution_cents != null
          ? formatCents(pnl.net_contribution_cents, currency)
          : "—",
    },
    {
      label: "Cost",
      value: pnl.cost_config_present
        ? formatCents(pnl.total_cost_cents, pnl.cost_currency || currency)
        : "Not set",
    },
    {
      label: "Avg order value",
      value:
        pnl.aov_cents != null
          ? formatCents(pnl.aov_cents, pnl.aov_currency || currency)
          : "—",
    },
    {
      label: "CLV realised vs predicted",
      value:
        pnl.clv_realised_vs_predicted != null
          ? pct(pnl.clv_realised_vs_predicted)
          : "—",
    },
  ];

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          Profitability · last {pnl.window_days} days
        </h2>
        <Button
          variant="ghost"
          size="sm"
          disabled={pnlQuery.isFetching}
          onClick={() => void refresh()}
        >
          {pnlQuery.isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-3">
        {tiles.map((t) => (
          <Metric key={t.label} label={t.label} value={t.value} />
        ))}
      </div>

      {/* Holdout-based incremental lift */}
      <div className="mt-4 rounded-md border bg-muted/30 p-3">
        {lift ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">
                Incremental lift · {lift.holdout_percent.toFixed(0)}% holdout
              </span>
              <span className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {lift.lift_percent >= 0 ? "+" : ""}
                {lift.lift_percent.toFixed(1)}%
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
              <Metric
                label="Treated conv."
                value={pct(lift.treated_conv_rate)}
              />
              <Metric
                label="Holdout conv."
                value={pct(lift.control_conv_rate)}
              />
              <Metric label="Incremental" value={pct(lift.incremental_lift)} />
              <Metric
                label="Holdout size"
                value={lift.control_size.toLocaleString()}
              />
            </div>
            {lift.confidence_low ? (
              <p className="mt-2 text-[11px] text-warning-emphasis">
                Low confidence — a cohort is still small; treat the lift as
                directional until more data accrues.
              </p>
            ) : null}
            {holdoutAdmin ? (
              // Removing the holdout throws away the control cohort, so the
              // lift measured against it can never be resumed — name that
              // before it happens. The dialog loads when first opened, which
              // keeps Radix Dialog out of this route's initial JavaScript
              // (bundle budget).
              <DeferredConfirmDialog
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-3"
                    disabled={holdoutBusy}
                  >
                    Remove holdout
                  </Button>
                }
                title="Remove this holdout?"
                description={`The ${lift.control_size.toLocaleString()}-member control cohort is discarded together with the incremental lift measured against it (${lift.lift_percent >= 0 ? "+" : ""}${lift.lift_percent.toFixed(1)}% so far). Every member goes back into sends, and re-enabling a holdout starts a new cohort measuring from zero.`}
                confirmLabel="Remove holdout"
                confirmVariant="destructive"
                onConfirm={removeHoldout}
              />
            ) : canWrite ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3"
                disabled
                title={HOLDOUT_ADMIN_ONLY}
              >
                Remove holdout
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <div className="text-sm font-medium">Incremental lift</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {tooLarge
                ? "This segment is too large for in-process lift measurement."
                : "Hold back a small share of members from sends to measure the true incremental conversion this segment drives versus a control."}
            </p>
            {canWrite && !tooLarge ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={holdoutPct}
                  onChange={(e) => setHoldoutPct(e.target.value)}
                  aria-label="Holdout percent"
                  disabled={!holdoutAdmin}
                  title={holdoutAdmin ? undefined : HOLDOUT_ADMIN_ONLY}
                  className="h-9 w-20 rounded-md border bg-background px-2 text-sm tabular-nums disabled:opacity-50"
                />
                <span className="text-sm text-muted-foreground">% holdout</span>
                <Button
                  size="sm"
                  disabled={holdoutBusy || !holdoutAdmin}
                  title={holdoutAdmin ? undefined : HOLDOUT_ADMIN_ONLY}
                  onClick={() => void enableHoldout()}
                >
                  {holdoutBusy ? "Enabling…" : "Enable holdout"}
                </Button>
                {!holdoutAdmin ? (
                  <span className="text-xs text-muted-foreground">
                    {HOLDOUT_ADMIN_ONLY}.
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Honest measurement gaps. */}
      {pnl.cross_currency_revenue_excluded ||
      pnl.sequence_attribution_unsupported ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {pnl.cross_currency_revenue_excluded
            ? "Revenue in currencies other than the dominant one is excluded from totals. "
            : ""}
          {pnl.sequence_attribution_unsupported
            ? "Sequence-attributed revenue isn't counted yet."
            : ""}
        </p>
      ) : null}
    </section>
  );
}

function DefinitionHistorySection({
  segmentId,
  entries,
  role,
  tenantId,
  principalKey,
  authority,
  definitionContext,
}: {
  segmentId: string;
  entries: DefinitionHistoryEntry[];
  role: string | null;
  tenantId: string;
  principalKey: string;
  authority: SubscriberAuthority | null;
  definitionContext: DefinitionContext;
}) {
  const queryClient = useQueryClient();
  const canWrite = Boolean(authority);
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set());
  const [restoringId, setRestoringId] = React.useState<number | null>(null);
  const restoringRef = React.useRef(false);

  if (entries.length === 0) return null;

  const toggle = (id: number) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function restore(entry: DefinitionHistoryEntry) {
    if (!authority || restoringRef.current) return;
    const ast = entry.after?.queryAst;
    if (!ast) {
      toast.error("This version has no stored definition to restore.");
      return;
    }
    const intent = {
      segmentId,
      auditId: entry.audit_id,
      queryAst: structuredClone(ast),
    } as const;
    restoringRef.current = true;
    setRestoringId(entry.audit_id);
    try {
      await reauthorizeSubscriberMutation(authority);
      await updateSegment(intent.segmentId, { queryAst: intent.queryAst });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            ...base("segment", tenantId, role),
            principalKey,
            intent.segmentId,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            ...base("segment-defhistory", tenantId, role),
            principalKey,
            intent.segmentId,
          ],
        }),
      ]);
      toast.success("Segment definition restored.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not restore this version.",
      );
    } finally {
      restoringRef.current = false;
      setRestoringId(null);
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">Definition history</h2>
      <ul className="space-y-2 text-sm">
        {entries.slice(0, 10).map((h) => {
          const isOpen = expanded.has(h.audit_id);
          const canView = Boolean(h.before?.queryAst || h.after?.queryAst);
          return (
            <li
              key={h.audit_id}
              className="rounded-md border bg-background/40 p-2"
            >
              <div className="flex items-center justify-between gap-3">
                <span>
                  <span className="font-medium">
                    {h.actor_label || "Someone"}
                  </span>{" "}
                  <span className="text-muted-foreground">{h.action}</span>
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs text-muted-foreground"
                    title={absoluteTime(h.at)}
                  >
                    {timeAgo(h.at)}
                  </span>
                  {canView ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggle(h.audit_id)}
                    >
                      {isOpen ? "Hide" : "View"}
                    </Button>
                  ) : null}
                </div>
              </div>
              {isOpen ? (
                <div className="mt-2 space-y-3 border-t pt-2">
                  {h.before?.queryAst ? (
                    <div>
                      <div className="mb-1 text-[11px] uppercase text-muted-foreground">
                        Before
                      </div>
                      <SegmentDefinitionView
                        ast={h.before.queryAst}
                        context={definitionContext}
                      />
                    </div>
                  ) : null}
                  {h.after?.queryAst ? (
                    <div>
                      <div className="mb-1 text-[11px] uppercase text-muted-foreground">
                        After
                      </div>
                      <SegmentDefinitionView
                        ast={h.after.queryAst}
                        context={definitionContext}
                      />
                    </div>
                  ) : null}
                  {canWrite && h.after?.queryAst ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={restoringId === h.audit_id}
                      onClick={() => void restore(h)}
                    >
                      {restoringId === h.audit_id
                        ? "Restoring…"
                        : "Restore this version"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
    </div>
  );
}

function pct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function OverlapSection({
  segmentId,
  tenantId,
  role,
  principalKey,
  enabled,
}: {
  segmentId: string;
  tenantId: string;
  role: string | null;
  principalKey: string;
  enabled: boolean;
}) {
  const [otherId, setOtherId] = React.useState("");
  const [result, setResult] = React.useState<OverlapResponse | null>(null);
  const [busy, setBusy] = React.useState(false);

  const segmentsQuery = useQuery({
    queryKey: [
      ...base("segments", tenantId, role),
      principalKey,
      "overlap-picker",
    ],
    enabled,
    queryFn: listSegments,
    staleTime: STALE.list,
  });
  const others = (
    Array.isArray(segmentsQuery.data) ? segmentsQuery.data : []
  ).filter((s) => s.id !== segmentId);

  const run = async () => {
    if (!otherId) return;
    setBusy(true);
    setResult(null);
    try {
      setResult(await getSegmentOverlap(segmentId, otherId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Overlap failed.");
    } finally {
      setBusy(false);
    }
  };

  // A failed picker fetch collapses `others` to [], which would hide the whole
  // comparison tool as though this were the workspace's only segment.
  if (segmentsQuery.isError) {
    return (
      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-1 text-sm font-medium">
          Compare with another segment
        </h2>
        <p role="alert" className="text-sm text-destructive">
          Could not load the segments to compare against.
        </p>
      </section>
    );
  }
  if (others.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="mb-1 text-sm font-medium">Compare with another segment</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        See how many subscribers two segments share (overlap + Jaccard
        similarity).
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full min-w-0 flex-1 sm:min-w-[16rem]">
          <Select
            aria-label="Compare with segment"
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
          >
            <option value="">Select a segment…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          onClick={() => void run()}
          disabled={!otherId || busy}
          className="w-full sm:w-auto"
        >
          {busy ? "Comparing…" : "Compare"}
        </Button>
      </div>
      {result ? (
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            label="This segment"
            value={result.a_count.toLocaleString()}
          />
          <Metric label="Other" value={result.b_count.toLocaleString()} />
          <Metric label="Shared" value={result.intersection.toLocaleString()} />
          <Metric label="Jaccard" value={result.jaccard.toFixed(3)} />
        </div>
      ) : null}
    </section>
  );
}
