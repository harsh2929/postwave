import { rawRequest, type AIApiResult } from "@/api/request";
import {
  parseCampaignPollDefinitionPage,
  parseCampaignPollTally,
  type CampaignPollDefinition,
  type CampaignPollReceipt,
} from "@/lib/campaignPolls";

const PAGE_SIZE = 100;

async function listAllCampaignPollDefinitions(
  base: string,
): Promise<CampaignPollDefinition[]> {
  const definitions: CampaignPollDefinition[] = [];
  const seenDefinitionIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const list = await rawRequest<unknown>(
      "GET",
      `${base}?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (list.error)
      throw Object.assign(new Error(list.error.message), list.error);
    const page = parseCampaignPollDefinitionPage(list.data);
    for (const definition of page.items) {
      if (seenDefinitionIds.has(definition.id)) {
        throw new Error(
          "The paginated campaign poll register contained a duplicate definition ID.",
        );
      }
      seenDefinitionIds.add(definition.id);
      definitions.push(definition);
    }
    if (page.nextCursor && seenCursors.has(page.nextCursor)) {
      throw new Error("The paginated campaign poll register repeated a cursor.");
    }
    if (page.nextCursor) seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return definitions;
}

/**
 * How many tally reads are in flight at once.
 *
 * The tallies do not depend on each other — each one needs only its own
 * definition, which the register already handed us — so awaiting them one at a
 * time made a campaign with N polls cost N round trips on a phone, where one
 * wave would do. Bounded rather than unbounded because the register is
 * paginated at 100 a page and has no ceiling: firing every tally at once would
 * trade a waterfall for a stampede, and iOS/Android queue past the per-host
 * connection limit anyway.
 */
const TALLY_CONCURRENCY = 6;

export async function listCampaignPollReceipts(
  campaignId: string,
): Promise<CampaignPollReceipt[]> {
  const base = `/api/v1/campaigns/${encodeURIComponent(campaignId)}/polls`;
  const definitions = await listAllCampaignPollDefinitions(base);
  const tallies = new Array<AIApiResult<unknown>>(definitions.length);
  let next = 0;
  const drain = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const definition = definitions[index];
      if (!definition) return;
      tallies[index] = await rawRequest<unknown>(
        "GET",
        `${base}/${encodeURIComponent(definition.pollKey)}/tally?content_revision_id=${encodeURIComponent(definition.contentRevisionId)}`,
      );
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(TALLY_CONCURRENCY, definitions.length) },
      drain,
    ),
  );
  // Collected in DEFINITION order, and inspected in that order, so the failure
  // a caller sees is the same one the serial loop raised — the first failing
  // definition, not whichever request happened to settle first.
  const receipts: CampaignPollReceipt[] = [];
  for (const [index, definition] of definitions.entries()) {
    const tally = tallies[index]!;
    if (tally.error)
      throw Object.assign(new Error(tally.error.message), tally.error);
    receipts.push({
      definition,
      tally: parseCampaignPollTally(tally.data, definition),
    });
  }
  return receipts;
}
