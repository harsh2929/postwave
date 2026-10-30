// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery } from "@tanstack/react-query";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceError,
  GovernanceLoading,
} from "@/components/governance/governance-ui";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { qk, STALE } from "@/lib/query-keys";
import { AiQualityControlPlane } from "./ai-quality-control-plane";

export default function AiQualityPage() {
  const identity = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });

  return (
    <PageShell className="max-w-6xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      {identity.isPending ? (
        <GovernanceLoading label="Verifying AI evidence access…" rows={6} />
      ) : identity.isError || !identity.data ? (
        <GovernanceError
          message={apiErrorMessage(
            identity.error,
            "AI evidence access could not be verified, so no corpus, run, result, or policy data was requested.",
          )}
          retrying={identity.isFetching}
          onRetry={() => void identity.refetch()}
        />
      ) : (
        <AiQualityControlPlane identity={identity.data} />
      )}
    </PageShell>
  );
}
