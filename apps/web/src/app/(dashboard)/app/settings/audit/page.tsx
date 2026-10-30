// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Route } from "next";
import { isSafeResourceId, webPath } from "@postwave/route-map";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/relative-time";
import {
  auditExportPath,
  correlationIdOf,
  countAuditLog,
  isTraceableRequestId,
  listAuditLog,
  type AuditFilters,
  type AuditRow,
} from "@/lib/audit-api";
import {
  AI_ACTIVITY_ACTOR_TYPE,
  AUDIT_ACTION_CATEGORIES,
  AUDIT_PRESETS,
  auditActionCategoryFor,
  auditPresetFilters,
  type AuditActionCategory,
} from "@/lib/audit-presets";
import {
  canReadRawAudit,
  getAuditCapabilities,
} from "@/lib/audit-saved-views-access-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { qk } from "@/lib/query-keys";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { enumParam, stringParam } from "@/lib/table-url-state";
import { toast } from "sonner";

function AuditPanelFallback({ label }: { label: string }) {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading {label}…
    </p>
  );
}

const AuditAccessRequestsAdminPanel = dynamic(
  () =>
    import("@/components/settings/audit-views-access-panels").then(
      (module) => module.AuditAccessRequestsAdminPanel,
    ),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="audit-access requests" />,
  },
);
const AuditRestrictedAccessPanel = dynamic(
  () =>
    import("@/components/settings/audit-views-access-panels").then(
      (module) => module.AuditRestrictedAccessPanel,
    ),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="audit-access controls" />,
  },
);
const AuditSavedViewsPanel = dynamic(
  () =>
    import("@/components/settings/audit-views-access-panels").then(
      (module) => module.AuditSavedViewsPanel,
    ),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="saved audit views" />,
  },
);
const AuditForensicsPanel = dynamic(
  () =>
    import("@/components/settings/audit-forensics-panel").then(
      (module) => module.AuditForensicsPanel,
    ),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="forensics tools" />,
  },
);
const AuditChainDialog = dynamic(
  () =>
    import("@/components/settings/audit-chain-dialog").then(
      (module) => module.AuditChainDialog,
    ),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="request chain" />,
  },
);
const AuditDetailDialog = dynamic(
  () =>
    import("./audit-detail-dialog").then((module) => module.AuditDetailDialog),
  {
    ssr: false,
    loading: () => <AuditPanelFallback label="audit entry" />,
  },
);

// The values the server actually WRITES, not a plausible-looking list.
//
// This offered "user" and "api_key", and the system writes neither — so two of
// the four filters returned an empty page every time, which reads as "nothing
// happened" rather than "that is not a thing". Meanwhile "human", the default
// actor type and by far the commonest value, could not be filtered at all.
//
// Where each comes from (all via middleware.WithActor, the one door):
//   human            browser users and human-owned API keys
//   agent            agent API keys and installed marketplace apps
//   system           workers and the external audit portal service
//   platform_operator support/admin operations, including impersonation
//
// Pinned against the Go source by scripts/check-audit-actor-vocabulary.mjs, so
// a new actor type cannot be written by the server and stay unfilterable here.
const ACTOR_TYPES = [
  "",
  "human",
  "agent",
  "system",
  "platform_operator",
] as const;

// Filters live in the URL so a filtered/scrolled audit view can be shared,
// bookmarked, and survives refresh + Back (SETA-029).
const auditSchema = {
  actorType: enumParam(ACTOR_TYPES, ""),
  action: stringParam(""),
  resourceType: stringParam(""),
  resourceId: stringParam(""),
  actorLabel: stringParam(""),
  since: stringParam(""),
  until: stringParam(""),
} as const;

