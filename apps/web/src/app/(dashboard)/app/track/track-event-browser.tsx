// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { Download, Pause, Play, Search } from "lucide-react";

import { TrackEventSlideover } from "@/components/TrackEventSlideover";
import { EventNameFilterButton } from "@/components/track/EventCatalog";
import { SubscriberScopePicker } from "@/components/track/SubscriberScopePicker";
import { TrackScopeTokens } from "@/components/track/TrackScopeTokens";
import type { TrackInvestigationScope } from "@/components/track/use-track-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import {
  exactPrincipalKey,
  verifyFreshExactPrincipal,
} from "@/lib/exact-principal";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import {
  subscribeTrackStream,
  type StreamStatus,
} from "@/lib/live-streams-api";
import { STALE } from "@/lib/query-keys";
import { useOnline } from "@/lib/use-online";
import {
  exportTrackEventsCsv,
  listTrackEvents,
  parseTrackEvents,
  type TrackEvent,
  type TrackEventsPage,
} from "@/lib/track-api";
import { pluralizeCount } from "@/lib/pluralize";

const RANGE_OPTIONS = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

function rangeStart(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function previewProperties(event: TrackEvent): string {
  const serialized = JSON.stringify(event.properties);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}

interface ExportOperation {
  controller: AbortController;
  principalKey: string;
}

interface ExportIntent {
  filters: {
    eventName?: string;
    subscriberId?: string;
    occurredAfter: string;
    limit: number;
  };
  operation: ExportOperation;
}

export function TrackEventBrowser({
  identity,
  queryKeyBase,
  scope,
}: {
  identity: MeResponse;
  queryKeyBase: QueryKey;
  /**
   * The page-owned investigation scope, shared with the event catalogue: its
   * event name and subscriber drive the feed query, the live tail and the
   * CSV export here.
   */
  scope: TrackInvestigationScope;
}) {
  const queryClient = useQueryClient();
  const online = useOnline();
  const principalKey = exactPrincipalKey(identity);
  const principalKeyRef = useRef(principalKey);
  principalKeyRef.current = principalKey;
  const exportOperationRef = useRef<ExportOperation | null>(null);
  const eventName = scope.eventName;
  const subscriberId = scope.subscriber?.id ?? "";
  const [draftEventName, setDraftEventName] = useState(eventName);
  const [rangeDays, setRangeDays] = useState(30);
  const [selected, setSelected] = useState<TrackEvent | null>(null);
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [liveCount, setLiveCount] = useState(0);
  const [invalidFrames, setInvalidFrames] = useState(0);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const occurredAfter = useMemo(() => rangeStart(rangeDays), [rangeDays]);

  // The scope can change from outside this panel (the catalogue, a feed row,
  // a scope token). Mirror a new event name into the draft field, and restart
  // the live counters, which only describe the scope they were counted under.
  const [seenScope, setSeenScope] = useState({ eventName, subscriberId });
  if (
    seenScope.eventName !== eventName ||
    seenScope.subscriberId !== subscriberId
  ) {
    if (seenScope.eventName !== eventName) setDraftEventName(eventName);
    setSeenScope({ eventName, subscriberId });
    setLiveCount(0);
    setInvalidFrames(0);
  }

  const eventsKey = useMemo(
    () => [
      ...queryKeyBase,
      "events",
      { eventName: eventName || null, subscriberId: subscriberId || null },
    ],
    [eventName, queryKeyBase, subscriberId],
  );
  const events = useQuery({
    queryKey: eventsKey,
    queryFn: ({ signal }) =>
      listTrackEvents({
        tenantId: identity.tenant_id,
        filters: {
          eventName: eventName || undefined,
          subscriberId: subscriberId || undefined,
          limit: 200,
        },
        signal,
      }),
    staleTime: STALE.list,
  });

  useEffect(() => {
    const scopedKey = eventsKey;
    return () => {
      void queryClient.cancelQueries({ queryKey: scopedKey, exact: true });
      queryClient.removeQueries({ queryKey: scopedKey, exact: true });
    };
  }, [eventsKey, queryClient]);

  useEffect(
    () => () => {
      exportOperationRef.current?.controller.abort();
      exportOperationRef.current = null;
    },
    [],
  );

  const visibleRows = useMemo(
    () =>
      (Array.isArray(events.data?.items) ? events.data.items : []).filter(
        (event) => Date.parse(event.occurredAt) >= Date.parse(occurredAfter),
      ),
    [events.data?.items, occurredAfter],
  );

  useEffect(() => {
    if (!liveEnabled) {
      setStreamStatus("closed");
      return;
    }
    let active = true;
    const openedPrincipal = principalKey;
    const unsubscribe = subscribeTrackStream(
      {
        onStatus: (status) => {
          if (active && principalKeyRef.current === openedPrincipal) {
            setStreamStatus(status);
          }
        },
        onEvent: (payload) => {
          if (!active || principalKeyRef.current !== openedPrincipal) return;
          try {
            const liveEvent = parseTrackEvents(
              { items: [payload] },
              identity.tenant_id,
              1,
            ).items[0];
            if (!liveEvent) return;
            if (subscriberId && liveEvent.subscriberId !== subscriberId) return;
            setLiveCount((count) => count + 1);
            queryClient.setQueryData<TrackEventsPage>(eventsKey, (current) => {
              if (
                !current ||
                current.items.some((row) => row.id === liveEvent.id)
              ) {
                return current;
              }
              return {
                ...current,
                items: [liveEvent, ...current.items].slice(
                  0,
                  current.requestedLimit,
                ),
                atLimit:
                  current.atLimit ||
                  current.items.length + 1 >= current.requestedLimit,
              };
            });
          } catch {
            setInvalidFrames((count) => count + 1);
          }
        },
      },
      eventName || undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    eventName,
    eventsKey,
    identity.tenant_id,
    liveEnabled,
    principalKey,
    queryClient,
    subscriberId,
  ]);

  useEffect(() => {
    setExportStatus(null);
  }, [eventName, occurredAfter, subscriberId]);

  const exportCsv = useMutation({
    mutationKey: ["track", principalKey, "csv-export"],
    mutationFn: async ({ filters, operation }: ExportIntent) => {
      await verifyFreshExactPrincipal(identity, operation.controller.signal);
      if (
        operation.controller.signal.aborted ||
        principalKeyRef.current !== operation.principalKey
      ) {
        throw new Error(
          "Workspace identity changed before the export was requested.",
        );
      }
      return exportTrackEventsCsv({
        filters,
        signal: operation.controller.signal,
      });
    },
    onSuccess: (result, { operation }) => {
      if (
        operation.controller.signal.aborted ||
        principalKeyRef.current !== operation.principalKey ||
        exportOperationRef.current !== operation
      ) {
        return;
      }
      downloadTextFile(
        `postwave-product-events-${new Date().toISOString().slice(0, 10)}.csv`,
        result.csv,
        "text/csv;charset=utf-8",
      );
      setExportStatus(
        result.truncated
          ? `Downloaded the first ${result.serverLimit.toLocaleString()} matching events. The server reported more rows.`
          : "Product-event CSV downloaded.",
      );
    },
    onError: (_error, { operation }) => {
      if (
        !operation.controller.signal.aborted &&
        principalKeyRef.current === operation.principalKey &&
        exportOperationRef.current === operation
      ) {
        setExportStatus(null);
      }
    },
    onSettled: (_data, _error, { operation }) => {
      if (exportOperationRef.current === operation) {
        exportOperationRef.current = null;
      }
    },
  });

  function startExport(): void {
    if (exportOperationRef.current || online === "offline") return;
    const operation = {
      controller: new AbortController(),
      principalKey,
    };
    exportOperationRef.current = operation;
    // Freeze the exact investigation scope before the fresh identity read.
    exportCsv.mutate({
      filters: {
        ...(eventName ? { eventName } : {}),
        ...(subscriberId ? { subscriberId } : {}),
        occurredAfter,
        limit: 10_000,
      },
      operation,
    });
  }

  function applyFilters(event: React.FormEvent): void {
    event.preventDefault();
    if (exportCsv.isPending) return;
    const nextEventName = draftEventName.trim();
    setLiveCount(0);
    setInvalidFrames(0);
    if (nextEventName === eventName) {
      void events.refetch();
      return;
    }
    // pickEventName toggles, so it sets any name that differs from the
    // current one; an empty draft clears the scope.
    if (nextEventName) scope.pickEventName(nextEventName);
    else scope.clearEventName();
  }

  function clearFilters(): void {
    if (exportCsv.isPending) return;
    setDraftEventName("");
    scope.clearAll();
    setLiveCount(0);
    setInvalidFrames(0);
  }

  return (
    <div className="space-y-5">
      <TrackScopeTokens
        rangeLabel={
          RANGE_OPTIONS.find((option) => option.days === rangeDays)?.label ??
          `Last ${rangeDays} days`
        }
        eventName={eventName}
        subscriber={scope.subscriber}
        onClearEventName={scope.clearEventName}
        onClearSubscriber={scope.clearSubscriber}
        disabled={exportCsv.isPending}
      />
      <form
        className="grid gap-4 rounded-xl border bg-muted/10 p-4 lg:grid-cols-[1fr_1fr_auto]"
        onSubmit={applyFilters}
      >
        <div className="space-y-2">
          <Label htmlFor="track-feed-event-name">Event name</Label>
          <Input
            id="track-feed-event-name"
            value={draftEventName}
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            disabled={exportCsv.isPending}
            placeholder="All event names"
            onChange={(event) => setDraftEventName(event.target.value)}
          />
        </div>
        <SubscriberScopePicker
          queryKeyBase={queryKeyBase}
          value={scope.subscriber}
          onChange={scope.setSubscriber}
          disabled={exportCsv.isPending}
        />
        <div className="flex flex-wrap items-end gap-2">
          <Button
            type="submit"
            disabled={events.isFetching || exportCsv.isPending}
          >
            <Search className="size-4" aria-hidden="true" />
            Apply filters
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              exportCsv.isPending ||
              (events.isFetching &&
                !eventName &&
                !subscriberId &&
                !draftEventName)
            }
            onClick={clearFilters}
          >
            Clear
          </Button>
        </div>
      </form>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Event range"
        >
          {RANGE_OPTIONS.map((option) => (
            <Button
              key={option.days}
              type="button"
              size="sm"
              variant={rangeDays === option.days ? "secondary" : "outline"}
              aria-pressed={rangeDays === option.days}
              disabled={exportCsv.isPending}
              onClick={() => setRangeDays(option.days)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            aria-pressed={liveEnabled}
            onClick={() => setLiveEnabled((enabled) => !enabled)}
          >
            {liveEnabled ? (
              <Pause className="size-4" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )}
            {liveEnabled ? "Pause live tail" : "Resume live tail"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={exportCsv.isPending || online === "offline"}
            loading={exportCsv.isPending}
            onClick={startExport}
          >
            <Download className="size-4" aria-hidden="true" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border p-3 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge
              variant={
                !liveEnabled
                  ? "outline"
                  : streamStatus === "open"
                    ? "success"
                    : "warning"
              }
            >
              {!liveEnabled ? "paused" : streamStatus}
            </Badge>
            <span>
              {!liveEnabled
                ? "Live tail is paused."
                : streamStatus === "open"
                  ? liveCount === 0
                    ? "Connected; no matching event has arrived since this scope opened."
                    : `${liveCount.toLocaleString()} matching live event${liveCount === 1 ? "" : "s"} received.`
                  : streamStatus === "connecting"
                    ? "Connecting or reconnecting to the live tail."
                    : "Live tail is closed."}
            </span>
          </div>
          {invalidFrames > 0 ? (
            <p className="mt-2 text-xs text-warning-emphasis">
              {invalidFrames.toLocaleString()} unverified stream frame
              {invalidFrames === 1 ? " was" : "s were"} ignored.
            </p>
          ) : null}
        </div>
        <div className="rounded-lg border p-3 text-sm text-muted-foreground">
          CSV exports contain subscriber IDs and event properties, are fetched
          only on demand through the authenticated session, and are capped at
          10,000 rows / 16 MiB in this browser.
          {online === "offline" ? (
            <p role="note" className="mt-2 text-foreground">
              Reconnect before exporting. Raw event evidence is never exported
              from an offline cache.
            </p>
          ) : null}
          {exportStatus ? (
            <p role="status" className="mt-2 text-foreground">
              {exportStatus}
            </p>
          ) : null}
          {exportCsv.isError ? (
            <p role="alert" className="mt-2 text-destructive">
              {apiErrorMessage(
                exportCsv.error,
                "The CSV could not be exported.",
              )}
            </p>
          ) : null}
        </div>
      </div>

      {events.isPending ? (
        <p
          role="status"
          className="rounded-lg border p-4 text-sm text-muted-foreground"
        >
          Loading recent product events…
        </p>
      ) : events.isError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm"
        >
          <p>
            {apiErrorMessage(
              events.error,
              "Recent events could not be loaded.",
            )}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void events.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
          The latest event read succeeded, but no loaded row matched this range
          and filter scope.
        </div>
      ) : (
        <div
          role="region"
          aria-label="Recent product events"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <table className="w-full min-w-[760px] text-left text-sm">
            <caption className="sr-only">Recent product events</caption>
            <thead className="border-b bg-muted/30 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Occurred
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Event
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Subscriber ID
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Properties
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleRows.map((event) => (
                <tr key={event.id}>
                  <td className="whitespace-nowrap px-3 py-3 text-xs">
                    {formatWireTimestamp(event.occurredAt, "Unknown")}
                  </td>
                  <td className="px-3 py-3">
                    <EventNameFilterButton
                      eventName={event.eventName}
                      selectedEvent={eventName}
                      onPick={scope.pickEventName}
                      disabled={exportCsv.isPending}
                    />
                  </td>
                  <td className="max-w-52 px-3 py-3">
                    <code
                      className="block truncate text-xs"
                      title={event.subscriberId}
                    >
                      {event.subscriberId}
                    </code>
                  </td>
                  <td className="max-w-72 px-3 py-3">
                    <code className="block truncate text-xs text-muted-foreground">
                      {previewProperties(event)}
                    </code>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setSelected(event)}
                    >
                      View details
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {events.data ? (
        <p role="status" className="text-xs leading-5 text-muted-foreground">
          {visibleRows.length.toLocaleString()} of{" "}
          {events.data.items.length.toLocaleString()} loaded rows fall within
          the selected range. The feed endpoint returns the latest{" "}
          {pluralizeCount(events.data.requestedLimit, "row")} and has no tie-safe
          older-page cursor; use the snapshot CSV for a larger, bounded
          investigation.
        </p>
      ) : null}

      <TrackEventSlideover
        event={selected}
        identity={identity}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
