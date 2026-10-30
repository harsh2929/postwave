// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  Database,
  Gauge,
  Globe2,
  RefreshCw,
  ShieldCheck,
  ThermometerSun,
} from "lucide-react";

import {
  OperationsFailure,
  OperationsHeader,
  OperationsLoading,
  OperationsSection,
  OperationsShell,
} from "@/components/operations/operations-surface";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { formatWireTimestamp } from "@/lib/go-zero-time";
import { base, qk, STALE } from "@/lib/query-keys";
import {
  dmarcHasNoReports,
  getDmarcReports,
  getDnsHealthIssues,
  getEmailBlockCatalog,
  getEngagementDistribution,
  getExportRetention,
  listWarmupPlans,
} from "@/lib/workspace-ops-api";

const ROW_CAP = 8;

// The score browser (which carries the subscriber directory client) and the
// feature-flag registry render below the evidence sections and only once their
// own reads settle; splitting them keeps the page under the dashboard bundle
// budget without changing what operators see.
const ScoreDistributionBrowser = dynamic(
  () =>
    import("@/components/subscribers/ScoreDistributionBrowser").then(
      (module) => module.ScoreDistributionBrowser,
    ),
  {
    loading: () => (
      <div className="mt-4 space-y-3 border-t pt-4">
        <OperationsLoading label="Loading score browser" rows={1} />
      </div>
    ),
  },
);

const FeatureFlagsManager = dynamic(
  () =>
    import("./feature-flags-manager").then(
      (module) => module.FeatureFlagsManager,
    ),
  {
    loading: () => (
      <div className="lg:col-span-2">
        <OperationsLoading label="Loading feature flags" rows={3} />
      </div>
    ),
  },
);

