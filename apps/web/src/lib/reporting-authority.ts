// SPDX-License-Identifier: AGPL-3.0-only

import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import type {
  ReportDefinition,
  ReportMetricSpec,
  ReportRequest,
  ReportRun,
} from "@/lib/reporting-api";

export type ReportingResource = "metric-registry" | "definitions" | "runs";

export function reportingIdentityKey(identity: MeResponse | null | undefined) {
  if (!identity) return "unresolved";
  return [
    identity.tenant_id,
    identity.user_id,
    effectiveAuthRole(identity),
    identity.viewer_mode === true ? "viewer-mode" : "member-mode",
  ].join("\u001f");
}

export function reportingQueryKey(
  resource: ReportingResource,
  identity: MeResponse | null | undefined,
) {
  return ["reporting", reportingIdentityKey(identity), resource] as const;
}

export function sameReportingIdentity(
  opened: MeResponse,
  candidate: MeResponse,
): boolean {
  return (
    opened.tenant_id === candidate.tenant_id &&
    opened.user_id === candidate.user_id &&
    effectiveAuthRole(opened) === effectiveAuthRole(candidate) &&
    Boolean(opened.viewer_mode) === Boolean(candidate.viewer_mode)
  );
}

/** Fresh identity check for the read-scoped, potentially expensive preview. */
export async function verifyFreshReportingReadAuthority(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  const fresh = await whoamiFresh(signal);
  if (!sameReportingIdentity(opened, fresh)) {
    throw new Error(
      "Workspace identity or authority changed. Nothing was confirmed in this view.",
    );
  }
  return fresh;
}

export async function verifyFreshReportingAdminAuthority(
  opened: MeResponse,
  signal?: AbortSignal,
): Promise<MeResponse> {
  return verifyFreshAdminAuthority(opened, signal);
}

/** JSON wire clone: the exact body and its fingerprint cannot drift mid-flight. */
export function freezeReportRequest(request: ReportRequest): ReportRequest {
  return JSON.parse(JSON.stringify(request)) as ReportRequest;
}

export function reportRequestFingerprint(request: ReportRequest): string {
  return JSON.stringify(request);
}

function sameMetric(left: ReportMetricSpec, right: ReportMetricSpec): boolean {
  return (
    left.key === right.key &&
    (left.alias ?? "") === (right.alias ?? "") &&
    (left.aggregation ?? "") === (right.aggregation ?? "")
  );
}

export function definitionConfirmsRequest(
  definition: ReportDefinition,
  request: ReportRequest,
): boolean {
  if ((definition.name ?? "").trim() !== (request.name ?? "").trim()) {
    return false;
  }
  if (definition.metrics.length !== request.metrics.length) return false;
  return definition.metrics.every((metric, index) =>
    sameMetric(metric, request.metrics[index]!),
  );
}

export function runConfirmsDefinition(
  run: ReportRun,
  definitionId: string,
): boolean {
  return run.id.trim() !== "" && run.definition_id === definitionId;
}

export function reportDefinitionFingerprint(
  definition: ReportDefinition,
): string {
  return JSON.stringify({
    id: definition.id,
    updatedAt: definition.updated_at,
    status: definition.status,
    metrics: definition.metrics,
    dimensions: definition.dimensions,
    filters: definition.filters,
    timeRange: definition.time_range,
    visualization: definition.visualization,
  });
}
