/**
 * api/campaignMeasure.ts — holdout, content-optimizer and remix transport.
 *
 * Routes re-verified 2026-08-28:
 *   POST/DELETE /api/v1/campaigns/{id}/holdout — handler binds ScopeAdmin
 *        (holdout.go:103-106), so the session path admits owner/admin only;
 *        the UI gates on canAdmin for that reason, whatever the manifest's
 *        editor floor says.
 *   GET  /api/v1/campaigns/{id}/content-optimizer          viewer (404 = none)
 *   POST /api/v1/campaigns/{id}/content-optimizer/preview  editor
 *        (the PERSISTED run route exists but is deliberately not called —
 *        desktop's ContentOptimizerCard disables it because dispatch does not
 *        consume runs yet; see lib/campaignOptimizer.)
 *   POST /api/v1/campaigns/{id}/remix                      editor
 */
import { rawRequest, type AIApiResult } from "./request";

function campaignPath(campaignId: string, suffix: string): string {
  return `/api/v1/campaigns/${encodeURIComponent(campaignId)}${suffix}`;
}

/** POST …/holdout — configure the measurement before the send. */
export async function createCampaignHoldout(
  campaignId: string,
  percent: number,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", campaignPath(campaignId, "/holdout"), {
    percent,
  });
}

/** DELETE …/holdout — remove it (everyone receives the send). */
export async function deleteCampaignHoldout(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("DELETE", campaignPath(campaignId, "/holdout"));
}

/** GET …/holdout — the configured holdout, if any (404 = none). */
export async function getCampaignHoldout(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("GET", campaignPath(campaignId, "/holdout"));
}

/** GET …/content-optimizer — the latest persisted run (404 = none yet). */
export async function getContentOptimizerRun(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "GET",
    campaignPath(campaignId, "/content-optimizer"),
  );
}

/**
 * POST …/content-optimizer/preview — bandit allocation preview, nothing
 * persisted. An empty body asks the server to derive arms (A/B variants when
 * present, a control arm otherwise) — mirroring desktop.
 */
export async function previewContentOptimizer(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>(
    "POST",
    campaignPath(campaignId, "/content-optimizer/preview"),
    {},
  );
}

/** POST …/remix — derive cross-channel assets from the body. Synchronous. */
export async function remixCampaignContent(
  campaignId: string,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("POST", campaignPath(campaignId, "/remix"), {});
}
