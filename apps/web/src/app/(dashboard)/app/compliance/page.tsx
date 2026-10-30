// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BadgeCheck,
  ListChecks,
  ShieldCheck,
} from "lucide-react";

import { PageShell } from "@/components/dashboard/page-shell";
import {
  GovernanceEmpty,
  GovernanceError,
  GovernanceLoading,
  GovernanceMetrics,
  GovernancePageHeader,
  GovernanceSection,
} from "@/components/governance/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  listCompliancePrograms,
  noneAttested,
  unsupportedPrograms,
} from "@/lib/compliance-programs-api";
import { base, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

import { Article50Panel } from "./article-50-panel";
import { RetentionActivityPanel } from "./retention-activity-panel";

const ComplianceProgramControlPlane = dynamic(
  () =>
    import("./compliance-program-control-plane").then(
      (module) => module.ComplianceProgramControlPlane,
    ),
  {
    ssr: false,
    loading: () => (
      <GovernanceLoading
        label="Loading compliance programme controls…"
        rows={3}
      />
    ),
  },
);

export default function CompliancePage() {
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
    retry: false,
  });
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canAccess = Boolean(
    meQuery.data && roleCanWrite(role) && !meQuery.data.viewer_mode,
  );
  const keyBase = useMemo(
    () => base("compliance-programs", meQuery.data?.tenant_id ?? "anon", role),
    [meQuery.data?.tenant_id, role],
  );
  const programs = useQuery({
    queryKey: [...keyBase, "programs"],
    queryFn: ({ signal }) => listCompliancePrograms({ signal }),
    enabled: canAccess,
    staleTime: STALE.reference,
    retry: false,
  });

  const rows = Array.isArray(programs.data) ? programs.data : [];
  const unsupported = unsupportedPrograms(rows);
  const nothingAttested = noneAttested(rows);
  const attested = rows.filter(
    (program) => program.status === "attested",
  ).length;
  const overdue = rows.filter((program) => {
    if (program.status !== "attested" || !program.renewalAt) return false;
    const renewal = Date.parse(program.renewalAt);
    return Number.isFinite(renewal) && renewal < Date.now();
  }).length;

  function refreshAll() {
    void meQuery.refetch();
    if (canAccess) void programs.refetch();
  }

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={ShieldCheck}
        title="Compliance programmes"
        description="Workspace assertions, retained evidence, and explicit product limitations. A recorded attestation is not an independent certification."
        refreshLabel="Refresh programmes"
        refreshing={meQuery.isFetching || programs.isFetching}
        onRefresh={refreshAll}
      />

      {meQuery.isPending ? (
        <GovernanceSection icon={ListChecks} title="Programme coverage">
          <GovernanceLoading label="Checking compliance access…" rows={3} />
        </GovernanceSection>
      ) : meQuery.isError || !meQuery.data ? (
        <GovernanceSection icon={ListChecks} title="Programme coverage">
          <GovernanceError
            message={apiErrorMessage(
              meQuery.error,
              "Workspace identity could not be verified, so no compliance evidence was requested.",
            )}
            retrying={meQuery.isFetching}
            onRetry={() => void meQuery.refetch()}
          />
        </GovernanceSection>
      ) : !canAccess ? (
        <GovernanceSection icon={ListChecks} title="Programme coverage">
          <Alert variant="warning">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Owner or admin access required</AlertTitle>
            <AlertDescription>
              Compliance signer identities, evidence references, and the event
              ledger are tenant-confidential. Viewer mode and editor/viewer
              roles do not request or render them.
            </AlertDescription>
          </Alert>
        </GovernanceSection>
      ) : programs.isPending ? (
        <GovernanceSection icon={ListChecks} title="Programme coverage">
          <GovernanceLoading label="Loading compliance programmes…" rows={3} />
        </GovernanceSection>
      ) : programs.isError ? (
        <GovernanceSection icon={ListChecks} title="Programme coverage">
          <GovernanceError
            message={`Could not load compliance programmes. Nothing has been shown as supported—an unreadable list is not a clean bill of health. ${apiErrorMessage(
              programs.error,
              "The request failed.",
            )}`}
            retrying={programs.isFetching}
            onRetry={() => void programs.refetch()}
          />
        </GovernanceSection>
      ) : (
        <>
          <GovernanceSection
            icon={BadgeCheck}
            title="Programme coverage"
            description="Statuses come directly from this workspace. Framework names and checklist text do not imply certification."
          >
            {rows.length === 0 ? (
              <GovernanceEmpty>
                No compliance programmes were reported. This is an empty result,
                not evidence of certification or support.
              </GovernanceEmpty>
            ) : (
              <>
                <GovernanceMetrics
                  columns={4}
                  items={[
                    {
                      label: "Frameworks reported",
                      value: rows.length.toLocaleString(),
                      detail: "Every programme in this response",
                    },
                    {
                      label: "Attested",
                      value: attested.toLocaleString(),
                      detail: "Workspace assertions on file",
                    },
                    {
                      label: "Overdue review",
                      value: overdue.toLocaleString(),
                      detail: "Attested with a past renewal date",
                    },
                    {
                      label: "Not offered",
                      value: unsupported.length.toLocaleString(),
                      detail: "Explicit product limitations",
                    },
                  ]}
                />
                {nothingAttested ? (
                  <p className="mt-3 rounded-lg bg-warning-subtle px-3 py-2.5 text-sm leading-5 text-warning-emphasis">
                    None of the reported programmes has a current workspace
                    attestation.
                  </p>
                ) : null}
              </>
            )}
          </GovernanceSection>

          {unsupported.length > 0 ? (
            <GovernanceSection
              icon={AlertTriangle}
              title="Not offered"
              description="These are explicit limitations, not incomplete setup tasks."
            >
              <ul className="space-y-3">
                {unsupported.map((programme) => (
                  <li
                    key={programme.framework}
                    className="min-w-0 rounded-lg border border-destructive/20 bg-destructive/5 p-3.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-semibold uppercase tracking-wide">
                        {programme.framework}
                      </p>
                      <Badge variant="destructive">Not offered</Badge>
                    </div>
                    {programme.notes ? (
                      <p className="mt-2 break-words text-sm leading-6 text-muted-foreground">
                        {programme.notes}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </GovernanceSection>
          ) : null}

          <ComplianceProgramControlPlane
            identity={meQuery.data}
            programs={rows}
            queryKeyBase={keyBase}
            refreshPrograms={() => programs.refetch()}
          />
        </>
      )}

      {/* Retention + Article 50 read their own endpoints, so they are gated on
          the same owner/admin access as the rest of the page but NOT on the
          programme list: a failed programmes read must not hide the purge
          ledger, which is separate evidence with a separate failure mode. */}
      {canAccess && meQuery.data ? (
        <>
          <RetentionActivityPanel
            tenantId={meQuery.data.tenant_id}
            role={role}
            enabled={canAccess}
          />
          <Article50Panel
            tenantId={meQuery.data.tenant_id}
            role={role}
            enabled={canAccess}
          />
        </>
      ) : null}
    </PageShell>
  );
}
