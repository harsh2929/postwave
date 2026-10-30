// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Credential hygiene — dormant keys, exclusions, and score history.
 *
 * Four paths desktop reached and web did not.
 *
 * "3 INACTIVE KEYS" IS NOT A FACT WITHOUT THE THRESHOLD. The server reports
 * `threshold_days: 90` alongside the count, and an operator deciding whether
 * to revoke needs the window that produced the list — a key unused for 91 days
 * and one unused for three years are the same row otherwise.
 *
 * The score history reports its `model_version` for a related reason: snapshots
 * computed under different model versions are not comparable, so a trend line
 * spanning a version change plots two different measurements as one series.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, KeyRound, ServerCog, ShieldBan } from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import { ContentQueryError } from "../_content-automation/content-query-error";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Badge } from "@/components/ui/badge";
import { whoami } from "@/lib/auth-api";
import {
  getInactiveKeys,
  getScoreHistory,
  listActivationExclusions,
  listSendingProviders,
} from "@/lib/key-hygiene-api";
import { base, qk, STALE } from "@/lib/query-keys";

export default function KeyHygienePage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const canLoad = Boolean(
    meQuery.isSuccess && meQuery.data?.tenant_id && meQuery.data?.user_id,
  );
  const keyBase = useMemo(
    () =>
      base(
        "key-hygiene",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );

  const keys = useQuery({
    queryKey: [...keyBase, "inactive-keys"],
    queryFn: getInactiveKeys,
    enabled: canLoad,
    staleTime: STALE.reference,
  });
  const history = useQuery({
    queryKey: [...keyBase, "score-history"],
    queryFn: getScoreHistory,
    enabled: canLoad,
    staleTime: STALE.dashboard,
  });
  const exclusions = useQuery({
    queryKey: [...keyBase, "exclusions"],
    queryFn: listActivationExclusions,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const providers = useQuery({
    queryKey: [...keyBase, "sending-providers"],
    queryFn: listSendingProviders,
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const k = keys.data;
  const h = history.data;
  const exclusionRows = Array.isArray(exclusions.data) ? exclusions.data : [];
  const providerRows = Array.isArray(providers.data) ? providers.data : [];
  const refreshing =
    meQuery.isFetching ||
    keys.isFetching ||
    history.isFetching ||
    exclusions.isFetching ||
    providers.isFetching;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Credential hygiene
        </h1>
        {meQuery.isPending ? (
          <p role="status">Loading workspace identity…</p>
        ) : (
          <ContentQueryError
            message="Workspace identity could not be loaded. No private data was requested."
            onRetry={() => meQuery.refetch()}
            retrying={meQuery.isFetching}
          />
        )}
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={KeyRound}
        title="Credential hygiene"
        description="Dormant credentials, activation exclusions, sending providers, and the model context behind deliverability history."
        refreshLabel="Refresh hygiene"
        refreshing={refreshing}
        onRefresh={() => {
          void keys.refetch();
          void history.refetch();
          void exclusions.refetch();
          void providers.refetch();
        }}
      />

      <GovernanceSection
        icon={KeyRound}
        title="Dormant API keys"
        description="The inactivity threshold is part of the result, not an implementation detail."
      >
        {keys.isPending ? (
          <GovernanceLoading label="Loading API-key activity…" rows={3} />
        ) : keys.isError ? (
          <GovernanceError
            message="Could not load key activity. Nothing has been shown as dormant—and nothing as active either."
            retrying={keys.isFetching}
            onRetry={() => void keys.refetch()}
          />
        ) : k ? (
          <>
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Dormant keys",
                  value: k.count.toLocaleString(),
                  detail: `Unused for ${k.threshold_days.toLocaleString()} days or more`,
                },
                {
                  label: "Inactivity threshold",
                  value: `${k.threshold_days.toLocaleString()} days`,
                  detail: "Defines which keys are included",
                },
              ]}
            />
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {k.count === 0
                ? `No keys have been unused for ${k.threshold_days.toLocaleString()} days or more.`
                : `${k.count.toLocaleString()} key${k.count === 1 ? " has" : "s have"} crossed the reported inactivity threshold. Review before revoking access.`}
            </p>
          </>
        ) : (
          <GovernanceEmpty>
            No key-activity response was reported.
          </GovernanceEmpty>
        )}
      </GovernanceSection>

      <GovernanceSection
        icon={History}
        title="Deliverability score history"
        description="Snapshots from different model versions must not be read as one continuous series."
      >
        {history.isPending ? (
          <GovernanceLoading label="Loading deliverability score history…" />
        ) : history.isError ? (
          <GovernanceError
            message="Could not load score history. No trend is being inferred."
            retrying={history.isFetching}
            onRetry={() => void history.refetch()}
          />
        ) : h && h.count > 0 ? (
          <GovernanceMetrics
            columns={2}
            items={[
              {
                label: "Snapshots",
                value: h.count.toLocaleString(),
                detail: "Recorded deliverability measurements",
              },
              {
                label: "Model version",
                value: h.model_version || "Not reported",
                detail: "Compare snapshots only within the same model",
              },
            ]}
          />
        ) : (
          <GovernanceEmpty>No score snapshots recorded yet.</GovernanceEmpty>
        )}
        {h?.model_version ? (
          <p className="mt-3 break-all text-xs leading-5 text-muted-foreground">
            Computed under model <code>{h.model_version}</code>. Snapshots from
            other model versions are not directly comparable.
          </p>
        ) : null}
      </GovernanceSection>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <GovernanceSection
          icon={ShieldBan}
          title="Activation exclusions"
          description="Addresses deliberately held back from activation."
        >
          {exclusions.isPending ? (
            <GovernanceLoading label="Loading activation exclusions…" />
          ) : exclusions.isError ? (
            <GovernanceError
              message="Could not load activation exclusions. This is a failed request, not an empty result."
              retrying={exclusions.isFetching}
              onRetry={() => void exclusions.refetch()}
            />
          ) : exclusionRows.length === 0 ? (
            <GovernanceEmpty>No activation exclusions.</GovernanceEmpty>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3.5">
              <span className="text-sm text-muted-foreground">
                Excluded entries
              </span>
              <Badge variant="warning">
                {exclusionRows.length.toLocaleString()}
              </Badge>
            </div>
          )}
        </GovernanceSection>

        <GovernanceSection
          icon={ServerCog}
          title="Sending providers"
          description="Provider definitions available to this workspace."
        >
          {providers.isPending ? (
            <GovernanceLoading label="Loading sending providers…" />
          ) : providers.isError ? (
            <GovernanceError
              message="Could not load sending providers. This is a failed request, not an empty result."
              retrying={providers.isFetching}
              onRetry={() => void providers.refetch()}
            />
          ) : providerRows.length === 0 ? (
            <GovernanceEmpty>No sending providers reported.</GovernanceEmpty>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3.5">
              <span className="text-sm text-muted-foreground">
                Provider definitions
              </span>
              <Badge variant="info">
                {providerRows.length.toLocaleString()}
              </Badge>
            </div>
          )}
        </GovernanceSection>
      </div>
    </PageShell>
  );
}
