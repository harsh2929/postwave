// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Data controls — PII scanning, profile transforms, import templates.
 *
 * Five paths desktop reached and web did not.
 *
 * THREE CAPABILITY STATES, THREE DIFFERENT ANSWERS. `pii-scan-config` reports
 * `available` (the scanner exists), `scan_enabled` (it is on here) and
 * `scheduled_scans_available` (scheduled runs are offered at all). "Off" is a
 * setting somebody can change; "not offered" is a limitation they cannot. A
 * single enabled/disabled badge would tell them to go looking for a switch
 * that is not there.
 *
 * The detector and policy versions are shown alongside, because "PII scanning
 * is on" says nothing about WHICH detector decided what counts as personal
 * data — and that is the part an auditor asks about.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ScanSearch,
  Upload,
  Webhook,
  Workflow,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import {
  ADMIN_READ_ONLY_MESSAGE,
  adminReadIdentityParts,
  canReadAdminData,
} from "@/lib/admin-read-authority";
import {
  getPiiScanConfig,
  listImportTemplates,
  listInboundWebhooks,
  listProfileTransformRules,
} from "@/lib/data-controls-api";
import { base, STALE } from "@/lib/query-keys";
import { absoluteTime } from "@/lib/relative-time";

const TRANSFORM_LABELS: Record<string, string> = {
  copy: "Copy",
  lowercase: "Lowercase",
  uppercase: "Uppercase",
  trim: "Trim",
  date: "Date",
  number: "Number",
  boolean: "Boolean",
  json_path: "JSON path",
};