/**
 * Entity detail route for an audited resource, or null (no dead links).
 *
 * Resolved through @postwave/route-map rather than a local table. This held its
 * own map of seven types — campaign, subscriber, segment, form, template,
 * sequence, flow — which had two costs. Every OTHER audited resource rendered
 * as plain text: an approval, a list, a suppression, a migration, a discount, an
 * integration or an affiliate showed the id and no way to open it, on the screen
 * whose entire job is answering "what happened to this thing". And the copy was
 * unguarded, while `scripts/check-route-map-destinations.mjs` checks the shared
 * registry against the real filesystem — so this table could rot into dead links
 * and nothing would say so.
 *
 * `webPath` also knows what this could not: which entities web ships a DETAIL
 * page for, which only a list, and which it does not ship at all. It returns
 * null for the last, which is the same "no dead links" promise, kept by the
 * registry instead of by remembering.
 */
function entityHref(type: string | null | undefined, id: string): Route | null {
  if (!type || !id) return null;
  // Ids come straight off audit rows, so a value carrying "?", "#" or a slash
  // would rewrite the route instead of opening the record. Rejected rather than
  // escaped: an id that is not a safe id is not one we can address.
  if (!isSafeResourceId(id)) return null;

  // ONE DOCUMENTED EXCEPTION, not a shadow table.
  //
  // @postwave/route-map declares `segment` as `web: "none"` because it
  // addresses every entity as `/app/<slug>/<id>` and web ships segments at the
  // NESTED `/app/subscribers/segments/<id>`, which the slug-based registry
  // cannot express. The page it points at exists — verified on disk — so
  // deferring to the registry here would DELETE a link that works today, which
  // is the opposite of the point.
  //
  // Kept to one entry with its reason so it reads as the exception it is. The
  // better fix is in the registry: teach it nested paths, or give web a
  // `/app/segments` route, and then delete this branch. Until then the
  // registry under-reports web's coverage and this is where that shows.
  if (type === "segment") {
    return `/app/subscribers/segments/${id}` as Route;
  }

  const path = webPath(type, id);
  return path ? (path as Route) : null;
}

function isoToDateInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function exclusiveUntilToDateInput(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // The API's `until` boundary is exclusive, while the date picker is
  // inclusive. Inverting dateInputToIso prevents every reload/apply cycle from
  // silently extending a saved range by one day.
  date.setDate(date.getDate() - 1);
  return isoToDateInput(date.toISOString());
}

function dateInputToIso(value: string, daysToAdd: number): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + daysToAdd);
  return date.toISOString();
}

