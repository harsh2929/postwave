/** Authority-scoped queries for the two released Agency reads. */
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

import {
  getMobileAgencyBranding,
  listMobileAgencyChildrenPage,
  type MobileAgencyBranding,
  type MobileAgencyChild,
} from "@/api/agencyReads";
import type { AIApiError, AIApiResult } from "@/api/request";
import {
  onlineQueryAuthorityOwner,
  useOnlineQueryGate,
  type OnlineQueryGate,
} from "@/hooks/useOnlineQueryGate";
import { agencyForbiddenKind } from "@/lib/agencyAccess";
import {
  mergeAgencyChildrenWirePages,
  type AgencyChildrenWire,
} from "@/lib/agencyWire";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";

export type { MobileAgencyBranding, MobileAgencyChild };

export interface MobileAgencySurfaceError {
  surface: "Audit branding" | "Child roster";
  message: string;
}

export interface MobileAgencyOverview {
  branding: MobileAgencyBranding | null;
  children: MobileAgencyChild[];
  /** This tenant genuinely has no child roster (`not_agency`). */
  notAgency: boolean;
  /** A recognised agency 403 that is not `not_agency`. */
  accessRestricted: boolean;
  brandingUnavailable: boolean;
  childrenUnavailable: boolean;
  errors: MobileAgencySurfaceError[];
}

