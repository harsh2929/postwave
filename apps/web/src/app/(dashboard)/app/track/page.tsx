// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, BarChart3, Search, Tags, TrendingUp } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { EventCatalog } from "@/components/track/EventCatalog";
import { useTrackInvestigationScope } from "@/components/track/use-track-scope";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { exactPrincipalKey } from "@/lib/exact-principal";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, qk, STALE } from "@/lib/query-keys";
import { getTrackCatalog, getTrackStats } from "@/lib/track-api";
function TrackPanelFallback({ label }: { label: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading {label}…
    </p>
  );
}

const TrackConversionsPanel = dynamic(
  () =>
    import("./track-conversions-panel").then(
      (module) => module.TrackConversionsPanel,
    ),
  {
    ssr: false,
    loading: () => <TrackPanelFallback label="conversion evidence" />,
  },
);
const TrackEventBrowser = dynamic(
  () =>
    import("./track-event-browser").then((module) => module.TrackEventBrowser),
  {
    ssr: false,
    loading: () => <TrackPanelFallback label="event investigation" />,
  },
);
const TrackEventComposer = dynamic(
  () =>
    import("./track-event-composer").then(
      (module) => module.TrackEventComposer,
    ),
  {
    ssr: false,
    loading: () => <TrackPanelFallback label="event action" />,
  },
);