function humanize(value: string | null): string {
  if (!value) return "Not reported";
  return value
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function mappingDetail(mapping: Record<string, unknown> | null): string {
  if (!mapping) return "Mapping detail not reported";
  if (Array.isArray(mapping.columns)) {
    return `${mapping.columns.length.toLocaleString()} mapped column${mapping.columns.length === 1 ? "" : "s"}`;
  }
  const entries = Object.keys(mapping).length;
  return entries > 0
    ? `${entries.toLocaleString()} mapping entr${entries === 1 ? "y" : "ies"}`
    : "Empty mapping";
}

export default function DataControlsPage() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["whoami"],
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const effectiveRole = identity ? effectiveAuthRole(identity) : null;
  const canAdmin = meQuery.isSuccess && canReadAdminData(identity);
  const [tenantId, userId, , viewerState] = adminReadIdentityParts(identity);
  const keyBase = useMemo(
    () =>
      [
        ...base("data-controls", tenantId, effectiveRole),
        userId,
        viewerState,
      ] as const,
    [effectiveRole, tenantId, userId, viewerState],
  );
  const adminKeyBase = useMemo(
    () => [...keyBase, "admin-protected"] as const,
    [keyBase],
  );
  const previousAdminKeyRef = useRef<readonly unknown[] | null>(null);

  const pii = useQuery({
    queryKey: [...adminKeyBase, "pii"],
    queryFn: getPiiScanConfig,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.reference,
  });
  const transforms = useQuery({
    queryKey: [...keyBase, "transforms"],
    queryFn: listProfileTransformRules,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const templates = useQuery({
    queryKey: [...keyBase, "templates"],
    queryFn: listImportTemplates,
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const hooks = useQuery({
    queryKey: [...adminKeyBase, "inbound-webhooks"],
    queryFn: listInboundWebhooks,
    enabled: meQuery.isSuccess && canAdmin,
    staleTime: STALE.list,
  });

  const p = pii.data;
  const transformRows = Array.isArray(transforms.data) ? transforms.data : [];
  const templateRows = Array.isArray(templates.data) ? templates.data : [];
  const hookRows = Array.isArray(hooks.data) ? hooks.data : [];
  const refreshing =
    meQuery.isFetching ||
    pii.isFetching ||
    transforms.isFetching ||
    templates.isFetching ||
    hooks.isFetching;

  useEffect(() => {
    const previous = previousAdminKeyRef.current;
    if (previous && previous !== adminKeyBase) {
      void queryClient.cancelQueries({ queryKey: previous });
      queryClient.removeQueries({ queryKey: previous });
    }
    previousAdminKeyRef.current = adminKeyBase;
    if (meQuery.isPending || (meQuery.isSuccess && canAdmin)) return;
    void queryClient.cancelQueries({ queryKey: adminKeyBase });
    queryClient.removeQueries({ queryKey: adminKeyBase });
  }, [
    adminKeyBase,
    canAdmin,
    meQuery.isPending,
    meQuery.isSuccess,
    queryClient,
  ]);

  return (
    <PageShell className="max-w-5xl [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9">
      <GovernancePageHeader
        icon={ScanSearch}
        title="Data controls"
        description="How subscriber data is inspected, reshaped, and accepted on the way into this workspace."
        refreshLabel="Refresh controls"
        refreshing={refreshing}
        onRefresh={() => {
          if (canAdmin) void pii.refetch();
          void transforms.refetch();
          void templates.refetch();
          if (canAdmin) void hooks.refetch();
        }}
      />

      <GovernanceSection
        icon={ScanSearch}
        title="PII scanning"
        description="Availability, workspace state, and scheduled-scan support are different capabilities."
      >
        {meQuery.isPending ? (
          <GovernanceLoading label="Verifying workspace authority…" rows={3} />
        ) : !canAdmin ? (
          <p className="text-sm text-muted-foreground" role="status">
            {meQuery.isError
              ? "Workspace identity could not be verified. No PII configuration request was made."
              : `${ADMIN_READ_ONLY_MESSAGE} PII scanning configuration was not fetched.`}
          </p>
        ) : pii.isPending ? (
          <GovernanceLoading label="Loading PII scan configuration…" rows={3} />
        ) : pii.isError ? (
          <GovernanceError
            message="Could not read the PII scan configuration. Nothing here should be read as scanning being active."
            retrying={pii.isFetching}
            onRetry={() => void pii.refetch()}
          />
        ) : p ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant={p.available ? "success" : "outline"}>
                {p.available ? "Scanner available" : "Scanner unavailable"}
              </Badge>
              <Badge variant={p.scan_enabled ? "success" : "warning"}>
                {p.scan_enabled ? "Scanning on" : "Scanning off"}
              </Badge>
              <Badge variant={p.scheduled_scans_available ? "info" : "outline"}>
                {p.scheduled_scans_available
                  ? "Scheduled scans offered"
                  : "No scheduled scans"}
              </Badge>
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              {!p.available
                ? "PII scanning is not available in this build."
                : p.scan_enabled
                  ? "PII scanning is active for this workspace."
                  : "PII scanning exists in this build but is switched off for this workspace."}
              {p.available && !p.scheduled_scans_available
                ? " Scheduled runs are not offered on this deployment, so scanning happens only as part of a write."
                : ""}
            </p>
            <GovernanceMetrics
              items={[
                {
                  label: "Runtime status",
                  value: p.status.replace(/_/gu, " ") || "Unknown",
                  detail: p.execution_mode
                    ? `Execution mode: ${p.execution_mode.replace(/_/gu, " ")}`
                    : "Execution mode not reported",
                },
                {
                  label: "Detector",
                  value: p.detector_name || "Not reported",
                  detail: p.detector_version
                    ? `Version ${p.detector_version}`
                    : "Version not reported",
                },
                {
                  label: "Policy",
                  value: p.policy_name || "Not reported",
                  detail: p.policy_version
                    ? `Version ${p.policy_version}`
                    : "Version not reported",
                },
              ]}
            />
            {p.scanner_name ? (
              <p className="mt-3 break-all font-mono text-xs leading-5 text-muted-foreground">
                Scanner {p.scanner_name}
                {p.scanner_version ? ` ${p.scanner_version}` : ""}
              </p>
            ) : null}
          </>
        ) : (
          <GovernanceEmpty>
            No PII scan configuration was reported.
          </GovernanceEmpty>
        )}
      </GovernanceSection>

      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <GovernanceSection
          icon={Workflow}
          title="Profile transforms"
          description="Rules that reshape incoming profile data."
        >
          {transforms.isPending ? (
            <GovernanceLoading label="Loading profile transform rules…" />
          ) : transforms.isError ? (
            <GovernanceError
              message="Could not load transform rules. Their state is unknown."
              retrying={transforms.isFetching}
              onRetry={() => void transforms.refetch()}
            />
          ) : transformRows.length === 0 ? (
            <GovernanceEmpty>
              No transform rules—incoming profile data is stored as received.
            </GovernanceEmpty>
          ) : (
            <div className="space-y-3">
              <GovernanceMetrics
                columns={2}
                items={[
                  {
                    label: "Active definitions",
                    value: transformRows.length.toLocaleString(),
                    detail: "All rules returned by this workspace read",
                  },
                ]}
              />
              <ul
                className="divide-y rounded-xl border"
                aria-label="Profile transform rules"
              >
                {transformRows.map((rule) => (
                  <li key={rule.id} className="min-w-0 space-y-2 p-3.5">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 break-words text-sm font-semibold">
                        {rule.name ?? "Unnamed transform rule"}
                      </p>
                      <Badge
                        variant={
                          rule.status === "active"
                            ? "success"
                            : rule.status === "paused"
                              ? "warning"
                              : "outline"
                        }
                      >
                        {humanize(rule.status)}
                      </Badge>
                      <Badge variant="secondary">
                        {rule.transform
                          ? (TRANSFORM_LABELS[rule.transform] ??
                            humanize(rule.transform))
                          : "Transform not reported"}
                      </Badge>
                    </div>
                    <p className="min-w-0 break-all font-mono text-xs leading-5 text-muted-foreground">
                      {rule.source_path ?? "Source not reported"}
                      <span className="mx-2" aria-hidden="true">
                        →
                      </span>
                      {rule.target_key
                        ? `custom_fields.${rule.target_key}`
                        : "Target not reported"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </GovernanceSection>

        <GovernanceSection
          icon={Upload}
          title="Import templates"
          description="Reusable mappings for subscriber imports."
        >
          {templates.isPending ? (
            <GovernanceLoading label="Loading import templates…" />
          ) : templates.isError ? (
            <GovernanceError
              message="Could not load import templates. This is a failed request, not an empty result."
              retrying={templates.isFetching}
              onRetry={() => void templates.refetch()}
            />
          ) : templateRows.length === 0 ? (
            <GovernanceEmpty>No import templates configured.</GovernanceEmpty>
          ) : (
            <div className="space-y-3">
              <GovernanceMetrics
                columns={2}
                items={[
                  {
                    label: "Templates",
                    value: templateRows.length.toLocaleString(),
                    detail: "Reusable import definitions",
                  },
                ]}
              />
              <ul
                className="divide-y rounded-xl border"
                aria-label="Subscriber import templates"
              >
                {templateRows.map((template) => {
                  const updated = template.updated_at
                    ? absoluteTime(template.updated_at)
                    : "";
                  return (
                    <li key={template.id} className="min-w-0 space-y-1.5 p-3.5">
                      <p className="break-words text-sm font-semibold">
                        {template.name ?? "Unnamed import template"}
                      </p>
                      <p className="break-words text-xs leading-5 text-muted-foreground">
                        {template.source_hint
                          ? `Source: ${template.source_hint}`
                          : "Source hint not reported"}
                        {` · ${mappingDetail(template.mapping)}`}
                      </p>
                      <p className="break-words text-xs leading-5 text-muted-foreground">
                        {updated
                          ? `Updated ${updated}`
                          : "Update time not reported"}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </GovernanceSection>

        <GovernanceSection
          className="lg:col-span-2"
          icon={Webhook}
          title="Inbound webhooks"
          description="Endpoints that can write data into this workspace."
        >
          {meQuery.isPending ? (
            <GovernanceLoading label="Verifying workspace authority…" />
          ) : !canAdmin ? (
            <p className="text-sm text-muted-foreground" role="status">
              {meQuery.isError
                ? "Workspace identity could not be verified. No inbound-webhook request was made."
                : `${ADMIN_READ_ONLY_MESSAGE} Inbound webhook configuration was not fetched.`}
            </p>
          ) : hooks.isPending ? (
            <GovernanceLoading label="Loading inbound webhooks…" />
          ) : hooks.isError ? (
            <GovernanceError
              message="Could not load inbound webhooks. This is a failed request, not an empty result."
              retrying={hooks.isFetching}
              onRetry={() => void hooks.refetch()}
            />
          ) : hookRows.length === 0 ? (
            <GovernanceEmpty>No inbound webhooks configured.</GovernanceEmpty>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <GovernanceMetrics
                  columns={2}
                  items={[
                    {
                      label: "Webhooks",
                      value: hookRows.length.toLocaleString(),
                      detail: "Inbound write endpoints",
                    },
                  ]}
                />
                <Button asChild variant="outline" className="shrink-0">
                  <Link href="/app/inbound-webhooks">
                    Manage endpoints
                    <ArrowRight aria-hidden="true" />
                  </Link>
                </Button>
              </div>
              <ul
                className="divide-y rounded-xl border"
                aria-label="Inbound webhooks"
              >
                {hookRows.map((hook) => {
                  const created = hook.created_at
                    ? absoluteTime(hook.created_at)
                    : "";
                  return (
                    <li
                      key={hook.id}
                      className="flex min-w-0 flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="break-words text-sm font-semibold">
                          {hook.name ?? "Unnamed inbound webhook"}
                        </p>
                        <p className="mt-1 min-w-0 break-all font-mono text-xs leading-5 text-muted-foreground">
                          {hook.slug
                            ? `/api/public/inbound/${hook.slug}`
                            : "Endpoint slug not reported"}
                        </p>
                        {created ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Created {created}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={
                            hook.enabled === true
                              ? "success"
                              : hook.enabled === false
                                ? "outline"
                                : "warning"
                          }
                        >
                          {hook.enabled === true
                            ? "Enabled"
                            : hook.enabled === false
                              ? "Disabled"
                              : "Status not reported"}
                        </Badge>
                        <Button asChild size="sm" variant="ghost">
                          <Link
                            href={`/app/inbound-webhooks/${encodeURIComponent(hook.id)}`}
                          >
                            View
                          </Link>
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </GovernanceSection>
      </div>
    </PageShell>
  );
}
