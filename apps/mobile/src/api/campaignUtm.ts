/**
 * api/campaignUtm.ts — transport for campaign link tagging.
 *
 * Routes read off `MountRoutes` in apps/api/internal/utm_tagging/utm_tagging.go
 * (:130-139) and their handlers, NOT off openapi.json:
 *
 *   GET  /api/v1/utm-templates            read:reports → { templates, count }
 *   POST /api/v1/utm-templates/preview    read:reports
 *        { url, campaign_id } → { original, rewritten, template }
 *   POST /api/v1/utm-templates/campaign/{id}   ADMIN
 *        { utm_source, utm_medium, utm_campaign, utm_term, utm_content }
 *
 * THE SCOPE SPLIT MATTERS AND IS ASYMMETRIC. `read:reports` is in
 * `readOnlyScopes` (apikeys/middleware.go:332), so listing and previewing are
 * open to every authenticated dashboard user. The upsert is `ScopeAdmin`,
 * which is NOT in that set — `requireAdminRoleForScopes` therefore demands
 * owner|admin, and an EDITOR who can otherwise change this campaign cannot
 * change its tagging. The card gates on `canAdmin` for exactly that reason,
 * rather than letting an editor discover it as a 403.
 */
import {
  parseUtmTemplates,
  type UtmTemplate,
} from "@/lib/campaignUtm";

import { checkedApiResult, rawRequest } from "./request";

/** GET /api/v1/utm-templates */
export async function listUtmTemplates(): Promise<UtmTemplate[]> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", "/api/v1/utm-templates"),
  );
  return parseUtmTemplates(res.data);
}

export interface UtmPreview {
  original: string;
  rewritten: string;
}

/** POST /api/v1/utm-templates/preview */
export async function previewUtmLink(
  url: string,
  campaignId: string,
): Promise<UtmPreview> {
  const res = await checkedApiResult(
    rawRequest<{ original?: unknown; rewritten?: unknown }>(
      "POST",
      "/api/v1/utm-templates/preview",
      { url, campaign_id: campaignId },
    ),
  );
  const body = res.data;
  return {
    original: typeof body?.original === "string" ? body.original : url,
    // Falls back to the ORIGINAL, never to an empty string: a preview panel
    // showing a blank "tagged link" would read as "this link gets destroyed".
    rewritten:
      typeof body?.rewritten === "string" && body.rewritten.length > 0
        ? body.rewritten
        : url,
  };
}

/** POST /api/v1/utm-templates/campaign/{id} — admin only. */
export async function upsertCampaignUtm(
  campaignId: string,
  body: Record<string, string>,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `/api/v1/utm-templates/campaign/${encodeURIComponent(campaignId)}`,
      body,
    ),
  );
}

/**
 * POST /api/v1/utm-templates — UpsertDefault (utm_tagging.go:135). Sets the
 * WORKSPACE-WIDE default row (campaign_id ""). ScopeAdmin at the mount, same
 * asymmetry as the per-campaign upsert: the card gates on canAdmin.
 */
export async function upsertDefaultUtm(
  body: Record<string, string>,
): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>("POST", "/api/v1/utm-templates", body),
  );
}

/**
 * DELETE /api/v1/utm-templates/{id} — removes one template row (the default,
 * or a campaign override). ScopeAdmin at the mount (utm_tagging.go:137).
 */
export async function deleteUtmTemplate(id: string): Promise<void> {
  await checkedApiResult(
    rawRequest<unknown>(
      "DELETE",
      `/api/v1/utm-templates/${encodeURIComponent(id)}`,
    ),
  );
}
