// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Statutory requests, scheduled reports and brand voice.
 *
 * Six paths desktop reached and web did not.
 *
 * "NO OUTSTANDING SUBJECT ACCESS REQUESTS" IS A CLAIM WITH A LEGAL DEADLINE
 * BEHIND IT. A failed fetch rendered as an empty list makes that claim on no
 * evidence, so the error branch refuses it explicitly. This is the same rule
 * the privacy portal follows, applied where the consequence is a missed
 * statutory clock rather than a misleading dashboard.
 *
 * The brand-voice 404 is the opposite: "no profile yet" is ordinary, so it is
 * caught and reported as a state.
 */

import { useMemo } from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { FileClock, MessageSquareQuote, RadioTower } from "lucide-react";

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
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { readBrandVoiceProfile } from "@/lib/brand-voice-api";
import {
  listSarRequests,
  listZeroCopyTriggers,
} from "@/lib/compliance-requests-api";
import { base, qk, STALE } from "@/lib/query-keys";
import { roleCanWrite } from "@/lib/use-admin-gate";

import { SubjectAccessRequestsPanel } from "./subject-access-requests-panel";

// The brand-voice editor is the heaviest optional section on this route and
// only renders once the voice read has settled; splitting it keeps the page
// under the dashboard bundle budget without changing what admins see.
const BrandVoicePanel = dynamic(
  () =>
    import("@/components/ai/brand-voice-panel").then(
      (module) => module.BrandVoicePanel,
    ),
  {
    loading: () => (
      <GovernanceLoading label="Loading brand voice controls…" rows={2} />
    ),
  },
);

const ScheduledReportsPanel = dynamic(
  () =>
    import("./scheduled-reports-panel").then(
      (module) => module.ScheduledReportsPanel,
    ),
  {
    loading: () => (
      <div className="lg:col-span-2">
        <GovernanceLoading
          label="Loading scheduled report controls…"
          rows={3}
        />
      </div>
    ),
  },
);

export default function ComplianceRequestsPage() {
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
        "compliance-requests",
        meQuery.data?.tenant_id ?? "anon",
        meQuery.data?.role ?? null,
      ),
    [meQuery.data?.role, meQuery.data?.tenant_id],
  );
  const role = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const canAdmin = Boolean(
    meQuery.data && !meQuery.data.viewer_mode && roleCanWrite(role),
  );

  const sar = useQuery({
    queryKey: [
      ...keyBase,
      "sar",
      role ?? "unknown",
      canAdmin ? "admin" : "read-only",
    ],
    queryFn: ({ signal }) => listSarRequests({ signal }),
    enabled: canLoad && canAdmin,
    staleTime: STALE.list,
    gcTime: 0,
  });
  const triggers = useQuery({
    queryKey: [...keyBase, "zero-copy"],
    queryFn: listZeroCopyTriggers,
    enabled: canLoad,
    staleTime: STALE.list,
  });
  const voiceKey = useMemo(() => [...keyBase, "brand-voice"], [keyBase]);
  const voice = useQuery({
    queryKey: voiceKey,
    queryFn: ({ signal }) => readBrandVoiceProfile({ signal }),
    enabled: canLoad,
    staleTime: STALE.reference,
  });

  const sarRows = Array.isArray(sar.data) ? sar.data : [];
  const triggerRows = Array.isArray(triggers.data) ? triggers.data : [];
  const refreshing =
    meQuery.isFetching ||
    (canAdmin && sar.isFetching) ||
    triggers.isFetching ||
    voice.isFetching;

  if (!canLoad) {
    return (
      <PageShell className="max-w-5xl">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Requests and reports
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
        icon={FileClock}
        title="Requests and reports"
        description="Statutory data requests, recurring reports, and the brand voice used to review generated copy—all kept distinct from failed reads."
        refreshLabel="Refresh workspace"
        refreshing={refreshing}
        onRefresh={() => {
          if (canAdmin) void sar.refetch();
          void triggers.refetch();
          void voice.refetch();
        }}
      />

      <SubjectAccessRequestsPanel
        identity={meQuery.data ?? null}
        identityPending={meQuery.isPending}
        identityError={meQuery.isError}
        identityRetrying={meQuery.isFetching}
        onRetryIdentity={() => void meQuery.refetch()}
        requests={sarRows}
        requestsPending={sar.isPending}
        requestsError={sar.isError ? sar.error : null}
        requestsFetching={sar.isFetching}
        reloadRequests={async () => {
          const result = await sar.refetch();
          if (result.error) throw result.error;
          return result.data ?? [];
        }}
      />

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <ScheduledReportsPanel identity={meQuery.data ?? null} />

        <GovernanceSection
          icon={MessageSquareQuote}
          title="Brand voice"
          description="The profile generated copy is currently checked against, and the editor that replaces it."
        >
          {voice.isPending ? (
            <GovernanceLoading label="Loading brand voice profile…" />
          ) : voice.isError || !voice.data ? (
            <GovernanceError
              message="Could not read the brand voice profile. Its state is unknown."
              retrying={voice.isFetching}
              onRetry={() => void voice.refetch()}
            />
          ) : (
            <>
              {voice.data.active ? (
                <div className="rounded-xl border bg-muted/20 p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-medium">
                      {voice.data.name ?? "Unnamed profile"}
                    </p>
                    <Badge variant="success">Active</Badge>
                  </div>
                  <p className="mt-2 text-sm leading-5 text-muted-foreground">
                    Generated copy is being checked against this profile.
                  </p>
                </div>
              ) : (
                <GovernanceEmpty>
                  No brand voice profile yet—generated copy is not being checked
                  against one.
                </GovernanceEmpty>
              )}
              <BrandVoicePanel
                read={voice.data}
                canEdit={canAdmin}
                queryKey={voiceKey}
              />
            </>
          )}
        </GovernanceSection>
      </div>

      <GovernanceSection
        icon={RadioTower}
        title="Zero-copy triggers"
        description="Configured triggers that can act without generating new copy."
      >
        {triggers.isPending ? (
          <GovernanceLoading label="Loading zero-copy triggers…" />
        ) : triggers.isError ? (
          <GovernanceError
            message="Could not load zero-copy triggers. No zero has been inferred from the failed request."
            retrying={triggers.isFetching}
            onRetry={() => void triggers.refetch()}
          />
        ) : triggerRows.length === 0 ? (
          <GovernanceEmpty>No zero-copy triggers configured.</GovernanceEmpty>
        ) : (
          <GovernanceMetrics
            columns={2}
            items={[
              {
                label: "Configured triggers",
                value: triggerRows.length.toLocaleString(),
                detail: "Returned by the current workspace read",
              },
              {
                label: "Configuration state",
                value: "Present",
                detail:
                  "Inspect trigger administration before changing delivery",
              },
            ]}
          />
        )}
      </GovernanceSection>
    </PageShell>
  );
}
