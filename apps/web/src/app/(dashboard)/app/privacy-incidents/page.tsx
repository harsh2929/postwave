// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  FileWarning,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { PrivacyIncidentStatStrip } from "@/components/privacy/PrivacyIncidentStatStrip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { pluralizeCount } from "@/lib/pluralize";
import {
  mergePrivacyIncidentPages,
  listPrivacyIncidents,
  type PrivacyIncident,
  type PrivacyIncidentState,
} from "@/lib/privacy-incidents-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { CreateIncidentDialog } from "./create-incident-dialog";
import {
  formatIncidentTime,
  incidentHeadline,
  SEVERITY_LABEL,
  severityVariant,
  sortIncidentsForResponse,
  STATE_LABEL,
  stateVariant,
} from "./incident-presenters";

type RegisterFilter = "all" | PrivacyIncidentState;

const FILTERS: Array<{ value: RegisterFilter; label: string }> = [
  { value: "all", label: "All loaded" },
  { value: "open", label: "Open" },
  { value: "contained", label: "Contained" },
  { value: "notifications_pending", label: "Notifications pending" },
  { value: "closed", label: "Closed" },
];

function authBoundary(
  mode: "loading" | "error" | "forbidden",
  retry?: () => void,
  retrying = false,
) {
  return (
    <OperationsShell className="max-w-6xl">
      <OperationsHeader
        icon={FileWarning}
        eyebrow="Governance"
        title="Privacy incidents"
        description="Tenant-scoped preliminary breach-response records and their verified operational history."
      />
      {mode === "loading" ? (
        <OperationsLoading label="Checking privacy incident access" rows={6} />
      ) : mode === "error" ? (
        <OperationsFailure
          title="Incident access could not be verified"
          description="The current tenant and effective role are unknown, so no incident data or write control is shown."
          onRetry={retry}
          retrying={retrying}
        />
      ) : (
        <Alert variant="destructive">
          <AlertTitle>Admin access required</AlertTitle>
          <AlertDescription>
            The incident register is restricted to the current workspace owner
            and admins. Effective viewer/editor mode stays read-denied because
            the server protects the entire route family with admin scope.
          </AlertDescription>
        </Alert>
      )}
    </OperationsShell>
  );
}