export default function WorkspaceOpsPage() {
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const effectiveRole = meQuery.data ? effectiveAuthRole(meQuery.data) : null;
  const identityKey = useMemo(
    () =>
      base("workspace-ops", meQuery.data?.tenant_id ?? "anon", effectiveRole),
    [effectiveRole, meQuery.data?.tenant_id],
  );
  const enabled = meQuery.isSuccess;

  const retention = useQuery({
    queryKey: [...identityKey, "retention"],
    queryFn: getExportRetention,
    enabled,
    staleTime: STALE.reference,
    retry: false,
  });
  const blocks = useQuery({
    queryKey: [...identityKey, "email-blocks"],
    queryFn: getEmailBlockCatalog,
    enabled,
    staleTime: STALE.reference,
    retry: false,
  });
  const dns = useQuery({
    queryKey: [...identityKey, "dns-health"],
    queryFn: getDnsHealthIssues,
    enabled,
    staleTime: STALE.list,
    retry: false,
  });
  const warmup = useQuery({
    queryKey: [...identityKey, "warmup"],
    queryFn: listWarmupPlans,
    enabled,
    staleTime: STALE.list,
    retry: false,
  });
  const engagement = useQuery({
    queryKey: [...identityKey, "engagement"],
    queryFn: getEngagementDistribution,
    enabled,
    staleTime: STALE.list,
    retry: false,
  });
  const dmarc = useQuery({
    queryKey: [...identityKey, "dmarc"],
    queryFn: getDmarcReports,
    enabled,
    staleTime: STALE.list,
    retry: false,
  });

  const anyFetching =
    retention.isFetching ||
    blocks.isFetching ||
    dns.isFetching ||
    warmup.isFetching ||
    engagement.isFetching ||
    dmarc.isFetching;

  const refreshAll = () => {
    void Promise.all([
      retention.refetch(),
      blocks.refetch(),
      dns.refetch(),
      warmup.refetch(),
      engagement.refetch(),
      dmarc.refetch(),
    ]);
  };

  return (
    <OperationsShell className="max-w-6xl">
      <OperationsHeader
        icon={Database}
        eyebrow="Workspace · Evidence"
        title="Workspace operations"
        description="Inspect independent retention, deliverability, warm-up, engagement, template-block, and feature-flag evidence. A failure in one source does not erase the others."
        actions={
          meQuery.isSuccess ? (
            <Button
              type="button"
              variant="outline"
              onClick={refreshAll}
              disabled={anyFetching}
            >
              <RefreshCw
                aria-hidden
                className={anyFetching ? "animate-spin" : undefined}
              />
              Refresh evidence
            </Button>
          ) : null
        }
      />

      {meQuery.isPending ? (
        <OperationsLoading label="Verifying workspace identity" rows={2} />
      ) : meQuery.isError ? (
        <OperationsFailure
          title="Workspace identity could not be verified"
          description="No workspace-operations evidence was requested."
          onRetry={() => void meQuery.refetch()}
          retrying={meQuery.isFetching}
        />
      ) : (
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <OperationsSection
            id="wo-retention"
            title="Export retention"
            description="This is a deletion deadline, not a promise that old download links remain available."
            aside={<SectionIcon icon={Database} />}
          >
            {retention.isPending ? (
              <OperationsLoading label="Loading export retention" rows={2} />
            ) : retention.isError || !retention.data ? (
              <OperationsFailure
                description={sectionError(
                  retention.error,
                  "export retention policy",
                )}
                onRetry={() => void retention.refetch()}
                retrying={retention.isFetching}
              />
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Metric
                    label="New export expiry"
                    value={`${retention.data.retention_days} days`}
                  />
                  <Metric
                    label="Active export cap"
                    value={`${retention.data.max_per_tenant} exports`}
                  />
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Newly completed exports receive an expiry deadline{" "}
                  {retention.data.retention_days} days later; existing exports
                  keep the deadline assigned when they completed. Queued,
                  running, and unexpired ready exports reserve the{" "}
                  {retention.data.max_per_tenant}-export cap. Current ready
                  storage is {formatBytes(retention.data.current_storage_bytes)}
                  .
                </p>
                {retention.data.updated_at ? (
                  <p className="text-xs text-muted-foreground">
                    Policy updated{" "}
                    {formatWireTimestamp(retention.data.updated_at, "unknown")}
                  </p>
                ) : null}
              </div>
            )}
          </OperationsSection>

          <OperationsSection
            id="wo-dmarc"
            title="DMARC aggregate reports"
            description="Stored receiver reports are separate from the sending-identity DNS checks below."
            aside={<SectionIcon icon={Globe2} />}
          >
            {dmarc.isPending ? (
              <OperationsLoading label="Loading DMARC reports" rows={3} />
            ) : dmarc.isError || !dmarc.data ? (
              <OperationsFailure
                description={sectionError(dmarc.error, "DMARC reports")}
                onRetry={() => void dmarc.refetch()}
                retrying={dmarc.isFetching}
              />
            ) : dmarcHasNoReports(dmarc.data) ? (
              <Alert>
                <AlertTitle>No aggregate reports are stored yet</AlertTitle>
                <AlertDescription>
                  This alone proves neither that DMARC publication is absent nor
                  that delivery is healthy. Use DNS health to inspect configured
                  sending identities; receivers may also take time to send their
                  first aggregate report.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {dmarc.data.totalReports.toLocaleString()} stored report
                  {dmarc.data.totalReports === 1 ? "" : "s"} across{" "}
                  {dmarc.data.availableDomains.length.toLocaleString()} report
                  domain{dmarc.data.availableDomains.length === 1 ? "" : "s"}.
                  {dmarc.data.hasMore
                    ? " More exist beyond this response."
                    : ""}
                </p>
                <ul className="space-y-2">
                  {dmarc.data.items.slice(0, 5).map((report) => (
                    <li
                      key={report.id}
                      className="min-w-0 rounded-lg border p-3 text-sm"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-all font-medium">
                            {report.domain}
                          </p>
                          <p className="break-words text-xs text-muted-foreground">
                            {report.orgName} · policy {report.policyP}
                          </p>
                        </div>
                        <div className="shrink-0 text-xs text-muted-foreground">
                          {report.passCount.toLocaleString()} pass ·{" "}
                          {report.failCount.toLocaleString()} fail
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <ShowingNote
                  shown={Math.min(5, dmarc.data.items.length)}
                  total={dmarc.data.totalReports}
                  noun="report"
                />
              </div>
            )}
          </OperationsSection>

          <OperationsSection
            id="wo-dns"
            title="DNS health issues"
            description="Only non-verified sending identities appear in this endpoint."
            aside={<SectionIcon icon={ShieldCheck} />}
          >
            {dns.isPending ? (
              <OperationsLoading label="Loading DNS health" rows={3} />
            ) : dns.isError ? (
              <OperationsFailure
                description={sectionError(dns.error, "DNS health")}
                onRetry={() => void dns.refetch()}
                retrying={dns.isFetching}
              />
            ) : dns.data.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No configured sending identity has an outstanding DNS issue in
                this response.
              </p>
            ) : (
              <div className="space-y-3">
                <ul className="space-y-2">
                  {dns.data.slice(0, ROW_CAP).map((identity) => (
                    <li key={identity.id} className="rounded-lg border p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <p className="break-all text-sm font-medium">
                          {identity.domain}
                        </p>
                        <Badge
                          variant={
                            identity.verifyState === "broken"
                              ? "destructive"
                              : "warning"
                          }
                        >
                          {humanize(identity.verifyState)}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        SPF {identity.spfVerifiedAt ? "verified" : "missing"} ·
                        DKIM {identity.dkimVerifiedAt ? "verified" : "missing"}
                        {" · "}DMARC{" "}
                        {identity.dmarcVerifiedAt ? "verified" : "missing"}
                      </p>
                      {identity.lastError ? (
                        <p className="mt-2 break-words text-xs text-destructive">
                          {identity.lastError}
                        </p>
                      ) : null}
                      {identity.isStale ? (
                        <p className="mt-1 text-xs text-warning-emphasis">
                          Latest check is stale or has never completed.
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <ShowingNote
                  shown={Math.min(ROW_CAP, dns.data.length)}
                  total={dns.data.length}
                  noun="identity"
                />
              </div>
            )}
          </OperationsSection>

          <OperationsSection
            id="wo-warmup"
            title="Domain warm-up plans"
            description="The ramp schedule is automatic; the stored status label is operator-maintained and does not auto-complete when its days elapse."
            aside={<SectionIcon icon={ThermometerSun} />}
          >
            {warmup.isPending ? (
              <OperationsLoading label="Loading warm-up plans" rows={3} />
            ) : warmup.isError ? (
              <OperationsFailure
                description={sectionError(warmup.error, "warm-up plans")}
                onRetry={() => void warmup.refetch()}
                retrying={warmup.isFetching}
              />
            ) : warmup.data.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No domain warm-up plan is recorded for this workspace.
              </p>
            ) : (
              <div className="space-y-3">
                <ul className="space-y-2">
                  {warmup.data.slice(0, ROW_CAP).map((plan) => (
                    <li key={plan.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-all font-medium">{plan.domain}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {plan.days}-day schedule from {plan.startedOn} ·
                            target {plan.targetDaily.toLocaleString()}/day
                          </p>
                        </div>
                        <Badge variant="secondary">
                          label: {humanize(plan.status)}
                        </Badge>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Last observed send count:{" "}
                        {plan.lastSentCount.toLocaleString()}.
                      </p>
                    </li>
                  ))}
                </ul>
                <ShowingNote
                  shown={Math.min(ROW_CAP, warmup.data.length)}
                  total={warmup.data.length}
                  noun="plan"
                />
              </div>
            )}
          </OperationsSection>

          <OperationsSection
            id="wo-engagement"
            title="Engagement distribution"
            description="Only subscribers with a persisted engagement score contribute to these decile buckets."
            aside={<SectionIcon icon={Gauge} />}
          >
            {engagement.isPending ? (
              <OperationsLoading
                label="Loading engagement distribution"
                rows={4}
              />
            ) : engagement.isError ? (
              <OperationsFailure
                description={sectionError(
                  engagement.error,
                  "engagement distribution",
                )}
                onRetry={() => void engagement.refetch()}
                retrying={engagement.isFetching}
              />
            ) : engagement.data.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No scored-subscriber distribution exists yet. Unscored
                subscribers are excluded rather than placed in a zero bucket.
              </p>
            ) : (
              <ul className="space-y-3">
                {engagement.data.map((bucket) => {
                  const maxCount = Math.max(
                    1,
                    ...engagement.data.map((candidate) => candidate.count),
                  );
                  return (
                    <li key={`${bucket.min}:${bucket.max}`} className="text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span>{bucket.range}</span>
                        <span className="text-muted-foreground">
                          {bucket.count.toLocaleString()}
                        </span>
                      </div>
                      <div
                        role="img"
                        aria-label={`${bucket.range}: ${bucket.count} scored subscribers`}
                        className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{
                            width: `${(bucket.count / maxCount) * 100}%`,
                          }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {engagement.data && engagement.data.length > 0 ? (
              <ScoreDistributionBrowser
                buckets={engagement.data}
                queryKeyPrefix={identityKey}
              />
            ) : null}
          </OperationsSection>

          <OperationsSection
            id="wo-blocks"
            title="Email block catalogue"
            description="These are editor building blocks and defaults, not rendered or delivered messages."
            aside={<SectionIcon icon={Blocks} />}
          >
            {blocks.isPending ? (
              <OperationsLoading
                label="Loading email block catalogue"
                rows={4}
              />
            ) : blocks.isError || !blocks.data ? (
              <OperationsFailure
                description={sectionError(
                  blocks.error,
                  "email block catalogue",
                )}
                onRetry={() => void blocks.refetch()}
                retrying={blocks.isFetching}
              />
            ) : blocks.data.blocks.length === 0 ? (
              <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                No editor blocks were returned by this catalogue.
              </p>
            ) : (
              <div className="space-y-3">
                <ul className="grid gap-2 sm:grid-cols-2">
                  {blocks.data.blocks.slice(0, ROW_CAP).map((block) => (
                    <li
                      key={block.id}
                      className="min-w-0 rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="break-words text-sm font-medium">
                          {block.name}
                        </p>
                        <Badge variant="secondary">{block.category}</Badge>
                      </div>
                      <p className="mt-1 break-words text-xs text-muted-foreground">
                        {block.description}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {block.fields.length} configurable field
                        {block.fields.length === 1 ? "" : "s"}
                      </p>
                    </li>
                  ))}
                </ul>
                <ShowingNote
                  shown={Math.min(ROW_CAP, blocks.data.blocks.length)}
                  total={blocks.data.blocks.length}
                  noun="block"
                />
              </div>
            )}
          </OperationsSection>

          <FeatureFlagsManager
            key={`${meQuery.data.tenant_id}:${meQuery.data.user_id}:${effectiveAuthRole(meQuery.data)}:${meQuery.data.viewer_mode ? "viewer" : "member"}`}
            identity={meQuery.data}
          />
        </div>
      )}
    </OperationsShell>
  );
}

function SectionIcon({ icon: Icon }: { icon: typeof Database }) {
  return (
    <span className="inline-flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold">{value}</p>
    </div>
  );
}

function ShowingNote({
  shown,
  total,
  noun,
}: {
  shown: number;
  total: number;
  noun: string;
}) {
  if (total <= shown) return null;
  return (
    <p className="text-xs text-muted-foreground">
      Showing {shown} of {total} {noun}
      {total === 1 ? "" : "s"}.
    </p>
  );
}

function sectionError(error: unknown, label: string): string {
  if (error instanceof ApiError && error.status === 403) {
    return `Owner or admin access is required to load ${label}. Other sections may still be available.`;
  }
  return error instanceof Error
    ? error.message
    : `The ${label} request did not complete.`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
