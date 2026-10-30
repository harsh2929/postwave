// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Consent ledger — the evidence behind every "they opted in".
 *
 * `/api/v1/consent/receipts` was reached by desktop and by nothing on web.
 *
 * TWO QUALIFICATIONS TRAVEL WITH THE LIST AND BOTH ARE SHOWN.
 *
 *   `has_more` — "12 receipts" and "12 receipts so far" are different
 *   statements on an evidence surface, and only one of them is safe to put in
 *   front of a regulator.
 *
 *   `source_planes` — which underlying stores the read covered. A ledger that
 *   silently consulted one plane and not the other would be incomplete
 *   evidence presented as complete.
 *
 * `at` and `recorded_at` are also kept apart: when consent was GIVEN and when
 * it was WRITTEN DOWN are different facts, and a gap between them is exactly
 * what an auditor asks about.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Database, ScrollText } from "lucide-react";

import { ConsentEvidenceRegister } from "@/components/consent/ConsentEvidenceRegister";
import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { whoami } from "@/lib/auth-api";
import { pluralizeCount } from "@/lib/pluralize";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { getConsentLedger } from "@/lib/consent-receipts-api";
import { base, STALE } from "@/lib/query-keys";

export default function ConsentLedgerPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [tenantId, userId, role, viewerState] =
    adminReadIdentityParts(identity);
  const keyBase = useMemo(
    () =>
      [...base("consent-ledger", tenantId, role), userId, viewerState] as const,
    [role, tenantId, userId, viewerState],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);

  const ledger = useQuery({
    queryKey: [...keyBase, "receipts"],
    queryFn: getConsentLedger,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });

  const l = ledger.data;
  const rows = Array.isArray(l?.receipts) ? l.receipts : [];

  useEffect(() => {
    const previous = previousKeyRef.current;
    if (previous && previous !== keyBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousKeyRef.current = keyBase;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    void queryClient.cancelQueries({ queryKey: keyBase });
    queryClient.removeQueries({ queryKey: keyBase });
  }, [canAdmin, keyBase, meQuery.isPending, meQuery.isSuccess, queryClient]);

  if (meQuery.isPending || meQuery.isError || !canAdmin) {
    return (
      <PageShell className="max-w-5xl">
        <GovernancePageHeader
          icon={ScrollText}
          title="Consent ledger"
          description="Every recorded grant and withdrawal, with its supporting evidence."
        />
        <GovernanceSection icon={Database} title="Admin access required">
          {meQuery.isPending ? (
            <GovernanceLoading label="Checking workspace authority…" rows={3} />
          ) : meQuery.isError ? (
            <GovernanceError
              message="Workspace identity could not be verified. No consent-receipt request was made."
              retrying={meQuery.isFetching}
              onRetry={() => void meQuery.refetch()}
            />
          ) : (
            <p className="text-sm text-muted-foreground" role="status">
              {ADMIN_READ_ONLY_MESSAGE} No consent receipts were fetched.
            </p>
          )}
        </GovernanceSection>
      </PageShell>
    );
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={ScrollText}
        title="Consent ledger"
        description="Every recorded grant and withdrawal, with when it happened, when it was written down, and which evidence stores were read."
        refreshLabel="Refresh ledger"
        refreshing={ledger.isFetching || meQuery.isFetching}
        onRefresh={() => void ledger.refetch()}
      />

      {ledger.isPending ? (
        <GovernanceSection icon={Database} title="Ledger scope">
          <GovernanceLoading label="Loading consent receipts…" rows={3} />
        </GovernanceSection>
      ) : ledger.isError ? (
        <GovernanceSection icon={Database} title="Ledger scope">
          <GovernanceError
            message="Could not read the consent ledger. It has not been shown as empty—an unreadable ledger is not an absence of consent records."
            retrying={ledger.isFetching}
            onRetry={() => void ledger.refetch()}
          />
        </GovernanceSection>
      ) : l ? (
        <>
          <GovernanceSection
            icon={Database}
            title="Ledger scope"
            description="Receipt count, evidence stores, and pagination qualify this read."
          >
            <GovernanceMetrics
              items={[
                {
                  label: "Receipts reported",
                  value: l.count.toLocaleString(),
                  detail:
                    rows.length === l.count
                      ? "All reported rows are shown"
                      : `${pluralizeCount(rows.length, "row")} in this response`,
                },
                {
                  label: "Evidence stores",
                  value: l.source_planes.length.toLocaleString(),
                  detail:
                    l.source_planes.length > 0
                      ? l.source_planes.join(", ").replace(/_/gu, " ")
                      : "Source coverage not reported",
                },
                {
                  label: "Read completeness",
                  value: l.has_more ? "Partial" : "Complete",
                  detail: l.has_more
                    ? "More pages remain"
                    : "No later page was reported",
                },
              ]}
            />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Snapshot {formatWireTimestamp(l.snapshot_at, "time not reported")}
              {l.schema_version
                ? ` · schema version ${l.schema_version.toLocaleString()}`
                : " · schema version not reported"}
            </p>
          </GovernanceSection>

          <GovernanceSection
            icon={Clock3}
            title="Receipts"
            description="The consent moment and the recording moment remain separate evidence."
          >
            {rows.length === 0 && !l.has_more ? (
              <GovernanceEmpty>No consent receipts recorded.</GovernanceEmpty>
            ) : (
              <ConsentEvidenceRegister ledger={l} />
            )}
          </GovernanceSection>
        </>
      ) : null}
    </PageShell>
  );
}