export default function PrivacyIncidentsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<RegisterFilter>("all");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canAccess =
    meQuery.data?.viewer_mode !== true &&
    (role === "owner" || role === "admin");
  const tenantId = meQuery.data?.tenant_id ?? "anonymous";
  const listKey = useMemo(
    () => [...base("privacy-incidents", tenantId, role), "register"] as const,
    [role, tenantId],
  );
  const incidentsQuery = useInfiniteQuery({
    queryKey: listKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listPrivacyIncidents({
        tenantId,
        limit: 100,
        ...(pageParam ? { cursor: pageParam } : {}),
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor,
    enabled: meQuery.isSuccess && canAccess,
    staleTime: STALE.list,
    gcTime: 0,
    refetchOnWindowFocus: "always",
    retry: (count, error) =>
      !(error instanceof ApiError && [401, 403].includes(error.status)) &&
      count < 2,
  });
  const pages = useMemo(
    () =>
      Array.isArray(incidentsQuery.data?.pages)
        ? incidentsQuery.data.pages
        : [],
    [incidentsQuery.data?.pages],
  );
  const merged = useMemo(() => {
    if (pages.length === 0) return { value: null, error: null };
    try {
      return { value: mergePrivacyIncidentPages(pages), error: null };
    } catch (error) {
      return { value: null, error };
    }
  }, [pages]);
  const now = Date.now();
  const rows = useMemo(
    () => sortIncidentsForResponse(merged.value?.incidents ?? [], now),
    [merged.value?.incidents, now],
  );
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      rows.filter((incident) => {
        if (filter !== "all" && incident.status !== filter) return false;
        if (!query) return true;
        return [
          incident.id,
          incident.summary,
          ...incident.affected_regions,
          ...incident.affected_data_categories,
          ...incident.jurisdictions,
        ].some((value) => value.toLocaleLowerCase().includes(query));
      }),
    [filter, query, rows],
  );
  const inventoryReady = Boolean(
    incidentsQuery.isSuccess &&
    !incidentsQuery.isFetching &&
    !merged.error &&
    merged.value?.tenantId === tenantId,
  );

  if (meQuery.isPending) return authBoundary("loading");
  if (meQuery.isError) {
    return authBoundary(
      "error",
      () => void meQuery.refetch(),
      meQuery.isFetching,
    );
  }
  if (!canAccess || !meQuery.data) return authBoundary("forbidden");

  const resetRegister = () =>
    queryClient.resetQueries({ queryKey: listKey, exact: true });
  const retryNextWindow = () => {
    void loadNextQueryPage(incidentsQuery, incidentsQuery.isEnabled);
  };

  return (
    <OperationsShell className="max-w-6xl">
      <OperationsHeader
        icon={FileWarning}
        eyebrow="Governance"
        title="Privacy incidents"
        description="Review preliminary incident facts, non-terminal workflow state, and the merged activity ledger. Counsel approval, delivery proof, packets, legal determinations, and closure remain release-held."
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              loading={incidentsQuery.isFetching}
              onClick={() => void resetRegister()}
            >
              {!incidentsQuery.isFetching ? <RefreshCw aria-hidden /> : null}
              Refresh
            </Button>
            <Button
              type="button"
              disabled={!inventoryReady}
              title={
                inventoryReady
                  ? undefined
                  : "Refresh the verified register before creating a record"
              }
              onClick={() => setCreateOpen(true)}
            >
              <Plus aria-hidden />
              New preliminary record
            </Button>
          </div>
        }
      />

      <Alert variant="warning">
        <AlertTriangle aria-hidden />
        <AlertTitle>Operational register, not a legal determination</AlertTitle>
        <AlertDescription>
          Stored 72-hour fields are legacy response targets, not statutory
          deadlines. Counts and filters below cover only the pages loaded in
          this browser;{" "}
          {merged.value?.nextCursor
            ? "more rows remain."
            : "the loaded register has reached its current end."}
        </AlertDescription>
      </Alert>

      {incidentsQuery.isPending && !merged.value ? (
        <OperationsLoading label="Loading privacy incident register" rows={7} />
      ) : (incidentsQuery.isError && !merged.value) || merged.error ? (
        <OperationsFailure
          title="The incident register could not be verified"
          description="This failed or malformed response is not evidence that no incidents exist. No empty-state or write-ready claim is shown."
          onRetry={() => void resetRegister()}
          retrying={incidentsQuery.isFetching}
        />
      ) : merged.value ? (
        <>
          {incidentsQuery.isError && !incidentsQuery.isFetchNextPageError ? (
            <OperationsFailure
              title="The latest register refresh failed"
              description="Previously verified loaded rows remain visible below, but writes are locked until a current refresh succeeds."
              onRetry={() => void resetRegister()}
              retrying={incidentsQuery.isFetching}
            />
          ) : null}
          <PrivacyIncidentStatStrip rows={rows} now={now} />

          <OperationsSection
            id="privacy-incident-register"
            title="Incident register"
            description="Urgency-first ordering is derived locally from loaded operational facts, never from a legal-obligation inference."
            aside={
              <span
                className="text-sm tabular-nums text-muted-foreground"
                role="status"
              >
                {filtered.length.toLocaleString()} of{" "}
                {rows.length.toLocaleString()} loaded
              </span>
            }
          >
            {rows.length > 0 ? (
              <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
                <div className="space-y-2">
                  <Label htmlFor="privacy-incident-search">
                    Search loaded incidents
                  </Label>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="privacy-incident-search"
                      type="search"
                      className="pl-9"
                      value={search}
                      placeholder="Summary, ID, region, category, jurisdiction"
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="privacy-incident-state-filter">State</Label>
                  <select
                    id="privacy-incident-state-filter"
                    className="w-full rounded-md border border-input bg-background px-3"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as RegisterFilter)
                    }
                  >
                    {FILTERS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <EmptyState
                icon={FileWarning}
                title="No incidents in the verified loaded register"
                description="Open a preliminary operational record when a possible incident is detected. Legal and delivery controls remain external while release-held."
                action={
                  <div className="flex flex-col items-center gap-2">
                    <Button
                      type="button"
                      disabled={!inventoryReady}
                      title={
                        inventoryReady
                          ? undefined
                          : "Refresh the verified register before creating a record"
                      }
                      onClick={() => setCreateOpen(true)}
                    >
                      <Plus aria-hidden />
                      Create preliminary record
                    </Button>
                    {/* inventoryReady drops for the length of every refetch,
                        and the register refetches on window focus "always" —
                        so an operator reaches this state just by tabbing back
                        to the browser. On an empty register this is the only
                        call to action, so the gate must be readable, not a
                        greyed-out button that explains nothing. */}
                    {!inventoryReady ? (
                      <p className="text-xs text-muted-foreground">
                        Refresh the verified register before creating a record.
                      </p>
                    ) : null}
                  </div>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={Search}
                title="No loaded incidents match"
                description="Clear the local search and state filter. This result says nothing about pages that have not been loaded."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <ul className="grid gap-3" aria-label="Privacy incidents">
                {filtered.map((incident) => (
                  <IncidentCard
                    key={incident.id}
                    incident={incident}
                    now={now}
                  />
                ))}
              </ul>
            )}

            {rows.length > 0 ? (
              <div className="mt-5 flex flex-col items-start gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  {incidentsQuery.hasNextPage
                    ? `${pluralizeCount(rows.length, "verified row")} loaded; the next keyset window is available.`
                    : `End of the currently verified register (${pluralizeCount(rows.length, "row")}).`}
                </p>
                {incidentsQuery.hasNextPage ? (
                  <Button
                    type="button"
                    variant="outline"
                    loading={incidentsQuery.isFetchingNextPage}
                    onClick={retryNextWindow}
                  >
                    Load next window
                  </Button>
                ) : null}
              </div>
            ) : null}
            {incidentsQuery.isFetchNextPageError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertTitle>Next window could not be loaded</AlertTitle>
                <AlertDescription>
                  The {rows.length.toLocaleString()} verified rows above remain
                  available. Retry without treating this as the end of the
                  register.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={retryNextWindow}
                  >
                    Retry next window
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
          </OperationsSection>
        </>
      ) : null}

      <CreateIncidentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        tenantId={tenantId}
        userId={meQuery.data.user_id}
        knownJurisdictions={merged.value?.knownJurisdictions ?? []}
        inventoryReady={inventoryReady}
        onCreated={async () => {
          await resetRegister();
        }}
      />
    </OperationsShell>
  );
}

