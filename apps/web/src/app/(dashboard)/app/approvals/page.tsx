// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, ExternalLink, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ApprovalsAutoRefresh } from "@/components/approvals/approvals-auto-refresh";
import {
  ApprovalsSearchSortBar,
  useApprovalsSearchSort,
} from "@/components/approvals/approvals-search-sort-bar";
import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { purgeStaleApprovalQueries } from "@/lib/approval-cache";
import { isApprovalAuthorityFailure } from "@/lib/approval-rejection";
import {
  countByStatus,
  isActionable,
  listApprovals,
  requesterLabel,
  resourceHref,
  resourceTypeLabel,
  statusVariant,
  type Approval,
  type ApprovalStatus,
} from "@/lib/approvals-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import type { ApprovalDecisionKind } from "./approval-decision-dialog";

const ApprovalDecisionDialog = dynamic(
  () =>
    import("./approval-decision-dialog").then(
      (module) => module.ApprovalDecisionDialog,
    ),
  {
    ssr: false,
    loading: () => (
      <span role="status" className="sr-only">
        Loading approval decision…
      </span>
    ),
  },
);
const ApprovalsGovernancePanel = dynamic(
  () =>
    import("./approvals-governance-panel").then(
      (module) => module.ApprovalsGovernancePanel,
    ),
  {
    ssr: false,
    loading: () => (
      <section
        role="status"
        aria-busy="true"
        className="min-h-28 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
      >
        Loading approval governance status…
      </section>
    ),
  },
);

type FilterValue = ApprovalStatus | "all";
const FILTERS: Array<{ value: FilterValue; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];
const FILTER_VALUES = new Set<string>(FILTERS.map((filter) => filter.value));
const FETCH_LIMIT = 200;

function filterFromSearchParams(
  searchParams: Pick<URLSearchParams, "get">,
): FilterValue {
  const requested = searchParams.get("status");
  if (requested && FILTER_VALUES.has(requested)) {
    return requested as FilterValue;
  }
  return searchParams.get("focus") ? "all" : "pending";
}