export default function AuditLogPage() {
  const { state, setState, reset } = useTableUrlState(auditSchema);
  const applied: AuditFilters = {
    actorType: state.actorType || undefined,
    action: state.action || undefined,
    resourceType: state.resourceType || undefined,
    resourceId: state.resourceId || undefined,
    actorLabel: state.actorLabel || undefined,
    since: state.since || undefined,
    until: state.until || undefined,
    limit: 50,
  };

  // Draft inputs mirror the applied (URL) filters; Apply commits draft → URL.
  const [actorType, setActorType] = useState<string>(state.actorType);
  const [actorLabel, setActorLabel] = useState(state.actorLabel);
  const [action, setAction] = useState(state.action);
  const [resourceType, setResourceType] = useState(state.resourceType);
  const [resourceId, setResourceId] = useState(state.resourceId);
  const [from, setFrom] = useState(isoToDateInput(state.since));
  const [to, setTo] = useState(exclusiveUntilToDateInput(state.until));

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const detailReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  // The request id whose causal chain is open. Held separately from `detail`
  // so the chain can be opened straight off a row without first opening the
  // single-entry dialog — one click from "this line looks wrong" to the whole
  // request, which is the entire point of the chain endpoint.
  const [chainRequestId, setChainRequestId] = useState<string | null>(null);
  const [requestIdLookup, setRequestIdLookup] = useState("");

  // Keep draft inputs in sync with the URL (Back/Forward/deep-link/preset).
  const urlKey = `${state.actorType}|${state.action}|${state.resourceType}|${state.resourceId}|${state.actorLabel}|${state.since}|${state.until}`;
  // Readable after an await — see loadMore.
  const urlKeyRef = useRef(urlKey);
  urlKeyRef.current = urlKey;
  useEffect(() => {
    setActorType(state.actorType);
    setActorLabel(state.actorLabel);
    setAction(state.action);
    setResourceType(state.resourceType);
    setResourceId(state.resourceId);
    setFrom(isoToDateInput(state.since));
    setTo(exclusiveUntilToDateInput(state.until));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  const identityQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
  });
  const capabilitiesQuery = useQuery({
    queryKey: [
      "audit-capabilities",
      identityQuery.data?.tenant_id ?? "pending",
      identityQuery.data?.effective_role ??
        identityQuery.data?.role ??
        "pending",
      Boolean(identityQuery.data?.viewer_mode),
    ],
    queryFn: ({ signal }) => getAuditCapabilities(signal),
    enabled: Boolean(identityQuery.data),
    retry: false,
  });
  const rawAuditAllowed = Boolean(
    capabilitiesQuery.data && canReadRawAudit(capabilitiesQuery.data),
  );

  const auditQuery = useQuery({
    queryKey: ["audit-log", urlKey],
    queryFn: () => listAuditLog(applied),
    enabled: rawAuditAllowed,
  });

  const queryClient = useQueryClient();
  const tenantId = identityQuery.data?.tenant_id ?? "";
  const role = identityQuery.data ? effectiveAuthRole(identityQuery.data) : null;
  // The total behind the page ("50 shown of ~2,400"). The count route shares
  // the list's WHERE clause but, like stats, has no `until` — a bounded To
  // date would make the total describe a wider window than the rows beside
  // it, so the read is withheld then rather than shown as if it matched.
  const countQuery = useQuery({
    queryKey: qk.audit(tenantId, role, { view: "count", filters: urlKey }),
    queryFn: ({ signal }) => countAuditLog(applied, { signal }),
    enabled: rawAuditAllowed && !applied.until,
    retry: false,
  });

  useEffect(() => {
    if (!auditQuery.data) return;
    setRows(auditQuery.data.rows);
    setNextCursor(auditQuery.data.nextCursor);
  }, [auditQuery.data]);

  useEffect(() => {
    if (!auditQuery.error) return;
    toast.error(
      auditQuery.error instanceof Error
        ? auditQuery.error.message
        : "Could not load audit log.",
    );
  }, [auditQuery.error]);

  const busy = auditQuery.isFetching || loadingMore;
  const hasLoaded = auditQuery.isFetched;
  const refreshPending = auditQuery.isFetching || countQuery.isFetching;
  const lastRefreshedIso = auditQuery.dataUpdatedAt
    ? new Date(auditQuery.dataUpdatedAt).toISOString()
    : null;
  const aiActivityOn = state.actorType === AI_ACTIVITY_ACTOR_TYPE;
  const activeCategory = auditActionCategoryFor(state.action);

  function applyFilters(): void {
    if (from && to && from > to) {
      toast.error("The From date must be on or before the To date.");
      return;
    }
    setRows([]);
    setNextCursor(undefined);
    setState({
      actorType: actorType as (typeof ACTOR_TYPES)[number],
      action: action.trim(),
      resourceType: resourceType.trim(),
      resourceId: resourceId.trim(),
      actorLabel: actorLabel.trim(),
      since: from ? dateInputToIso(from, 0) : "",
      until: to ? dateInputToIso(to, 1) : "",
    });
  }

  function applyPreset(id: string): void {
    const preset = auditPresetFilters(id);
    setRows([]);
    setNextCursor(undefined);
    // Time-window presets replace the range; field presets keep the range.
    setState({
      actorType: (preset.actorType ?? "") as (typeof ACTOR_TYPES)[number],
      action: preset.action ?? "",
      resourceType: "",
      resourceId: "",
      actorLabel: "",
      since: preset.since ?? "",
      until: "",
    });
  }

  function filterByActor(row: AuditRow): void {
    setRows([]);
    setNextCursor(undefined);
    setState({
      actorType: row.actorType as (typeof ACTOR_TYPES)[number],
      actorLabel: row.actorLabel ?? "",
    });
  }

  // governance-16: the trail of one record. Keeps every other filter, so
  // "what happened to this campaign in the last 7 days" is two clicks.
  function filterByResource(row: AuditRow): void {
    if (!row.resourceId) return;
    setRows([]);
    setNextCursor(undefined);
    setState({
      resourceType: row.resourceType ?? "",
      resourceId: row.resourceId,
    });
  }

  // governance-7: a toggle, not a preset — it pivots the actor type and
  // leaves the rest of the filter set alone; pressing it again lifts it.
  function toggleAiActivity(): void {
    setRows([]);
    setNextCursor(undefined);
    setState({ actorType: aiActivityOn ? "" : AI_ACTIVITY_ACTOR_TYPE });
  }

  // governance-9: a chip IS one literal "Action contains" value, applied at
  // once. Pressing the lit chip clears the action filter.
  function toggleCategory(category: AuditActionCategory): void {
    setRows([]);
    setNextCursor(undefined);
    setState({
      action: activeCategory?.id === category.id ? "" : category.action,
    });
  }

  // governance-2. Live tail is on release hold on every client, so a manual
  // refresh is the only freshness verb. The list and the total are this
  // page's reads and are re-read here; the statistics belong to the forensics
  // panel (loaded on request), so they are marked stale under that panel's
  // own key and refetch if it is open — a companion read that settles on its
  // own, not a second copy of the stats query. The count is skipped while a
  // To date is set, for the reason on the query above.
  async function refreshSnapshot(): Promise<void> {
    const forFilters = urlKey;
    const listRead = auditQuery.refetch();
    await Promise.all([
      listRead,
      applied.until ? undefined : countQuery.refetch(),
      queryClient.invalidateQueries({
        queryKey: [...qk.settings(tenantId, role, "audit-forensics"), "stats"],
      }),
    ]);
    const list = await listRead;
    // A refresh reloads the CURRENT page. Rows appended by "Load more" belong
    // to a cursor the fresh page may no longer continue from, and an
    // unchanged first page would otherwise leave them standing as if verified.
    if (forFilters !== urlKeyRef.current || !list.data) return;
    setRows(list.data.rows);
    setNextCursor(list.data.nextCursor);
  }

  function resetFilters(): void {
    setRows([]);
    setNextCursor(undefined);
    reset();
  }

  function applySavedView(filters: {
    actorType: string;
    actorLabel: string;
    action: string;
    resourceType: string;
    resourceId: string;
    since: string;
    until: string;
  }): void {
    setRows([]);
    setNextCursor(undefined);
    setState({
      actorType: filters.actorType as (typeof ACTOR_TYPES)[number],
      actorLabel: filters.actorLabel,
      action: filters.action,
      resourceType: filters.resourceType,
      resourceId: filters.resourceId,
      since: filters.since,
      until: filters.until,
    });
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    // The filter set this page belongs to. Applying a filter clears `rows` and
    // refetches; without this check a load-more already in flight would append
    // its (differently-filtered) page onto the fresh result set.
    const forFilters = urlKey;
    try {
      const page = await listAuditLog({ ...applied, cursor: nextCursor });
      if (forFilters !== urlKeyRef.current) return;
      setRows((prev) => [...prev, ...page.rows]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not load audit log.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  if (
    !identityQuery.isError &&
    !capabilitiesQuery.isError &&
    (identityQuery.isPending || capabilitiesQuery.isPending)
  ) {
    return (
      <div className="max-w-3xl space-y-4" role="status">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <span className="sr-only">Checking audit access…</span>
      </div>
    );
  }
  const identity = identityQuery.data;
  const capabilities = capabilitiesQuery.data;
  if (
    identityQuery.isError ||
    capabilitiesQuery.isError ||
    !identity ||
    !capabilities
  ) {
    const error = identityQuery.error ?? capabilitiesQuery.error;
    return (
      <div className="max-w-3xl space-y-4">
        <header>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Audit log
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Audit access could not be verified.
          </p>
        </header>
        <Card>
          <CardHeader>
            <CardTitle>Access check failed</CardTitle>
            <CardDescription>
              {error instanceof Error
                ? error.message
                : "The audit-capability request failed."}{" "}
              No audit rows or access-request state were displayed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              onClick={() => {
                void identityQuery.refetch();
                void capabilitiesQuery.refetch();
              }}
            >
              Retry access check
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!rawAuditAllowed) {
    return <AuditRestrictedAccessPanel identity={identity} />;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold tracking-tight">
            Audit log
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every privileged action in this workspace, newest first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refreshSnapshot()}
            disabled={refreshPending}
            aria-describedby="audit-refresh-status"
          >
            <RefreshCw
              aria-hidden
              className={refreshPending ? "animate-spin" : undefined}
            />
            {refreshPending ? "Refreshing…" : "Refresh now"}
          </Button>
          {/* governance-34: the agent's investigations were reachable only
              from desktop; this is the one door in from the log they cite. */}
          <Button asChild type="button" variant="outline" size="sm">
            <Link href="/app/settings/audit/investigations">
              Investigations
            </Link>
          </Button>
        </div>
      </header>
      <p
        id="audit-refresh-status"
        role="status"
        aria-live="polite"
        className="-mt-4 text-xs text-muted-foreground"
      >
        {refreshPending ? (
          "Refreshing the current result window."
        ) : auditQuery.isError && lastRefreshedIso ? (
          <>
            Refresh failed. Last verified rows remain visible; last successful
            refresh was <RelativeTime iso={lastRefreshedIso} />.
          </>
        ) : lastRefreshedIso ? (
          <>
            Last refreshed <RelativeTime iso={lastRefreshedIso} />. Live
            streaming is on release hold; refresh reloads the current page.
          </>
        ) : (
          "Not refreshed yet."
        )}
      </p>

      {capabilities.isAdmin ? (
        <AuditAccessRequestsAdminPanel identity={identity} />
      ) : null}

      {/*
        THE INCIDENT-RESPONSE ENTRY POINT.

        The chain could only be reached by finding a row and clicking it, which
        assumes you already know which row. The case the endpoint was written
        for is the opposite one: an engineer is holding a request id out of a log
        line or an error report and wants to know what that request did. Making
        them filter the audit log to rediscover a row whose id they already have
        is the manual join the program exists to remove.
      */}
      <Card>
        <CardHeader>
          <CardTitle>Trace a request</CardTitle>
          <CardDescription>
            Paste a request id — the <code>X-Request-ID</code> response header,
            or the <code>correlation_id</code> on any audit entry — to see every
            audit row that one request wrote, in the order it wrote them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              // The server refuses "" and the "-" sentinel; refusing them here
              // means the person is not shown a dialog that opens onto an empty
              // chain, which reads as "this request did nothing".
              if (!isTraceableRequestId(requestIdLookup)) return;
              setChainRequestId(requestIdLookup.trim());
            }}
          >
            <Input
              value={requestIdLookup}
              onChange={(event) => setRequestIdLookup(event.target.value)}
              placeholder="e.g. postwave-api-7c9f/lF3kQ2xTvB-000042"
              aria-label="Request id"
              className="w-full sm:w-[28rem]"
            />
            <Button
              type="submit"
              disabled={!isTraceableRequestId(requestIdLookup)}
            >
              Trace
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
          <CardDescription>
            Includes API-key, agent, user, and system actors. Filters are saved
            to the URL so you can share or bookmark a view.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AuditSavedViewsPanel
            identity={identity}
            capabilities={capabilities}
            currentFilters={applied}
            onApply={applySavedView}
          />
          <div className="flex flex-wrap gap-2">
            {AUDIT_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <fieldset className="min-w-0 border-0 p-0">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                Actor shortcut
              </legend>
              <Button
                type="button"
                variant={aiActivityOn ? "secondary" : "outline"}
                size="sm"
                aria-pressed={aiActivityOn}
                onClick={toggleAiActivity}
              >
                AI activity
              </Button>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Agent actors only: agent API keys and installed apps.
              </p>
            </fieldset>
            <fieldset className="min-w-0 border-0 p-0">
              <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                Action category
              </legend>
              <div className="flex flex-wrap gap-2">
                {AUDIT_ACTION_CATEGORIES.map((category) => {
                  const pressed = activeCategory?.id === category.id;
                  return (
                    <Button
                      key={category.id}
                      type="button"
                      variant={pressed ? "secondary" : "outline"}
                      size="sm"
                      aria-pressed={pressed}
                      title={category.description}
                      onClick={() => toggleCategory(category)}
                    >
                      {category.label}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {activeCategory
                  ? activeCategory.description
                  : "No action substring filter"}
                .
              </p>
            </fieldset>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="filter-actor-type">Actor type</Label>
              <Select
                id="filter-actor-type"
                value={actorType}
                onChange={(e) => setActorType(e.target.value)}
              >
                {ACTOR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t === "" ? "Any" : t}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-action">Action contains</Label>
              <Input
                id="filter-action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="campaign.sent"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-resource-type">Resource type</Label>
              <Input
                id="filter-resource-type"
                value={resourceType}
                onChange={(e) => setResourceType(e.target.value)}
                placeholder="campaign"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-resource-id">Resource ID contains</Label>
              <Input
                id="filter-resource-id"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                placeholder="UUID or prefix"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-actor-label">Actor label</Label>
              <Input
                id="filter-actor-label"
                value={actorLabel}
                onChange={(e) => setActorLabel(e.target.value)}
                placeholder="e.g. claude-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-from">From</Label>
              <Input
                id="filter-from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="filter-to">To</Label>
              <Input
                id="filter-to"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" onClick={applyFilters} disabled={busy}>
              {busy ? "Loading…" : "Apply filters"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={resetFilters}
              disabled={busy}
            >
              Reset
            </Button>
            <Button asChild type="button" variant="outline">
              <a href={auditExportPath({ ...applied, limit: 10_000 })}>
                Download CSV (max 10,000)
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <AuditForensicsPanel filters={applied} />

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            {rows.length} {rows.length === 1 ? "entry" : "entries"} shown
            {countQuery.data
              ? ` of ${countQuery.data.confidence === "approximate" ? "~" : ""}${countQuery.data.totalEstimate.toLocaleString()} total`
              : ""}
            {applied.since || applied.until
              ? " in the selected server-filtered date range"
              : ""}
            . Select a row to see what changed.
            {countQuery.isError
              ? ` Total count unavailable (${countQuery.error instanceof Error ? countQuery.error.message : "request failed"}).`
              : ""}
            {applied.until ? " Totals are not counted for a bounded To date." : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 && busy ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 && auditQuery.isError ? (
            // Distinct from the empty state below: a failed request must not
            // read as "nothing happened in this workspace". The toast above is
            // transient; this stays on screen.
            <p className="px-3 py-8 text-center text-sm text-destructive">
              Could not load the audit log. This is a failed request, not an
              empty log.
            </p>
          ) : rows.length === 0 && hasLoaded ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No audit entries match these filters.
            </p>
          ) : (
            <>
              {/* SETA-049: mobile reflows the dense table to stacked cards. */}
              <div className="space-y-2 p-3 sm:hidden">
                {rows.map((r) => {
                  const href = r.resourceId
                    ? entityHref(r.resourceType, r.resourceId)
                    : null;
                  const correlationId = correlationIdOf(r);
                  return (
                    <div key={r.id} className="rounded-md border p-3 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{r.action}</span>
                        <RelativeTime
                          iso={r.at}
                          className="shrink-0 text-xs text-muted-foreground"
                        />
                      </div>
                      {r.resourceType ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {r.resourceType}
                          {r.resourceId ? (
                            href ? (
                              <Link
                                href={href}
                                className="ml-1 font-mono underline underline-offset-2"
                                title={r.resourceId}
                              >
                                {r.resourceId.slice(0, 8)}
                              </Link>
                            ) : (
                              <span
                                className="ml-1 font-mono"
                                title={r.resourceId}
                              >
                                · {r.resourceId.slice(0, 8)}
                              </span>
                            )
                          ) : null}
                          {r.resourceId ? (
                            <button
                              type="button"
                              onClick={() => filterByResource(r)}
                              aria-label={`Filter to events touching ${r.resourceId}`}
                              className="ml-2 rounded px-1 underline-offset-2 hover:bg-muted/60 hover:underline"
                            >
                              Filter
                            </button>
                          ) : null}
                        </p>
                      ) : null}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => filterByActor(r)}
                          className="inline-flex items-center gap-2 rounded"
                        >
                          <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs font-medium">
                            {r.actorType}
                          </span>
                          {r.actorLabel ? (
                            <span className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                              {r.actorLabel}
                            </span>
                          ) : null}
                        </button>
                        <span className="flex items-center gap-1">
                          {correlationId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setChainRequestId(correlationId)}
                            >
                              Chain
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`View audit entry ${r.action}`}
                            onClick={(event) => {
                              detailReturnFocusRef.current =
                                event.currentTarget;
                              setDetail(r);
                            }}
                          >
                            View
                          </Button>
                        </span>
                      </div>
                      {r.ip ? (
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {r.ip}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <TableContainer className="hidden border-0 sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Resource</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>IP</TableHead>
                      <TableHead className="text-right">Details</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const href = r.resourceId
                        ? entityHref(r.resourceType, r.resourceId)
                        : null;
                      const correlationId = correlationIdOf(r);
                      return (
                        <TableRow key={r.id} className="hover:bg-muted/20">
                          <TableCell className="whitespace-nowrap text-xs">
                            <RelativeTime iso={r.at} />
                          </TableCell>
                          <TableCell className="font-medium">
                            {r.action}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.resourceType ? (
                              <span>
                                {r.resourceType}
                                {r.resourceId ? (
                                  href ? (
                                    <Link
                                      href={href}
                                      className="ml-1 font-mono text-xs underline underline-offset-2 hover:text-foreground"
                                      title={r.resourceId}
                                    >
                                      {r.resourceId.slice(0, 8)}
                                    </Link>
                                  ) : (
                                    <span
                                      className="ml-1 font-mono text-xs"
                                      title={r.resourceId}
                                    >
                                      · {r.resourceId.slice(0, 8)}
                                    </span>
                                  )
                                ) : null}
                                {r.resourceId ? (
                                  <button
                                    type="button"
                                    onClick={() => filterByResource(r)}
                                    title="Filter to this resource"
                                    aria-label={`Filter to events touching ${r.resourceId}`}
                                    className="ml-2 rounded px-1 text-xs underline-offset-2 hover:bg-muted/60 hover:underline"
                                  >
                                    Filter
                                  </button>
                                ) : null}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              onClick={() => filterByActor(r)}
                              title="Filter to this actor"
                              className="inline-flex items-center gap-2 rounded hover:bg-muted/60"
                            >
                              <span className="rounded bg-muted/60 px-1.5 py-0.5 text-xs font-medium">
                                {r.actorType}
                              </span>
                              {r.actorLabel ? (
                                <span className="text-muted-foreground underline-offset-2 hover:underline">
                                  {r.actorLabel}
                                </span>
                              ) : null}
                            </button>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {r.ip ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            {/* Only on rows that carry a correlation id. Worker
                              and queue-consumer rows are written outside any
                              request and have none — offering "chain" there
                              would open an empty screen every time. */}
                            {correlationId ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title="Everything this request did, in order"
                                onClick={() => setChainRequestId(correlationId)}
                              >
                                Chain
                              </Button>
                            ) : null}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`View audit entry ${r.action}`}
                              onClick={(event) => {
                                detailReturnFocusRef.current =
                                  event.currentTarget;
                                setDetail(r);
                              }}
                            >
                              View
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
          {nextCursor && (
            <div className="flex justify-center border-t p-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {busy ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {detail ? (
        <AuditDetailDialog
          row={detail}
          returnFocus={detailReturnFocusRef}
          onClose={() => {
            setDetail(null);
            setTimeout(() => detailReturnFocusRef.current?.focus(), 0);
          }}
          onOpenChain={(requestId) => {
            // Replace rather than stack: the chain is the wider view of the
            // same moment, and two dialogs deep is a maze to back out of.
            setDetail(null);
            setChainRequestId(requestId);
          }}
          onFilterResource={(row) => {
            setDetail(null);
            filterByResource(row);
          }}
        />
      ) : null}
      {chainRequestId ? (
        <AuditChainDialog
          requestId={chainRequestId}
          onClose={() => setChainRequestId(null)}
        />
      ) : null}
    </div>
  );
}
