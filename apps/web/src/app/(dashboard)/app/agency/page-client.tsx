// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  CirclePause,
  Palette,
  RefreshCw,
  Users,
} from "lucide-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import { canReadAdminData } from "@/lib/admin-read-authority";
import {
  getAgencyBranding,
  listAgencyChildrenPage,
  type AgencyBranding,
  type AgencyChild,
  type AgencyChildrenResponse,
} from "@/lib/agency-api";
import { formatLocaleDate } from "@/lib/format-currency";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { getOnlineStatus } from "@/lib/online-manager";
import { base, qk, STALE } from "@/lib/query-keys";
import { asRoute } from "@/lib/typed-routes";
import { useOnline } from "@/lib/use-online";

const AGENCY_TABS = ["subaccounts", "branding", "invoice"] as const;
export type AgencyTab = (typeof AGENCY_TABS)[number];

export function agencyTab(value: string | null): AgencyTab {
  return AGENCY_TABS.includes(value as AgencyTab)
    ? (value as AgencyTab)
    : "subaccounts";
}

function isNotAgency(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === "not_agency"
  );
}

function isAgencyAccessRestricted(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code !== "not_agency"
  );
}

function retryAgencyRead(count: number, error: Error): boolean {
  return !(error instanceof ApiError && error.status === 403) && count < 2;
}

function agencyAuthorityOwner(identity: MeResponse | undefined): string | null {
  if (!identity) return null;
  const role = identity.viewer_mode ? "viewer" : effectiveAuthRole(identity);
  return JSON.stringify([
    identity.tenant_id,
    identity.user_id,
    role,
    identity.viewer_mode ? "viewer-mode" : "durable-mode",
  ]);
}

