// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceError,
  GovernanceLoading,
} from "@/components/governance/governance-ui";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";

// The routines manager (tables, editors, run history) is the whole page body;
// it loads after the identity check resolves so the route's eager chunk stays
// inside the bundle budget. The fallback is the same skeleton the access check
// shows, so nothing jumps when the manager mounts.
const AgentRoutinesManager = dynamic(
  () =>
    import("./agent-routines-manager").then((m) => m.AgentRoutinesManager),
  {
    loading: () => <GovernanceLoading label="Loading routines…" rows={5} />,
  },
);

export default function AgentRoutinesPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });

  return (
    <PageShell className="max-w-6xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      {meQuery.isPending ? (
        <GovernanceLoading label="Verifying routine access…" rows={5} />
      ) : meQuery.isError || !meQuery.data ? (
        <GovernanceError
          message={apiErrorMessage(
            meQuery.error,
            "Routine access could not be verified, so no routine data was requested.",
          )}
          retrying={meQuery.isFetching}
          onRetry={() => void meQuery.refetch()}
        />
      ) : (
        <AgentRoutinesManager identity={meQuery.data} />
      )}
    </PageShell>
  );
}