export default function TrackPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const principalKey = exactPrincipalKey(
    meQuery.isSuccess ? meQuery.data : null,
  );
  const keyBase = useMemo(
    () => [
      ...base("track", meQuery.data?.tenant_id ?? "anon", role),
      principalKey,
    ],
    [meQuery.data?.tenant_id, principalKey, role],
  );
  const activeRequests = useIsFetching({ queryKey: keyBase });

  // One investigation scope for the catalogue and the event browser. It names
  // a subscriber of THIS principal's workspace, so it never survives a
  // workspace, user, role or viewer-mode transition.
  const scope = useTrackInvestigationScope();
  const [scopePrincipal, setScopePrincipal] = useState(principalKey);
  if (scopePrincipal !== principalKey) {
    setScopePrincipal(principalKey);
    scope.clearAll();
  }

  // Raw events contain subscriber identifiers and arbitrary properties. Drop
  // the exact principal's cached copies and abort their reads on a workspace,
  // user, effective-role, viewer-mode transition or on unmount.
  useEffect(() => {
    const scopedPrincipal = principalKey;
    return () => {
      if (scopedPrincipal === "unverified") return;
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(scopedPrincipal),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(scopedPrincipal),
      });
    };
  }, [principalKey, queryClient]);

  const stats = useQuery({
    queryKey: [...keyBase, "stats", { days: 30 }],
    queryFn: ({ signal }) => getTrackStats({ days: 30, signal }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.dashboard,
  });
  const catalog = useQuery({
    queryKey: [...keyBase, "catalog", { days: 30 }],
    queryFn: ({ signal }) => getTrackCatalog({ days: 30, signal }),
    enabled: meQuery.isSuccess,
    staleTime: STALE.reference,
  });
  const filteredItems = useMemo(() => {
    const items = Array.isArray(catalog.data?.items) ? catalog.data.items : [];
    const needle = search.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      item.eventName.toLocaleLowerCase().includes(needle),
    );
  }, [catalog.data?.items, search]);

  return (
    <PageShell className="max-w-6xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={Activity}
        eyebrow="Event intelligence"
        title="Product events"
        description="Inspect verified raw events and conversions, narrow subscriber-linked evidence, export a bounded snapshot, and observe new arrivals without confusing an idle stream with a broken one."
        refreshLabel="Refresh event data"
        refreshing={meQuery.isFetching || activeRequests > 0}
        onRefresh={() => {
          void meQuery.refetch();
          void queryClient.invalidateQueries({ queryKey: keyBase });
        }}
      />

      {meQuery.isError ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 p-4 text-sm"
        >
          Workspace identity could not be verified. Raw subscriber-linked
          events, conversions, and write controls remain unavailable.
        </div>
      ) : null}

      <GovernanceSection
        icon={BarChart3}
        title="30-day volume"
        description="Counts stay attached to the exact UTC period and as-of time returned by the aggregate endpoint."
      >
        {stats.isPending ? (
          <GovernanceLoading label="Loading product-event volume…" rows={3} />
        ) : stats.isError ? (
          <GovernanceError
            message="Could not verify product-event statistics. A failed read is not being presented as zero activity."
            retrying={stats.isFetching}
            onRetry={() => void stats.refetch()}
          />
        ) : stats.data ? (
          <>
            <GovernanceMetrics
              items={[
                {
                  label: "Events",
                  value: stats.data.totalEvents.toLocaleString(),
                  detail: `Across ${stats.data.periodDays.toLocaleString()} UTC days`,
                },
                {
                  label: "Subscribers",
                  value: stats.data.uniqueSubscribers.toLocaleString(),
                  detail: "Unique subscribers represented",
                },
                {
                  label: "Event names",
                  value: stats.data.uniqueEventNames.toLocaleString(),
                  detail: "Distinct tracked actions",
                },
              ]}
            />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Measurement window: {stats.data.periodDays.toLocaleString()} days
              in {stats.data.timeZone}, as of{" "}
              {formatWireTimestamp(stats.data.asOf, "an unknown time")}.
            </p>
            {stats.data.totalEvents === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed bg-muted/20 px-3 py-3 text-sm leading-6 text-muted-foreground">
                The verified aggregate is empty for this window. A newly
                installed tracker should appear after its first accepted event.
              </p>
            ) : null}
          </>
        ) : (
          <GovernanceEmpty>No event statistics were reported.</GovernanceEmpty>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={Tags}
        title="Event catalogue"
        description="Period-scoped counts, subscriber reach, first/last bounds, and the server's seven-day series for each returned event name."
      >
        {catalog.isPending ? (
          <GovernanceLoading
            label="Loading product-event catalogue…"
            rows={4}
          />
        ) : catalog.isError ? (
          <GovernanceError
            message="Could not verify the event catalogue. It has not been shown as an empty catalogue."
            retrying={catalog.isFetching}
            onRetry={() => void catalog.refetch()}
          />
        ) : (catalog.data?.items?.length ?? 0) === 0 ? (
          <GovernanceEmpty>
            No event names were seen in this period.
          </GovernanceEmpty>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {catalog.data?.totalDistinctEventNames.toLocaleString()}{" "}
                distinct{" "}
                {catalog.data?.totalDistinctEventNames === 1
                  ? "event name"
                  : "event names"}
                . The API returns at most 200 rows.
              </p>
              <div className="relative w-full sm:max-w-xs">
                <Label htmlFor="track-event-search" className="sr-only">
                  Search event names
                </Label>
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="track-event-search"
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search event names"
                  className="pl-9"
                />
              </div>
            </div>
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {filteredItems.length.toLocaleString()} shown.
            </p>
            {filteredItems.length === 0 ? (
              <GovernanceEmpty>
                No event names match “{search.trim()}”.
              </GovernanceEmpty>
            ) : (
              <EventCatalog
                items={filteredItems}
                selectedEvent={scope.eventName}
                onPick={scope.pickEventName}
              />
            )}
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Catalogue totals and first/last bounds cover{" "}
              {catalog.data?.periodDays.toLocaleString()} days; each inline
              daily series covers{" "}
              {catalog.data?.dailySeriesPeriodDays.toLocaleString()} days. Both
              use {catalog.data?.timeZone} and are frozen as of{" "}
              {formatWireTimestamp(catalog.data?.asOf, "an unknown time")}.
            </p>
          </>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={Activity}
        title="Event investigation"
        description="Server-side event/subscriber filters, client-scoped time range, raw-row details, a pausable verified live tail, and an authenticated bounded CSV snapshot."
      >
        {meQuery.isSuccess && meQuery.data ? (
          <>
            <div className="mb-5 flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Controlled event action</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Owners and admins can submit one idempotent live event after
                  fresh authority and explicit consequence checks.
                </p>
              </div>
              <TrackEventComposer
                key={`composer:${principalKey}`}
                identity={meQuery.data}
                onSent={() =>
                  void queryClient.invalidateQueries({ queryKey: keyBase })
                }
              />
            </div>
            <TrackEventBrowser
              key={`browser:${principalKey}`}
              identity={meQuery.data}
              queryKeyBase={keyBase}
              scope={scope}
            />
          </>
        ) : meQuery.isPending ? (
          <GovernanceLoading label="Verifying event-feed access…" rows={4} />
        ) : (
          <GovernanceEmpty>
            Verify workspace identity before loading subscriber-linked events.
          </GovernanceEmpty>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={TrendingUp}
        title="Conversions"
        description="Cursor-paged conversion facts, explicit attribution provenance, server-to-server integration guidance, and the admin tracking-key lifecycle."
      >
        {meQuery.isSuccess && meQuery.data ? (
          <TrackConversionsPanel
            key={`conversions:${principalKey}`}
            identity={meQuery.data}
            queryKeyBase={keyBase}
          />
        ) : meQuery.isPending ? (
          <GovernanceLoading
            label="Verifying conversion-feed access…"
            rows={4}
          />
        ) : (
          <GovernanceEmpty>
            Verify workspace identity before loading conversions.
          </GovernanceEmpty>
        )}
      </GovernanceSection>
    </PageShell>
  );
}
