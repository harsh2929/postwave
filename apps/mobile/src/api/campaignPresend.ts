/**
 * api/campaignPresend.ts — transport for the pre-send check services.
 *
 * Routes re-verified against the routeauth manifest + mounts 2026-08-28:
 *
 *   POST /api/v1/email-preview/render   admin  (tenant_governance.go:91)
 *   ANY  /api/v1/render                 admin  (deliverability proxy; paid +
 *        slow — only ever called from an explicit press)
 *   POST /api/v1/a11y/check             admin  (reporting_compliance_tools.go)
 *   POST /api/v1/presend/verdict        editor (presend/verdict.go:116)
 *   GET/POST/DELETE /api/v1/campaigns/{id}/presend-refine
 *        viewer / editor / editor       (subscribers/presend_refine.go:287)
 *
 * Every function resolves the {data,error} envelope from rawRequest and is
 * consumed through the parsers in src/lib — never handed to one raw.
 */
import { rawRequest, type AIApiResult } from "./request";

/** POST /api/v1/email-preview/render — the body field is legal `mjml`. */
export async function renderEmailPreview(input: {
  mjml: string;
  vars?: Record<string, string>;
}): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/email-preview/render", {
    mjml: input.mjml,
    ...(input.vars ? { vars: input.vars } : {}),
  });
}

/** POST /api/v1/render — 10-environment screenshot matrix. */
export async function renderAcrossClients(
  html: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/render", { html });
}

/** POST /api/v1/a11y/check */
export async function runA11yCheck(input: {
  html: string;
  subject?: string;
}): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/a11y/check", {
    html: input.html,
    ...(input.subject ? { subject: input.subject } : {}),
  });
}

/** POST /api/v1/presend/verdict — LLM-cost; on demand only. */
export async function requestPresendVerdict(input: {
  subject: string;
  html: string;
  from: string;
  campaignId: string;
  voiceProfileId?: string;
}): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", "/api/v1/presend/verdict", {
    subject: input.subject,
    html: input.html,
    from: input.from,
    campaign_id: input.campaignId,
    ...(input.voiceProfileId
      ? { voice_profile_id: input.voiceProfileId }
      : {}),
  });
}

function refinePath(campaignId: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/presend-refine`;
}

/** GET — the currently active exclusion set (viewer). */
export async function getPresendRefine(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("GET", refinePath(campaignId));
}

/** POST — dry_run previews; without it, commits the exclusion set. */
export async function postPresendRefine(
  campaignId: string,
  input: { churnThreshold: number; dryRun: boolean },
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", refinePath(campaignId), {
    churn_threshold: input.churnThreshold,
    dry_run: input.dryRun,
  });
}

/** DELETE — clear the exclusion set (everyone re-enters). */
export async function clearPresendRefine(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("DELETE", refinePath(campaignId));
}