class AgencyReadError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean | undefined;

  constructor(error: AIApiError) {
    super(error.message || "Agency data could not be loaded.");
    this.name = "AgencyReadError";
    this.status = error.status;
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

function unwrapAgencyRead<T>(result: AIApiResult<T>): T {
  if (result.error) throw new AgencyReadError(result.error);
  if (result.data === null) {
    throw new AgencyReadError({
      status: 0,
      code: "invalid_agency_response",
      message: "The agency response was empty.",
      retryable: false,
    });
  }
  return result.data;
}

function retryAgencyRead(count: number, error: AgencyReadError): boolean {
  return (
    error.status !== 403 &&
    error.retryable !== false &&
    error.code !== "invalid_agency_response" &&
    error.code !== "invalid_agency_cursor" &&
    count < 2
  );
}

function forbiddenKind(error: unknown) {
  return error instanceof AgencyReadError && error.status === 403
    ? agencyForbiddenKind(error.code)
    : null;
}

export function mobileAgencyOverviewKey(
  gate: OnlineQueryGate,
): readonly ["mobile-agency-overview", string] {
  return ["mobile-agency-overview", onlineQueryAuthorityOwner(gate)];
}

interface AgencyQueryFacts {
  branding: {
    data: MobileAgencyBranding | undefined;
    error: unknown;
    isPending: boolean;
  };
  children: {
    /** Only presence is read here; the page-param type is irrelevant to it. */
    data: InfiniteData<AgencyChildrenWire, unknown> | undefined;
    error: unknown;
    isPending: boolean;
    isFetchNextPageError: boolean;
  };
  projection: ReturnType<typeof mergeAgencyChildrenWirePages>;
}

interface AgencyAccessVerdict {
  notAgency: boolean;
  accessRestricted: boolean;
}

function agencyAccessVerdict(facts: AgencyQueryFacts): AgencyAccessVerdict {
  const kinds = [
    forbiddenKind(facts.children.error),
    forbiddenKind(facts.branding.error),
  ];
  const notAgency = kinds.includes("not_agency");
  return {
    notAgency,
    accessRestricted: !notAgency && kinds.some((kind) => kind === "restricted"),
  };
}

/** Surface errors that are NOT a recognised agency 403 (those become verdicts). */
function agencySurfaceErrors(facts: AgencyQueryFacts): MobileAgencySurfaceError[] {
  const errors: MobileAgencySurfaceError[] = [];
  const brandingError = facts.branding.error;
  if (
    brandingError instanceof Error &&
    forbiddenKind(brandingError) === null
  ) {
    errors.push({ surface: "Audit branding", message: brandingError.message });
  }
  const childrenError = facts.children.error;
  if (
    childrenError instanceof Error &&
    forbiddenKind(childrenError) === null &&
    !facts.children.isFetchNextPageError
  ) {
    errors.push({ surface: "Child roster", message: childrenError.message });
  }
  if (facts.projection.issue) {
    errors.push({ surface: "Child roster", message: facts.projection.issue });
  }
  return errors;
}

/** True once each query has either settled or already holds data. */
function agencyInitialSettled(facts: AgencyQueryFacts): boolean {
  return (
    (!facts.branding.isPending || facts.branding.data !== undefined) &&
    (!facts.children.isPending || facts.children.data !== undefined)
  );
}

function buildAgencyOverview(
  facts: AgencyQueryFacts,
  verdict: AgencyAccessVerdict,
): MobileAgencyOverview {
  const { projection } = facts;
  const childrenHidden =
    Boolean(projection.issue) || verdict.accessRestricted || verdict.notAgency;
  return {
    branding: facts.branding.data ?? null,
    children: childrenHidden ? [] : projection.children,
    notAgency: verdict.notAgency,
    accessRestricted: verdict.accessRestricted,
    brandingUnavailable: facts.branding.data === undefined,
    childrenUnavailable:
      Boolean(projection.issue) ||
      (facts.children.data === undefined && !verdict.notAgency),
    errors: agencySurfaceErrors(facts),
  };
}

function agencyHasNextPage(
  facts: AgencyQueryFacts,
  verdict: AgencyAccessVerdict,
  queryHasNextPage: boolean | undefined,
): boolean {
  return (
    !facts.projection.issue &&
    !verdict.accessRestricted &&
    !verdict.notAgency &&
    queryHasNextPage === true
  );
}

export function useMobileAgencyOverview() {
  const gate = useOnlineQueryGate();
  const queryClient = useQueryClient();
  const authorityOwner = onlineQueryAuthorityOwner(gate);
  const canRead = canAccessMinimumRole("admin", gate.effectiveRole);
  const readEnabled = gate.enabled && Boolean(gate.tenantId) && canRead;
  const rootKey = useMemo(
    () => ["mobile-agency-overview", authorityOwner] as const,
    [authorityOwner],
  );
  const brandingKey = useMemo(
    () => [...rootKey, "branding"] as const,
    [rootKey],
  );
  const childrenKey = useMemo(
    () => [...rootKey, "children"] as const,
    [rootKey],
  );
  const previousAuthority = useRef<{
    owner: string;
    key: readonly unknown[];
  } | null>(null);

  const brandingQuery = useQuery({
    queryKey: brandingKey,
    enabled: readEnabled,
    staleTime: 120_000,
    retry: retryAgencyRead,
    queryFn: async ({ signal }) =>
      unwrapAgencyRead(
        await getMobileAgencyBranding(gate.tenantId ?? "", signal),
      ),
  });

  const childrenQuery = useInfiniteQuery({
    queryKey: childrenKey,
    enabled: readEnabled,
    staleTime: 120_000,
    initialPageParam: "",
    retry: retryAgencyRead,
    queryFn: async ({ pageParam, signal }) =>
      unwrapAgencyRead(
        await listMobileAgencyChildrenPage(
          gate.tenantId ?? "",
          pageParam || undefined,
          signal,
        ),
      ),
    getNextPageParam: (lastPage, _pages, _lastPageParam, pageParams) =>
      lastPage.has_more &&
      !pageParams.some((parameter) => parameter === lastPage.next_cursor)
        ? lastPage.next_cursor
        : undefined,
  });

  useEffect(() => {
    const previous = previousAuthority.current;
    previousAuthority.current = { owner: authorityOwner, key: rootKey };
    if (previous && previous.owner !== authorityOwner) {
      void queryClient.cancelQueries({ queryKey: previous.key }).then(() => {
        if (previousAuthority.current?.owner !== previous.owner) {
          queryClient.removeQueries({ queryKey: previous.key });
        }
      });
    }
    if (canRead || !gate.tenantId) return;
    void queryClient.cancelQueries({ queryKey: rootKey }).then(() => {
      if (!canRead) queryClient.removeQueries({ queryKey: rootKey });
    });
  }, [authorityOwner, canRead, gate.tenantId, queryClient, rootKey]);

  const projection = useMemo(
    () =>
      mergeAgencyChildrenWirePages(
        childrenQuery.data?.pages,
        childrenQuery.data?.pageParams,
      ),
    [childrenQuery.data],
  );
  const facts: AgencyQueryFacts = {
    branding: {
      data: brandingQuery.data,
      error: brandingQuery.error,
      isPending: brandingQuery.isPending,
    },
    children: {
      data: childrenQuery.data,
      error: childrenQuery.error,
      isPending: childrenQuery.isPending,
      isFetchNextPageError: childrenQuery.isFetchNextPageError,
    },
    projection,
  };
  const verdict = agencyAccessVerdict(facts);
  const initialSettled = agencyInitialSettled(facts);
  const overview: MobileAgencyOverview | undefined =
    canRead && initialSettled ? buildAgencyOverview(facts, verdict) : undefined;

  const refetch = useCallback(async () => {
    if (!gate.enabled || !gate.tenantId || !canRead) return;
    queryClient.setQueryData<InfiniteData<AgencyChildrenWire, string>>(
      childrenKey,
      (current) =>
        current?.pages[0]
          ? { pages: [current.pages[0]], pageParams: [""] }
          : current,
    );
    await Promise.all([brandingQuery.refetch(), childrenQuery.refetch()]);
  }, [brandingQuery, canRead, childrenKey, childrenQuery, gate, queryClient]);

  const fetchNextPage = useCallback(async () => {
    if (!gate.enabled || !gate.tenantId || !canRead) return;
    await childrenQuery.fetchNextPage();
  }, [canRead, childrenQuery, gate.enabled, gate.tenantId]);

  return {
    data: overview,
    error: brandingQuery.error ?? childrenQuery.error,
    isError: !overview && (brandingQuery.isError || childrenQuery.isError),
    isFetching: brandingQuery.isFetching || childrenQuery.isFetching,
    isLoading: canRead && gate.enabled && !initialSettled,
    refetch,
    hasNextPage: agencyHasNextPage(facts, verdict, childrenQuery.hasNextPage),
    isFetchingNextPage: childrenQuery.isFetchingNextPage,
    isFetchNextPageError: childrenQuery.isFetchNextPageError,
    fetchNextPage,
  };
}
