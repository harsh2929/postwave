import type { CampaignTemplate } from "./api-client";

/**
 * Use the API's largest supported page. The desktop catalog hydrates every
 * matching template for a workspace, so this keeps a complete library from
 * turning into an excessive number of round trips.
 */
export const CAMPAIGN_TEMPLATE_PAGE_SIZE = 100;

/**
 * Append a catalog page without duplicating rows when an item moves across a
 * page boundary while the operator is browsing. A repeated id refreshes the
 * already-loaded summary in place; new ids retain the server's page order.
 */
export function appendCampaignTemplatePage(
  current: CampaignTemplate[],
  incoming: CampaignTemplate[],
): CampaignTemplate[] {
  const next = [...current];
  const indexByID = new Map(
    next.map((template, index) => [template.id, index]),
  );

  for (const template of incoming) {
    const index = indexByID.get(template.id);
    if (index === undefined) {
      indexByID.set(template.id, next.length);
      next.push(template);
    } else {
      next[index] = template;
    }
  }
  return next;
}

export function hasMoreCampaignTemplates(
  loaded: number,
  total: number | null,
): boolean {
  return total !== null && loaded < Math.max(0, total);
}
