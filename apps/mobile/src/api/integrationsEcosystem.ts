/**
 * api/integrationsEcosystem.ts — the three ecosystem-level integration reports.
 *
 *   GET /api/v1/integrations/coverage   (handlers.go:193 mount, :238 handler)
 *   GET /api/v1/integrations/readiness  (handlers.go:195 mount, :248 handler)
 *   GET /api/v1/integrations/stacks     (handlers.go:194 mount, :243 handler)
 *
 * ROLE. All three record `session_minimum_role: "admin"` in the generated
 * manifest with `policy_source: "family:admin"` and `review_status:
 * "reviewed"`; the mount guard is `RequireScope(ScopeReadReports)`. The hooks
 * gate on admin — the reviewed value — so a viewer never trades a request for
 * a 403 that would then render as "coverage is empty".
 *
 * NO PARAMETERS. None of the three handlers reads the query string; each
 * recomputes its report from `catalogItemsForHTTPRequest` + `AllRecipesForItems`
 * on every call. That also means the reports are release-scoped rather than
 * tenant-scoped beyond the release holds the catalog itself applies, which is
 * why the hooks cache them for an hour.
 */
import {
  normalizeCoverageReport,
  normalizeReadinessReport,
  normalizeStackReport,
  type CoverageView,
  type ReadinessView,
  type StacksView,
} from "@/lib/integrationsEcosystem";

import { checkedApiResult, rawRequest } from "./request";

export const INTEGRATIONS_COVERAGE_PATH = "/api/v1/integrations/coverage";
export const INTEGRATIONS_READINESS_PATH = "/api/v1/integrations/readiness";
export const INTEGRATIONS_STACKS_PATH = "/api/v1/integrations/stacks";

export async function fetchIntegrationsCoverage(): Promise<CoverageView> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", INTEGRATIONS_COVERAGE_PATH),
  );
  return normalizeCoverageReport(res.data);
}

export async function fetchIntegrationsReadiness(): Promise<ReadinessView> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", INTEGRATIONS_READINESS_PATH),
  );
  return normalizeReadinessReport(res.data);
}

export async function fetchIntegrationsStacks(): Promise<StacksView> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", INTEGRATIONS_STACKS_PATH),
  );
  return normalizeStackReport(res.data);
}