export default function ApprovalsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const observedSearchKeyRef = useRef(searchKey);
  const queueRef = useRef<HTMLDivElement | null>(null);
  const statusFallbackRef = useRef<HTMLButtonElement | null>(null);
  const decisionReturnFocusRef = useRef<HTMLElement | null>(null);
  const actionLockRef = useRef<symbol | null>(null);
  const previousScopeRef = useRef<{
    authorityKey: string;
    queryKey: readonly unknown[];
  } | null>(null);
  const [focusId, setFocusId] = useState(() => searchParams.get("focus"));
  const [filter, setFilter] = useState<FilterValue>(() =>
    filterFromSearchParams(searchParams),
  );
  const [decision, setDecision] = useState<{
    approval: Approval;
    kind: ApprovalDecisionKind;
    authorityKey: string;
  } | null>(null);
  const [deniedAuthorityKey, setDeniedAuthorityKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (observedSearchKeyRef.current === searchKey) return;
    observedSearchKeyRef.current = searchKey;
    const next = new URLSearchParams(searchKey);
    setFilter(filterFromSearchParams(next));
    setFocusId(next.get("focus"));
  }, [searchKey]);

  useEffect(() => {
    const params = new URLSearchParams(searchKey);
    const requestedStatus = params.get("status");
    if (
      !params.has("status") ||
      (requestedStatus !== null && FILTER_VALUES.has(requestedStatus))
    ) {
      return;
    }
    params.delete("status");
    const query = params.toString();
    router.replace(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }, [pathname, router, searchKey]);

  function selectFilter(nextFilter: FilterValue): void {
    setFilter(nextFilter);
    const params = new URLSearchParams(searchKey);
    if (nextFilter === "pending" && !params.has("focus")) {
      params.delete("status");
    } else {
      params.set("status", nextFilter);
    }
    const query = params.toString();
    router.push(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  }

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.isSuccess ? meQuery.data : null;
  const tenantId = identity?.tenant_id ?? "anonymous";
  const userId = identity?.user_id ?? "anonymous";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerState = identity?.viewer_mode ? "viewer-mode" : "member-mode";
  const canWrite = Boolean(
    identity && !identity.viewer_mode && (role === "owner" || role === "admin"),
  );
  const authorityKey = identity
    ? [tenantId, userId, role, viewerState].join("\u001f")
    : "unverified";
  const approvalsBaseKey = useMemo(
    () =>
      [
        ...qk.settings(tenantId, role, "approvals"),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );

  useEffect(() => {
    if (meQuery.isPending) return;
    const previous = previousScopeRef.current;
    const current = canWrite
      ? { authorityKey, queryKey: approvalsBaseKey }
      : null;
    if (previous && (!current || previous.authorityKey !== authorityKey)) {
      setDecision(null);
      setDeniedAuthorityKey(null);
    }
    purgeStaleApprovalQueries(queryClient, current?.queryKey);
    previousScopeRef.current = current;
  }, [
    approvalsBaseKey,
    authorityKey,
    canWrite,
    meQuery.isPending,
    queryClient,
  ]);

  const approvalsQuery = useQuery({
    queryKey: approvalsBaseKey,
    queryFn: ({ signal }) =>
      listApprovals("all", FETCH_LIMIT, {
        expectedTenantId: tenantId,
        signal,
      }),
    enabled:
      meQuery.isSuccess && canWrite && deniedAuthorityKey !== authorityKey,
    retry: (failureCount, error) =>
      !isApprovalAuthorityFailure(error) && failureCount < 2,
    staleTime: STALE.list,
  });
  const approvalAccessDenied = deniedAuthorityKey === authorityKey;

  const reverifyDeniedAccess = async (): Promise<void> => {
    const refreshed = await meQuery.refetch();
    if (refreshed.isSuccess) setDeniedAuthorityKey(null);
  };

  useEffect(() => {
    if (!isApprovalAuthorityFailure(approvalsQuery.error)) {
      return;
    }
    setDeniedAuthorityKey(authorityKey);
    setDecision(null);
    purgeStaleApprovalQueries(queryClient);
    void queryClient.invalidateQueries({
      queryKey: qk.authMe(),
      exact: true,
    });
  }, [approvalsQuery.error, authorityKey, queryClient]);

  const all = useMemo(
    () => (Array.isArray(approvalsQuery.data) ? approvalsQuery.data : []),
    [approvalsQuery.data],
  );
  const counts = useMemo(() => countByStatus(all), [all]);
  const items = useMemo(
    () =>
      filter === "all"
        ? all
        : all.filter((approval) => approval.status === filter),
    [all, filter],
  );
  const searchSort = useApprovalsSearchSort(items);
  const visibleItems = searchSort.visible;
  const focusedFound = focusId
    ? all.some((approval) => approval.id === focusId)
    : true;

  useEffect(() => {
    const focused = queueRef.current?.querySelector<HTMLElement>(
      '[data-focus-target="true"]',
    );
    if (!focused) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    focused.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    focused.focus({ preventScroll: true });
  }, [focusId, visibleItems]);

  const invalidateApprovals = (): void => {
    void queryClient.invalidateQueries({
      queryKey: approvalsBaseKey,
      exact: false,
    });
    void queryClient.invalidateQueries({
      queryKey: base("dashboard", tenantId, role),
      exact: false,
    });
  };

  if (meQuery.isPending) {
    return <ApprovalBoundary mode="loading" onRetry={() => undefined} />;
  }
  if (meQuery.isError) {
    return (
      <ApprovalBoundary
        mode="error"
        onRetry={() => void meQuery.refetch()}
        retrying={meQuery.isFetching}
      />
    );
  }
  if (!canWrite || !identity) {
    return <ApprovalBoundary mode="forbidden" onRetry={() => undefined} />;
  }
  if (approvalAccessDenied) {
    return (
      <ApprovalBoundary
        mode="denied"
        onRetry={() => void reverifyDeniedAccess()}
        retrying={meQuery.isFetching}
      />
    );
  }

  return (
    <OperationsShell className="max-w-7xl">
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="Governance"
        title="Approvals"
        description="Inspect sign-off requests and record auditable rejection decisions. Counts describe the loaded 200-item window."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => void approvalsQuery.refetch()}
            loading={approvalsQuery.isFetching}
          >
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        }
      />

      <ApprovalsAutoRefresh
        enabled={approvalsQuery.isSuccess}
        onRefresh={() => approvalsQuery.refetch({ cancelRefetch: false })}
      />

      <Alert>
        <AlertTitle>Approval execution is on release hold</AlertTitle>
        <AlertDescription>
          Approve actions stay unavailable until decision identity, the exact
          resource revision, and downstream execution are proven as one safe
          contract. Rejection remains available, but confirms only the stored
          decision—not requester notification or another downstream effect.
        </AlertDescription>
      </Alert>

      {all.length >= FETCH_LIMIT ? (
        <Alert>
          <AlertTitle>Showing the newest {FETCH_LIMIT} approvals</AlertTitle>
          <AlertDescription>
            Tab counts apply to this loaded window and may not include older
            records.
          </AlertDescription>
        </Alert>
      ) : null}
      {focusId && approvalsQuery.isSuccess && !focusedFound ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>
            The linked approval is not in this loaded window
          </AlertTitle>
          <AlertDescription className="flex min-w-0 flex-col items-start gap-2 break-all">
            <span>
              {focusId} may be older than the newest {FETCH_LIMIT} records or
              may no longer be available.
            </span>
            <Link
              href={asRoute(`/app/approvals/${encodeURIComponent(focusId)}`)}
              className="inline-flex min-h-11 items-center text-primary hover:underline"
            >
              Open direct approval detail
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={filter}
        onValueChange={(value) => selectFilter(value as FilterValue)}
        className="flex flex-col gap-4"
      >
        <TabsList
          aria-label="Approval status"
          className="grid h-auto w-full grid-cols-2 gap-1 sm:w-fit sm:grid-cols-4"
        >
          {FILTERS.map((entry) => (
            <TabsTrigger
              key={entry.value}
              ref={entry.value === filter ? statusFallbackRef : undefined}
              value={entry.value}
            >
              {entry.label}
              <Badge
                variant={filter === entry.value ? "default" : "secondary"}
                className="ml-2 px-1.5"
              >
                {counts[entry.value]}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value={filter} className="mt-0">
          <OperationsSection
            id="approval-queue"
            title="Queue"
            description={
              filter === "pending"
                ? `${counts.pending} pending in the loaded window.`
                : `${counts[filter]} ${filter} approval${counts[filter] === 1 ? "" : "s"} in the loaded window.`
            }
          >
            {approvalsQuery.isPending ? (
              <OperationsLoading label="Loading approval queue" rows={6} />
            ) : approvalsQuery.isError ? (
              <OperationsFailure
                title="Could not load the approval queue"
                description={
                  approvalsQuery.error instanceof ApiError &&
                  approvalsQuery.error.status === 403
                    ? "You need admin access to review approvals. This is a failed request, not an empty queue; nothing was reviewed."
                    : "This is a failed request, not an empty queue. Nothing was reviewed or changed."
                }
                onRetry={() => void approvalsQuery.refetch()}
                retrying={approvalsQuery.isFetching}
              />
            ) : items.length === 0 ? (
              <EmptyState
                icon={ClipboardCheck}
                title="Nothing to review"
                description={
                  filter === "pending"
                    ? "There are no approvals waiting on a decision in the loaded window."
                    : "No approvals in the loaded window match this filter."
                }
              />
            ) : (
              <div ref={queueRef}>
                <div className="mb-3">
                  <ApprovalsSearchSortBar {...searchSort.barProps} />
                </div>
                {visibleItems.length === 0 ? (
                  <EmptyState
                    icon={ClipboardCheck}
                    title="No loaded approvals match this search"
                    description="Clear the search to see every approval in this tab's loaded window."
                  />
                ) : (
                  <>
                    <div
                      aria-hidden
                      className="mb-1 hidden grid-cols-[minmax(10rem,1.7fr)_minmax(8rem,1fr)_8rem_7rem_minmax(12rem,auto)] gap-3 px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:grid"
                    >
                      <span>Resource</span>
                      <span>Requested by</span>
                      <span>Requested</span>
                      <span>Status</span>
                      <span className="text-right">Actions</span>
                    </div>
                    <ul className="space-y-2" aria-label="Approval queue">
                      {visibleItems.map((approval) => (
                        <ApprovalRow
                          key={approval.id}
                          approval={approval}
                          focused={focusId === approval.id}
                          onDecision={(kind, trigger) => {
                            decisionReturnFocusRef.current = trigger;
                            setDecision({ approval, kind, authorityKey });
                          }}
                        />
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </OperationsSection>
        </TabsContent>
      </Tabs>

      <ApprovalsGovernancePanel />

      {decision?.authorityKey === authorityKey ? (
        <ApprovalDecisionDialog
          approval={decision.approval}
          kind={decision.kind}
          identity={identity}
          authorityKey={authorityKey}
          protectedQueryKey={approvalsBaseKey}
          actionLock={actionLockRef}
          onAuthorityDenied={() => setDeniedAuthorityKey(authorityKey)}
          returnFocusRef={decisionReturnFocusRef}
          fallbackFocusRef={statusFallbackRef}
          onClose={() => setDecision(null)}
          onReconciled={(latest) => {
            queryClient.setQueryData<Approval[]>(
              approvalsBaseKey,
              (current = []) =>
                current.map((item) => (item.id === latest.id ? latest : item)),
            );
            setDecision(null);
            void queryClient.invalidateQueries({
              queryKey: approvalsBaseKey,
              exact: false,
              refetchType: "none",
            });
          }}
          onRecorded={(recorded) => {
            queryClient.setQueryData<Approval[]>(
              approvalsBaseKey,
              (current = []) =>
                current.map((item) =>
                  item.id === recorded.id ? recorded : item,
                ),
            );
            setDecision(null);
            invalidateApprovals();
          }}
        />
      ) : null}
    </OperationsShell>
  );
}

function ApprovalBoundary({
  mode,
  onRetry,
  retrying = false,
}: {
  mode: "loading" | "error" | "forbidden" | "denied";
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <OperationsShell className="max-w-7xl">
      <OperationsHeader
        icon={ClipboardCheck}
        eyebrow="Governance"
        title="Approvals"
        description="Inspect sign-off requests and their recorded decisions."
      />
      {mode === "loading" ? (
        <OperationsLoading label="Verifying approval access" rows={6} />
      ) : mode === "error" ? (
        <OperationsFailure
          title="Approval access could not be verified"
          description="The approval API was not queried. Check the connection and try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : mode === "denied" ? (
        <OperationsFailure
          title="Approval access was denied"
          description="Cached approval data was cleared and no decision controls remain active. Verify your current workspace identity and role, then try again."
          onRetry={onRetry}
          retrying={retrying}
        />
      ) : (
        <Alert>
          <AlertTitle>Owner or admin access is required</AlertTitle>
          <AlertDescription>
            No approval queue, delegation, or escalation-policy data was
            requested for the current effective role.
          </AlertDescription>
        </Alert>
      )}
    </OperationsShell>
  );
}

function ApprovalRow({
  approval,
  focused,
  onDecision,
}: {
  approval: Approval;
  focused: boolean;
  onDecision: (kind: ApprovalDecisionKind, trigger: HTMLButtonElement) => void;
}) {
  const href = resourceHref(approval.resourceType, approval.resourceId);
  const actionable = isActionable(approval);
  return (
    <li
      tabIndex={focused ? 0 : undefined}
      data-focus-target={focused ? "true" : undefined}
      className={`grid min-w-0 gap-3 rounded-lg border p-3 text-sm md:grid-cols-[minmax(10rem,1.7fr)_minmax(8rem,1fr)_8rem_7rem_minmax(12rem,auto)] md:items-center ${
        focused
          ? "border-primary/50 bg-primary/[0.055] ring-1 ring-primary/30"
          : "hover:bg-muted/25"
      }`}
    >
      <div className="min-w-0">
        <p className="font-medium">
          {resourceTypeLabel(approval.resourceType)}
        </p>
        {href ? (
          <Link
            href={asRoute(href)}
            className="mt-1 inline-flex max-w-full items-center gap-1 break-all font-mono text-xs text-primary hover:underline"
          >
            {approval.resourceId || "No resource ID"}
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </Link>
        ) : (
          <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
            {approval.resourceId || "No resource ID"}
          </p>
        )}
      </div>
      <div className="min-w-0 break-words">
        <span className="text-xs text-muted-foreground md:sr-only">
          Requested by{" "}
        </span>
        {requesterLabel(approval)}
      </div>
      <div className="text-muted-foreground">
        <span className="text-xs md:sr-only">Requested </span>
        <RelativeTime iso={approval.requestedAt} />
      </div>
      <div>
        <Badge variant={statusVariant(approval.status)}>
          {approval.status}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-2 md:justify-end">
        <Button variant="outline" size="sm" asChild>
          <Link
            href={asRoute(`/app/approvals/${encodeURIComponent(approval.id)}`)}
          >
            Details
          </Link>
        </Button>
        {actionable ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={(event) => onDecision("reject", event.currentTarget)}
          >
            Reject
          </Button>
        ) : (
          <DecidedSummary approval={approval} />
        )}
      </div>
    </li>
  );
}

function DecidedSummary({ approval }: { approval: Approval }) {
  if (approval.status === "pending") {
    return (
      <span className="self-center text-xs text-muted-foreground md:text-right">
        Expired or unsupported; no action available
      </span>
    );
  }
  if (!approval.decidedAt && !approval.decidedByUserId && !approval.notes) {
    return <span className="self-center text-xs text-muted-foreground">—</span>;
  }
  return (
    <span className="min-w-0 break-words text-xs text-muted-foreground md:text-right">
      {approval.decidedByUserId
        ? `By ${approval.decidedByUserId}`
        : "Decision recorded"}
      {approval.decidedAt ? (
        <>
          {" · "}
          <RelativeTime iso={approval.decidedAt} />
        </>
      ) : null}
      {approval.notes ? ` · “${approval.notes}”` : ""}
    </span>
  );
}