function IncidentCard({
  incident,
  now,
}: {
  incident: PrivacyIncident;
  now: number;
}) {
  const target = incident.gdpr_72h_deadline
    ? Date.parse(incident.gdpr_72h_deadline)
    : Number.NaN;
  const targetPassed =
    incident.status !== "closed" && Number.isFinite(target) && target < now;
  return (
    <li className="min-w-0 rounded-xl border bg-background p-4 transition-colors hover:border-primary/30">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={severityVariant(incident.severity)}>
              {SEVERITY_LABEL[incident.severity]}
            </Badge>
            <Badge variant={stateVariant(incident.status)}>
              {STATE_LABEL[incident.status]}
            </Badge>
            {targetPassed ? (
              <Badge variant="destructive">Target passed</Badge>
            ) : null}
          </div>
          <h3 className="mt-3 break-words text-base font-semibold">
            {incidentHeadline(incident.summary)}
          </h3>
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {incident.id}
          </p>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Detected</dt>
              <dd>{formatIncidentTime(incident.detected_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Last updated</dt>
              <dd>{formatIncidentTime(incident.updated_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                Affected subjects
              </dt>
              <dd className="tabular-nums">
                {incident.affected_subject_count?.toLocaleString() ??
                  "Not estimated"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Recorded scope</dt>
              <dd>
                {incident.affected_regions.length}/regions ·{" "}
                {incident.jurisdictions.length}/jurisdictions
              </dd>
            </div>
          </dl>
        </div>
        <Button asChild variant="outline" className="shrink-0">
          <Link href={asRoute(`/app/privacy-incidents/${incident.id}`)}>
            Review record <ArrowRight aria-hidden />
          </Link>
        </Button>
      </div>
    </li>
  );
}
