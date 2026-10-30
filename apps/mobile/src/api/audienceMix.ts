/**
 * api/audienceMix.ts — the three per-campaign audience reads, fanned out over
 * the campaigns the workspace rollup covers.
 *
 *   GET /api/v1/campaigns/{id}/devices      viewer (manifest.json)
 *   GET /api/v1/campaigns/{id}/geography    viewer
 *   GET /api/v1/campaigns/{id}/link-report  viewer
 *
 * All three are already read one campaign at a time by the campaign report
 * screen (hooks/useCampaignInsight). There is no workspace-level equivalent,
 * so — exactly as desktop does — the rollup is N campaigns × 3 reads, summed
 * on the client (apps/api/internal/analytics/handlers.go:193, :435, :457).
 *
 * WHY FAILURES ARE COLLECTED RATHER THAN THROWN. One campaign's geography
 * read failing must not blank the mail-client panel for the other four. Each
 * read resolves to `{rows, failure}` and the caller names what is missing.
 * 404/405/501 means the deployment does not expose that endpoint at all, which
 * is not a failure of this workspace's data — it is reported as an absent
 * PANEL, not as a broken campaign.
 */
import { rawRequest } from "./request";

/**
 * The reads and their sub-resource paths. The human NAMES for them live in
 * lib/audienceMix (with the copy that uses them), so there is one vocabulary.
 */
export const AUDIENCE_MIX_PATHS = {
  devices: "devices",
  geography: "geography",
  links: "link-report",
} as const;

export type AudienceMixRead = keyof typeof AUDIENCE_MIX_PATHS;

export interface AudienceMixCampaignResult {
  campaignId: string;
  /** Raw wire arrays, per read. Parsed by lib/campaignInsights, not here. */
  devices: unknown;
  geography: unknown;
  links: unknown;
  /** Reads that failed for this campaign, as "<label> for <campaign>". */
  failures: { read: AudienceMixRead; status: number }[];
  /** Reads this deployment does not expose (404/405/501). */
  absent: AudienceMixRead[];
}

async function readOne(
  campaignId: string,
  read: AudienceMixRead,
): Promise<{ rows: unknown; status: number | null; absent: boolean }> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/${AUDIENCE_MIX_PATHS[read]}`,
  );
  if (res.error) {
    const status = res.error.status;
    const absent = status === 404 || status === 405 || status === 501;
    return { rows: [], status, absent };
  }
  return { rows: res.data, status: null, absent: false };
}

export async function fetchCampaignAudienceMix(
  campaignId: string,
): Promise<AudienceMixCampaignResult> {
  const [devices, geography, links] = await Promise.all([
    readOne(campaignId, "devices"),
    readOne(campaignId, "geography"),
    readOne(campaignId, "links"),
  ]);
  const failures: { read: AudienceMixRead; status: number }[] = [];
  const absent: AudienceMixRead[] = [];
  const entries: [AudienceMixRead, typeof devices][] = [
    ["devices", devices],
    ["geography", geography],
    ["links", links],
  ];
  for (const [read, result] of entries) {
    if (result.absent) absent.push(read);
    else if (result.status !== null) failures.push({ read, status: result.status });
  }
  return {
    campaignId,
    devices: devices.rows,
    geography: geography.rows,
    links: links.rows,
    failures,
    absent,
  };
}

/** Every campaign in the rollup, read in parallel. */
export function fetchAudienceMix(
  campaignIds: readonly string[],
): Promise<AudienceMixCampaignResult[]> {
  const ids = Array.isArray(campaignIds) ? campaignIds : [];
  return Promise.all(ids.map((id) => fetchCampaignAudienceMix(id)));
}
