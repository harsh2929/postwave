// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Consent evidence keeps both consent timestamps, the policy version, source
 * planes, snapshot time, and pagination qualification visible. Dropping any
 * of them turns a point-in-time evidence read into a stronger claim than the
 * response actually makes.
 */
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock3, Database, FileCheck2, ShieldAlert } from "lucide-react";

import { ConsentOlderEventPages } from "@/components/consent/ConsentOlderEventPages";
import { PageShell } from "@/components/dashboard/page-shell";
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
import { pluralizeCount } from "@/lib/pluralize";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  getConsentLedger,
  getPrivacyIncidents,
  recordingLagDays,
} from "@/lib/consent-evidence-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, STALE } from "@/lib/query-keys";

// The push-suppressions manager is ~1,200 lines of admin tooling that sits
// below the consent ledger; loading it on demand keeps this route under the
// dashboard bundle budget without changing what renders once it mounts.
const PushSuppressionsManager = dynamic(
  () =>
    import("./push-suppressions-manager").then(
      (module) => module.PushSuppressionsManager,
    ),
  {
    loading: () => (
      <GovernanceLoading label="Loading push suppression controls…" rows={4} />
    ),
  },
);

export default function ConsentEvidencePage() {
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
      [
        ...base("consent-evidence-admin", tenantId, role),
        userId,
        viewerState,
      ] as const,
    [role, tenantId, userId, viewerState],
  );
  const previousKeyRef = useRef<readonly unknown[] | null>(null);
  const pushFetching = useIsFetching({
    queryKey: ["consent-evidence", "push-registry"],
  });

  const ledger = useQuery({
    queryKey: [...keyBase, "ledger"],
    queryFn: getConsentLedger,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });
  const incidents = useQuery({
    queryKey: [...keyBase, "incidents"],
    queryFn: getPrivacyIncidents,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });
  const evidence = ledger.data;
  const events = Array.isArray(evidence?.events) ? evidence.events : [];
  const planes = Array.isArray(evidence?.source_planes)
    ? evidence.source_planes
    : [];
  const jurisdictions = Array.isArray(incidents.data?.known_jurisdictions)
    ? incidents.data.known_jurisdictions
    : [];
  const incidentRows = Array.isArray(incidents.data?.incidents)
    ? incidents.data.incidents
    : [];
  const refreshing =
    meQuery.isFetching ||
    ledger.isFetching ||
    incidents.isFetching ||
    pushFetching > 0;

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

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={FileCheck2}
        title="Consent evidence"
        description="The auditable record of who agreed to what, when they agreed, and when that agreement reached the ledger."
        refreshLabel="Refresh evidence"
        refreshing={refreshing}
        onRefresh={() => {
          if (canAdmin) {
            void ledger.refetch();
            void incidents.refetch();
          }
          void queryClient.invalidateQueries({
            queryKey: ["consent-evidence", "push-registry"],
          });
        }}
      />

      <GovernanceSection
        icon={Database}
        title="Consent ledger"
        description="Snapshot scope and completeness travel with the evidence."
      >
        {meQuery.isPending ? (
          <GovernanceLoading label="Verifying workspace authority…" rows={3} />
        ) : !canAdmin ? (
          <p className="text-sm text-muted-foreground" role="status">
            {meQuery.isError
              ? "Workspace identity could not be verified. No consent-event request was made."
              : `${ADMIN_READ_ONLY_MESSAGE} Consent events were not fetched.`}
          </p>
        ) : ledger.isPending ? (
          <GovernanceLoading label="Loading consent ledger…" rows={3} />
        ) : ledger.isError || !evidence ? (
          <GovernanceError
            message="Could not load the consent ledger. No absence of consent records has been inferred."
            retrying={ledger.isFetching}
            onRetry={() => void ledger.refetch()}
          />
        ) : (
          <>
            <GovernanceMetrics
              items={[
                {
                  label: "Events reported",
                  value: evidence.count.toLocaleString(),
                  detail:
                    events.length === evidence.count
                      ? "All reported rows are shown"
                      : `${pluralizeCount(events.length, "row")} in this response`,
                },
                {
                  label: "Source stores",
                  value: planes.length.toLocaleString(),
                  detail:
                    planes.length === 0
                      ? "Source coverage was not reported"
                      : planes.join(", ").replace(/_/gu, " "),
                },
                {
                  label: "Read completeness",
                  value: evidence.has_more ? "Partial" : "Complete",
                  detail: evidence.has_more
                    ? `The ${events.length.toLocaleString()} most recently recorded events only`
                    : "The response reports no later page",
                },
              ]}
            />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Snapshot{" "}
              {formatWireTimestamp(evidence.snapshot_at, "time not reported")}
              {evidence.schema_version
                ? ` · schema version ${evidence.schema_version.toLocaleString()}`
                : " · schema version not reported"}
            </p>
          </>
        )}
      </GovernanceSection>

      {!ledger.isPending && !ledger.isError && evidence ? (
        <GovernanceSection
          icon={Clock3}
          title="Events"
          description="Consent time and recording time are shown separately for every event."
        >
          {events.length === 0 ? (
            <GovernanceEmpty>No consent events recorded.</GovernanceEmpty>
          ) : (
            <ul className="divide-y rounded-xl border">
              {events.map((event, eventIndex) => {
                const lag = recordingLagDays(event);
                return (
                  <li
                    key={`${event.id || `${event.subject_id}:${event.created_at}`}:${eventIndex}`}
                    className="min-w-0 p-4"
                  >
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-all text-sm font-medium">
                          {event.subject_email ||
                            event.subject_id ||
                            "Unknown subject"}
                        </p>
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {event.category.replace(/_/gu, " ") ||
                            "category unstated"}
                          {" · via "}
                          {event.source.replace(/_/gu, " ") ||
                            "source unstated"}
                        </p>
                      </div>
                      <Badge
                        className="w-fit capitalize"
                        variant={
                          event.action === "granted" ? "success" : "outline"
                        }
                      >
                        {event.action.replace(/_/gu, " ") || "action unstated"}
                      </Badge>
                    </div>
                    <p className="mt-3 break-words text-sm leading-6 text-muted-foreground">
                      Agreed{" "}
                      {formatWireTimestamp(
                        event.created_at,
                        "at an unrecorded time",
                      )}
                      ; recorded{" "}
                      {formatWireTimestamp(
                        event.recorded_at,
                        "at an unrecorded time",
                      )}
                      {lag === null
                        ? " (gap unknown)"
                        : lag === 0
                          ? ""
                          : ` — ${Math.abs(lag)} day${Math.abs(lag) === 1 ? "" : "s"} ${lag > 0 ? "later" : "earlier"}`}
                      .
                    </p>
                    <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                      Under policy{" "}
                      <span className="break-all font-mono">
                        {event.policy_version || "unstated"}
                      </span>
                      {event.proof_text
                        ? ` · proof: ${event.proof_text}`
                        : null}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          {events.length > 0 || evidence.has_more ? (
            <ConsentOlderEventPages ledger={evidence} />
          ) : null}
          {/*
            The ledger read is paged, newest-recording-first, and older pages
            load only on request. Without saying so, an auditor who cannot find
            a subject above would read that as "no consent on file" when the
            row is simply on a page not loaded yet.
          */}
          {evidence.has_more ? (
            <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">
              This is the first page of the ledger, newest recording first.
              Consent recorded before the oldest event above is held but not
              shown here until older pages are loaded, so a subject missing from
              this list is not a subject missing from the record.
            </p>
          ) : null}
        </GovernanceSection>
      ) : null}

      <GovernanceSection
        icon={ShieldAlert}
        title="Privacy incidents"
        description="Recorded incidents and jurisdictions with built-in notification rules."
      >
        {meQuery.isPending ? (
          <GovernanceLoading label="Verifying workspace authority…" />
        ) : !canAdmin ? (
          <p className="text-sm text-muted-foreground" role="status">
            {meQuery.isError
              ? "Workspace identity could not be verified. No privacy-incident request was made."
              : `${ADMIN_READ_ONLY_MESSAGE} Privacy incidents were not fetched.`}
          </p>
        ) : incidents.isPending ? (
          <GovernanceLoading label="Loading privacy incidents…" />
        ) : incidents.isError ? (
          <GovernanceError
            message="Could not load privacy incidents. No clean record is being claimed."
            retrying={incidents.isFetching}
            onRetry={() => void incidents.refetch()}
          />
        ) : (
          <>
            <GovernanceMetrics
              columns={2}
              items={[
                {
                  label: "Recorded incidents",
                  value: incidentRows.length.toLocaleString(),
                },
                {
                  label: "Known jurisdictions",
                  value: jurisdictions.length.toLocaleString(),
                },
              ]}
            />
            <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">
              {jurisdictions.length > 0
                ? `Rules are known for ${jurisdictions
                    .map(
                      (jurisdiction) => jurisdiction.code || jurisdiction.name,
                    )
                    .filter(Boolean)
                    .join(
                      ", ",
                    )}. An incident outside these has no built-in deadline.`
                : "No built-in jurisdiction deadlines were reported."}
            </p>
          </>
        )}
      </GovernanceSection>

      <PushSuppressionsManager
        key={`${meQuery.data?.tenant_id ?? "anon"}:${meQuery.data?.user_id ?? "anon"}:${meQuery.data?.effective_role ?? meQuery.data?.role ?? "unknown"}:${meQuery.data?.viewer_mode === true}`}
        me={meQuery.data}
        authPending={meQuery.isPending}
        authError={meQuery.isError}
        authFetching={meQuery.isFetching}
        onRetryAuth={() => void meQuery.refetch()}
      />
    </PageShell>
  );
}
