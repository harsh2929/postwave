// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listCapabilities, listJobs } from "@/lib/migration-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";
import { isTerminal } from "@/lib/types";
import { anyServiceNotDeployed } from "@/lib/service-availability";
import {
  MigrationsIndexContent,
  MigrationsLoading,
  IndexAccessState,
} from "./_index-content";

export default function MigrationsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const identity = meQuery.data;
  const role = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = Boolean(
    identity && !identity.viewer_mode && roleCanWrite(role),
  );
  const principalKey = identity
    ? `${identity.tenant_id}:${identity.user_id}:${role}:${identity.viewer_mode ? "viewer" : "member"}`
    : "unresolved";
  const protectedPrincipal =
    meQuery.isSuccess && canAdmin ? principalKey : "unverified";
  const previousPrincipalRef = useRef<string | null>(null);
  const migrationKey = useMemo(
    () => [
      ...base("migrations", identity?.tenant_id ?? "unresolved", role),
      protectedPrincipal,
      "index",
    ],
    [identity?.tenant_id, protectedPrincipal, role],
  );
  const capabilitiesQuery = useQuery({
    queryKey: [...migrationKey, "capabilities"] as const,
    queryFn: ({ signal }) => listCapabilities(signal),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.reference,
  });
  const jobsQuery = useQuery({
    queryKey: [...migrationKey, "jobs"] as const,
    queryFn: ({ signal }) => listJobs(signal),
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
    refetchInterval: (query) => {
      const jobs = Array.isArray(query.state.data) ? query.state.data : [];
      return jobs.some((job) => !isTerminal(job.status)) ? 5_000 : false;
    },
  });

  useEffect(() => {
    const previous = previousPrincipalRef.current;
    if (previous && previous !== protectedPrincipal) {
      void queryClient.cancelQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
      queryClient.removeQueries({
        predicate: (query) => query.queryKey.includes(previous),
      });
    }
    previousPrincipalRef.current =
      protectedPrincipal === "unverified" ? null : protectedPrincipal;
  }, [protectedPrincipal, queryClient]);

  if (meQuery.isPending) return <MigrationsLoading />;
  if (meQuery.isError || !identity) {
    return (
      <IndexAccessState
        title="Migration access could not be verified"
        description="No migration data was requested. Retry after restoring your workspace session."
        retrying={meQuery.isFetching}
        onRetry={() => void meQuery.refetch()}
      />
    );
  }
  if (!canAdmin) {
    return (
      <IndexAccessState
        title="Administrator access required"
        description="Migration sources and history are available only to workspace owners and administrators. Viewer mode never loads migration data."
      />
    );
  }

  return (
    <MigrationsIndexContent
      key={principalKey}
      capabilities={
        Array.isArray(capabilitiesQuery.data) ? capabilitiesQuery.data : []
      }
      jobs={Array.isArray(jobsQuery.data) ? jobsQuery.data : []}
      capabilitiesPending={capabilitiesQuery.isPending}
      jobsPending={jobsQuery.isPending}
      capabilitiesUnavailable={capabilitiesQuery.isError}
      jobsUnavailable={jobsQuery.isError}
      serviceNotDeployed={anyServiceNotDeployed(
        capabilitiesQuery.error,
        jobsQuery.error,
      )}
      principalKey={principalKey}
      tenantId={identity.tenant_id}
      onRetryCapabilities={() => capabilitiesQuery.refetch()}
      onRetryJobs={() => jobsQuery.refetch()}
    />
  );
}