export default function AgencyPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const online = useOnline();
  const activeTab = agencyTab(searchParams.get("tab"));

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canRead = Boolean(meQuery.isSuccess && canReadAdminData(meQuery.data));
  const requestReady = online === "online" && canRead && tenantId !== "anon";
  const userId = meQuery.data?.user_id ?? "anon";
  const viewerState = meQuery.data?.viewer_mode
    ? "viewer-mode"
    : "durable-mode";
  const keyBase = useMemo(
    () => [...base("agency", tenantId, role), userId, viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const authorityOwner = useMemo(
    () => JSON.stringify([tenantId, userId, role ?? "unknown", viewerState]),
    [role, tenantId, userId, viewerState],
  );
  const childrenKey = useMemo(
    () => [...keyBase, "children"] as const,
    [keyBase],
  );
  const brandingKey = useMemo(
    () => [...keyBase, "branding"] as const,
    [keyBase],
  );
  const previousAuthorityRef = useRef<{
    owner: string;
    key: readonly unknown[];
  } | null>(null);

  const childrenQuery = useInfiniteQuery({
    queryKey: childrenKey,
    initialPageParam: "" as string,
    queryFn: ({ pageParam, signal }) =>
      listAgencyChildrenPage(tenantId, pageParam || undefined, { signal }),
    getNextPageParam: (
      lastPage,
      _pages,
      _lastPageParam,
      pageParams,
    ): string | undefined =>
      lastPage.has_more && !pageParams.includes(lastPage.next_cursor)
        ? lastPage.next_cursor
        : undefined,
    enabled: requestReady && activeTab === "subaccounts",
    staleTime: STALE.reference,
    retry: retryAgencyRead,
  });
  const brandingQuery = useQuery({
    queryKey: brandingKey,
    queryFn: ({ signal }) => getAgencyBranding(tenantId, { signal }),
    enabled: requestReady && activeTab === "branding",
    staleTime: STALE.reference,
    retry: retryAgencyRead,
  });
  const notAgency = isNotAgency(childrenQuery.error);
  const accessRestricted = isAgencyAccessRestricted(childrenQuery.error);
  const childProjection = useMemo(
    () => mergeAgencyChildrenPages(childrenQuery.data),
    [childrenQuery.data],
  );
  const children = childProjection.issue ? [] : childProjection.children;

  useEffect(() => {
    const previous = previousAuthorityRef.current;
    previousAuthorityRef.current = { owner: authorityOwner, key: keyBase };
    if (previous && previous.owner !== authorityOwner) {
      void queryClient.cancelQueries({ queryKey: previous.key }).then(() => {
        if (previousAuthorityRef.current?.owner !== previous.owner) {
          queryClient.removeQueries({ queryKey: previous.key });
        }
      });
    }
    if (meQuery.isPending || canRead) return;
    void queryClient.cancelQueries({ queryKey: keyBase }).then(() => {
      if (!canRead) queryClient.removeQueries({ queryKey: keyBase });
    });
  }, [authorityOwner, canRead, keyBase, meQuery.isPending, queryClient]);

  const selectTab = (next: string) => {
    const tab = agencyTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "subaccounts") params.delete("tab");
    else params.set("tab", tab);
    const query = params.toString();
    router.push(asRoute(query ? `${pathname}?${query}` : pathname), {
      scroll: false,
    });
  };

  const hasCurrentAgencyAuthority = (): boolean => {
    const current = queryClient.getQueryData<MeResponse>(qk.authMe());
    return Boolean(
      getOnlineStatus() === "online" &&
      current &&
      canReadAdminData(current) &&
      agencyAuthorityOwner(current) === authorityOwner,
    );
  };

  const refreshActive = async () => {
    if (activeTab === "subaccounts") {
      if (
        !hasCurrentAgencyAuthority() ||
        !childrenQuery.isEnabled ||
        childrenQuery.isFetching
      )
        return;
      queryClient.setQueryData<InfiniteData<AgencyChildrenResponse, unknown>>(
        childrenKey,
        (current) =>
          current?.pages[0]
            ? { pages: [current.pages[0]], pageParams: [""] }
            : current,
      );
      await childrenQuery.refetch();
    } else if (activeTab === "branding") {
      if (
        !hasCurrentAgencyAuthority() ||
        !brandingQuery.isEnabled ||
        brandingQuery.isFetching
      )
        return;
      await brandingQuery.refetch();
    }
  };
  const loadMoreChildren = async () => {
    if (
      activeTab !== "subaccounts" ||
      !hasCurrentAgencyAuthority() ||
      !childrenQuery.isEnabled ||
      !childrenQuery.hasNextPage ||
      childrenQuery.isFetching ||
      childProjection.issue
    )
      return;
    await loadNextQueryPage(childrenQuery, true);
  };
  const liveTab = activeTab !== "invoice";

  return (
    <PageShell className="max-w-5xl">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Building2 className="h-4 w-4" aria-hidden />
            Business administration
          </div>
          <h1 className="mt-2 break-words font-display text-2xl font-semibold tracking-tight md:text-3xl">
            Agency
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Review linked workspaces, a stored audit-portal branding draft, and
            the explicit release status of held lifecycle and billing
            capabilities.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full gap-2 sm:min-h-9 sm:w-auto"
          disabled={
            !meQuery.isSuccess ||
            !requestReady ||
            !liveTab ||
            childrenQuery.isFetching ||
            brandingQuery.isFetching
          }
          aria-label={
            liveTab
              ? `Refresh ${activeTab === "branding" ? "audit branding" : "child workspaces"}`
              : "No live data to refresh on release status"
          }
          onClick={() => void refreshActive()}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Refresh
        </Button>
      </header>

      {meQuery.isPending ? (
        <Card aria-label="Checking agency access">
          <CardHeader>
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </CardHeader>
        </Card>
      ) : meQuery.isError || (meQuery.isSuccess && !canRead) ? (
        <Card role="alert" className="border-destructive/30">
          <CardHeader>
            <CardTitle as="h2">
              Workspace access could not be verified
            </CardTitle>
            <CardDescription>
              {meQuery.isError
                ? "Agency data was not requested because the current workspace and role could not be resolved."
                : "Agency data is available only to workspace owners and admins outside viewer mode. No agency request was made."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              loading={meQuery.isFetching}
              disabled={online !== "online" || meQuery.isFetching}
              onClick={() => {
                if (getOnlineStatus() !== "online" || meQuery.isFetching)
                  return;
                void meQuery.refetch();
              }}
            >
              {online === "offline" ? "Reconnect to retry" : "Try again"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Tabs key={authorityOwner} value={activeTab} onValueChange={selectTab}>
          <TabsList
            aria-label="Agency workspace sections"
            className="grid h-auto w-full grid-cols-1 gap-1 sm:grid-cols-3"
          >
            <TabsTrigger value="subaccounts" className="gap-2">
              <Users className="h-4 w-4" aria-hidden />
              Sub-accounts
            </TabsTrigger>
            <TabsTrigger value="branding" className="gap-2">
              <Palette className="h-4 w-4" aria-hidden />
              Audit branding
            </TabsTrigger>
            <TabsTrigger value="invoice" className="gap-2">
              <CirclePause className="h-4 w-4" aria-hidden />
              Release status
            </TabsTrigger>
          </TabsList>

          <TabsContent value="subaccounts" className="pt-3">
            <SubaccountsPanel
              rows={children}
              notAgency={notAgency}
              accessRestricted={accessRestricted}
              integrityIssue={childProjection.issue}
              isPending={childrenQuery.isPending}
              isInitialError={
                childrenQuery.isError && childrenQuery.data === undefined
              }
              isRefreshError={
                childrenQuery.isError &&
                childrenQuery.data !== undefined &&
                !childrenQuery.isFetchNextPageError
              }
              isFetching={childrenQuery.isFetching}
              isFetchingNextPage={childrenQuery.isFetchingNextPage}
              isNextPageError={childrenQuery.isFetchNextPageError}
              hasMore={
                !childProjection.issue && childrenQuery.hasNextPage === true
              }
              requestReady={requestReady && childrenQuery.isEnabled}
              onRetry={() => void refreshActive()}
              onLoadMore={() => void loadMoreChildren()}
            />
          </TabsContent>

          <TabsContent value="branding" className="pt-3">
            <BrandingPanel
              query={brandingQuery}
              requestReady={requestReady && brandingQuery.isEnabled}
              onRetry={() => void refreshActive()}
            />
          </TabsContent>

          <TabsContent value="invoice" className="pt-3">
            <ReleaseStatusPanel />
          </TabsContent>
        </Tabs>
      )}
    </PageShell>
  );
}

export function mergeAgencyChildrenPages(
  data: InfiniteData<AgencyChildrenResponse, unknown> | undefined,
): { children: AgencyChild[]; issue: string | null } {
  if (!data) return { children: [], issue: null };
  if (data.pages.length !== data.pageParams.length) {
    return {
      children: [],
      issue: "The child roster returned inconsistent pagination metadata.",
    };
  }
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  const children: AgencyChild[] = [];
  for (let index = 0; index < data.pages.length; index += 1) {
    const page = data.pages[index];
    const requestedPageParam = data.pageParams[index];
    if (
      !page ||
      typeof requestedPageParam !== "string" ||
      (index === 0 ? requestedPageParam !== "" : !requestedPageParam)
    ) {
      return {
        children: [],
        issue: "The child roster returned an invalid page sequence.",
      };
    }
    const requestedCursor = requestedPageParam;
    if (index > 0) {
      const previous = data.pages[index - 1];
      if (!previous?.has_more || previous.next_cursor !== requestedCursor) {
        return {
          children: [],
          issue: "The child roster returned an invalid page sequence.",
        };
      }
    }
    if (requestedCursor) {
      if (seenCursors.has(requestedCursor)) {
        return {
          children: [],
          issue: "The child roster repeated a pagination cursor.",
        };
      }
      seenCursors.add(requestedCursor);
    }
    for (const child of page.children) {
      if (seenIds.has(child.id)) {
        return {
          children: [],
          issue:
            "The child roster returned the same workspace on multiple pages.",
        };
      }
      seenIds.add(child.id);
      children.push(child);
    }
    if (page.has_more && seenCursors.has(page.next_cursor)) {
      return {
        children: [],
        issue: "The child roster repeated a pagination cursor.",
      };
    }
  }
  return { children, issue: null };
}

function SubaccountsPanel({
  rows,
  notAgency,
  accessRestricted,
  integrityIssue,
  isPending,
  isInitialError,
  isRefreshError,
  isFetching,
  isFetchingNextPage,
  isNextPageError,
  hasMore,
  requestReady,
  onRetry,
  onLoadMore,
}: {
  rows: AgencyChild[];
  notAgency: boolean;
  accessRestricted: boolean;
  integrityIssue: string | null;
  isPending: boolean;
  isInitialError: boolean;
  isRefreshError: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isNextPageError: boolean;
  hasMore: boolean;
  requestReady: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h2">Child workspaces</CardTitle>
            <Badge variant="secondary">Lifecycle release-held</Badge>
            {rows.length > 0 ? (
              <Badge variant="outline">
                {rows.length.toLocaleString()} loaded
              </Badge>
            ) : null}
          </div>
          <CardDescription className="max-w-2xl leading-5">
            Linked workspaces are available for review. Creation, unlinking, and
            billing-owner changes are held until owner, onboarding, invoicing,
            and payer handoffs can complete safely.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <TableSkeleton rows={4} columns={["w-40", "w-20", "w-24", "w-24"]} />
        ) : notAgency ? (
          <EmptyState
            icon={Building2}
            title="This workspace is not an agency"
            description="Agency eligibility is required for the child roster. Read-only audit-portal branding remains available in its own tab."
          />
        ) : accessRestricted ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
          >
            <p className="font-medium text-destructive">
              Child roster access was refused
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Your current role or credential no longer carries agency read
              access. Previously loaded rows are hidden.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
              loading={isFetching}
              disabled={!requestReady || isFetching}
              onClick={onRetry}
            >
              {requestReady ? "Check access again" : "Reconnect to retry"}
            </Button>
          </div>
        ) : integrityIssue ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
          >
            <p className="font-medium text-destructive">
              Child roster could not be verified
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {integrityIssue} No partial roster is shown.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
              loading={isFetching}
              disabled={!requestReady || isFetching}
              onClick={onRetry}
            >
              {requestReady ? "Reload first page" : "Reconnect to retry"}
            </Button>
          </div>
        ) : isInitialError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
          >
            <p className="font-medium text-destructive">
              Child workspaces could not be loaded
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              The request failed, so this is not being presented as an empty
              agency.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
              loading={isFetching}
              disabled={!requestReady || isFetching}
              onClick={onRetry}
            >
              {requestReady ? "Try again" : "Reconnect to retry"}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No child workspaces yet"
            description="Child provisioning is release-held until owner, onboarding, and payer handoff can complete atomically."
          />
        ) : (
          <div className="space-y-4">
            {isRefreshError ? (
              <div
                role="alert"
                className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="text-sm text-muted-foreground">
                  The roster could not be refreshed. The verified rows below are
                  from the last successful read.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0 sm:min-h-9"
                  loading={isFetching}
                  disabled={!requestReady || isFetching}
                  onClick={onRetry}
                >
                  {requestReady ? "Try again" : "Reconnect to retry"}
                </Button>
              </div>
            ) : null}
            {isNextPageError ? (
              <div
                role="alert"
                className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="text-sm text-muted-foreground">
                  The next roster page could not be loaded. The verified rows
                  below are still current.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0 sm:min-h-9"
                  loading={isFetchingNextPage}
                  disabled={!requestReady || isFetchingNextPage}
                  onClick={onLoadMore}
                >
                  {requestReady ? "Retry next page" : "Reconnect to retry"}
                </Button>
              </div>
            ) : null}
            <TableContainer aria-label="Agency child workspaces">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Billing</TableHead>
                    <TableHead>Markup</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((child) => (
                    <TableRow key={child.id}>
                      <TableCell className="max-w-[240px]">
                        <p className="truncate font-medium" title={child.name}>
                          {child.name || "Untitled workspace"}
                        </p>
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={child.slug}
                        >
                          {child.slug || "No slug"}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {child.tier || "Unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {child.billing_mode === "parent"
                          ? "Agency billed"
                          : "Pays itself"}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {(
                          Math.max(0, child.reseller_markup_bps || 0) / 100
                        ).toLocaleString(undefined, {
                          maximumFractionDigits: 2,
                        })}
                        %
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatLocaleDate(child.created_at)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">Review only</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {hasMore ? (
              <div className="flex flex-col gap-3 rounded-lg border border-dashed bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  More linked workspaces are available. Load the next bounded
                  page when you need it.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0 sm:min-h-9"
                  loading={isFetchingNextPage}
                  disabled={!requestReady || isFetchingNextPage}
                  onClick={onLoadMore}
                >
                  {requestReady ? "Load more" : "Reconnect to load more"}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                End of the loaded child roster.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BrandingPanel({
  query,
  requestReady,
  onRetry,
}: {
  query: ReturnType<typeof useQuery<AgencyBranding, Error>>;
  requestReady: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">Audit portal branding</CardTitle>
          <Badge variant="secondary">Publishing release-held</Badge>
        </div>
        <CardDescription className="max-w-2xl leading-5">
          Read-only stored settings for the held audit-portal projection. They
          do not control workspace, preference-center, archive, subscriber, or
          custom-host branding.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <div aria-label="Loading branding settings" className="space-y-4">
            <Skeleton className="h-16 w-full" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          </div>
        ) : query.isError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"
          >
            <p className="font-medium text-destructive">
              Branding settings could not be loaded
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              No local defaults were substituted for the failed request.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 min-h-11 sm:min-h-9"
              loading={query.isFetching}
              disabled={!requestReady || query.isFetching}
              onClick={onRetry}
            >
              {requestReady ? "Try again" : "Reconnect to retry"}
            </Button>
          </div>
        ) : query.data ? (
          <BrandingReadOnly branding={query.data} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Branding configuration is unavailable for this workspace.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BrandingReadOnly({ branding }: { branding: AgencyBranding }) {
  const values = [
    ["Draft state", branding.whitelabel_enabled ? "Enabled" : "Disabled"],
    ["Brand name", branding.brand_name || "Not set"],
    ["Primary color", branding.primary_color || "Not set"],
    ["Logo URL", branding.logo_url || "Not set"],
    ["Support email", branding.support_email || "Not set"],
    ["Custom domain", branding.custom_domain || "Not set"],
    ["Legal entity", branding.legal_entity || "Not set"],
  ] as const;
  return (
    <div
      role="group"
      aria-label="Read-only audit portal branding values"
      className="space-y-4"
    >
      <dl className="grid gap-3 sm:grid-cols-2">
        {values.map(([label, value]) => (
          <div
            key={label}
            className="min-w-0 rounded-lg border bg-muted/20 p-3"
          >
            <dt className="text-xs font-medium text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 break-words text-sm">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs leading-5 text-muted-foreground">
        No branding update request is available in this release. Custom-domain
        and legal-entity values are shown only through the safe API projection;
        unsafe legacy values are omitted and all values remain unpublished.
      </p>
    </div>
  );
}

const HELD_CAPABILITIES = [
  {
    title: "Create a child workspace",
    detail:
      "Requires an atomic owner invitation, onboarding state, regional bootstrap, and billing identity.",
  },
  {
    title: "Unlink a child workspace",
    detail:
      "Requires proven independent ownership and active payer authority before the relationship can be severed.",
  },
  {
    title: "Change the billing owner",
    detail:
      "Requires a durable payer handoff and a consolidated invoicing system that consumes effective-dated history.",
  },
  {
    title: "Preview consolidated billing",
    detail:
      "Requires a fixed rated ledger, exact temporal cutoff, qualified history consumer, and reconciled invoice totals.",
  },
  {
    title: "Publish audit portal branding",
    detail:
      "Requires one canonical publication scope, owned logo delivery, and verified custom-domain routing.",
  },
] as const;

function ReleaseStatusPanel() {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle as="h2">Held agency operations</CardTitle>
          <Badge variant="secondary">No writes or estimates</Badge>
        </div>
        <CardDescription className="max-w-2xl leading-5">
          These capabilities are deliberately unavailable in this release. This
          tab makes the boundary visible without issuing any mutation or
          invoice-preview request.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 md:grid-cols-2">
          {HELD_CAPABILITIES.map((capability) => (
            <section
              key={capability.title}
              className="rounded-lg border bg-muted/20 p-4"
            >
              <div className="flex items-start gap-3">
                <CirclePause
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{capability.title}</h3>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {capability.detail}
                  </p>
                  <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Release-held · no request available
                  </p>
                </div>
              </div>
            </section>
          ))}
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          No usage, cost, subtotal, invoice total, lifecycle change, or branding
          publication is represented as available here.
        </p>
      </CardContent>
    </Card>
  );
}
