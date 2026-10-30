import type { Campaign, api } from "../../lib/api-client";

/**
 * Keep each response bounded while still reconciling the whole workspace.
 * The API clamps campaign pages at 500; 100 keeps list-rate joins and payloads
 * responsive without reintroducing the old first-100 coverage ceiling.
 */
export const CAMPAIGN_RECONCILIATION_PAGE_SIZE = 100;

/**
 * A defensive resource ceiling, not a silent result ceiling. Workspaces above
 * it fail closed and retain their last-good snapshot. The extra terminal
 * request lets an exact 100,000-row workspace prove completion with an empty
 * page.
 */
export const CAMPAIGN_RECONCILIATION_MAX_FULL_PAGES = 1_000;

/** Cache namespace version: older `null` entries may contain only 100 rows. */
export const CAMPAIGN_COMPLETE_CACHE_SCOPE = "complete-v1" as const;

type CampaignPageResponse = Awaited<ReturnType<typeof api.listCampaigns>>;
type CampaignPageFetcher = (
  page: number,
  perPage: number,
  signal: AbortSignal,
) => Promise<CampaignPageResponse>;
type CampaignCountResponse = Awaited<ReturnType<typeof api.countCampaigns>>;
type CampaignCountFetcher = (
  signal: AbortSignal,
) => Promise<CampaignCountResponse>;

interface ReconciliationState {
  campaignIds: Set<string>;
  firstPageFingerprint: string | null;
  firstPageWasFull: boolean;
  pageFingerprints: Set<string>;
  rows: Campaign[];
}

export class CampaignReconciliationAbortError extends Error {
  constructor() {
    super("Campaign reconciliation was aborted.");
    this.name = "CampaignReconciliationAbortError";
  }
}

function strictCampaignRows(value: unknown): Campaign[] | null {
  if (Array.isArray(value)) return value as Campaign[];
  if (!value || typeof value !== "object") return null;
  const envelope = value as Record<string, unknown>;
  for (const key of ["items", "results", "data"] as const) {
    if (Array.isArray(envelope[key])) return envelope[key] as Campaign[];
  }
  return null;
}

export function unwrapCampaignRows(value: unknown): Campaign[] {
  return strictCampaignRows(value) ?? [];
}

function assertReconciliationActive(signal: AbortSignal): void {
  if (signal.aborted) throw new CampaignReconciliationAbortError();
}

function pageError(page: number, detail: string): Error {
  return new Error(
    `Couldn't verify the complete campaign list on page ${page}. ${detail}`,
  );
}

async function fetchVerifiedCampaignCount(
  fetchCount: CampaignCountFetcher,
  signal: AbortSignal,
  phase: "before" | "after",
): Promise<number> {
  assertReconciliationActive(signal);
  const response = await fetchCount(signal);
  assertReconciliationActive(signal);
  if (response.error?.kind === "network" && response.error.code === "aborted") {
    throw new CampaignReconciliationAbortError();
  }
  if (response.error) {
    throw new Error(
      `Couldn't verify the complete campaign count ${phase} loading. ${response.error.message}`,
    );
  }
  const total = response.data?.total;
  const byStatus = response.data?.by_status;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !byStatus ||
    typeof byStatus !== "object" ||
    Array.isArray(byStatus)
  ) {
    throw new Error(
      `Couldn't verify the complete campaign count ${phase} loading. The server returned an invalid count response.`,
    );
  }
  const statusCounts = Object.values(byStatus);
  if (
    statusCounts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    statusCounts.reduce((sum, count) => sum + count, 0) !== total
  ) {
    throw new Error(
      `Couldn't verify the complete campaign count ${phase} loading. Status totals did not match the workspace total.`,
    );
  }
  return total;
}

async function fetchVerifiedCampaignPage(
  fetchPage: CampaignPageFetcher,
  page: number,
  signal: AbortSignal,
): Promise<Campaign[]> {
  assertReconciliationActive(signal);
  const response = await fetchPage(
    page,
    CAMPAIGN_RECONCILIATION_PAGE_SIZE,
    signal,
  );
  assertReconciliationActive(signal);
  if (response.error?.kind === "network" && response.error.code === "aborted") {
    throw new CampaignReconciliationAbortError();
  }
  if (response.error) throw pageError(page, response.error.message);

  const rows = strictCampaignRows(response.data);
  if (rows === null) {
    throw pageError(page, "The server returned an invalid page response.");
  }
  if (rows.length > CAMPAIGN_RECONCILIATION_PAGE_SIZE) {
    throw pageError(
      page,
      `The server exceeded the requested ${CAMPAIGN_RECONCILIATION_PAGE_SIZE}-row page size.`,
    );
  }
  return rows;
}

function appendVerifiedCampaignPage(
  state: ReconciliationState,
  pageRows: Campaign[],
  page: number,
): void {
  const { fingerprint, ids: pageIds } = campaignPageIdentity(pageRows, page);
  if (page === 1) {
    state.firstPageFingerprint = fingerprint;
    state.firstPageWasFull =
      pageRows.length === CAMPAIGN_RECONCILIATION_PAGE_SIZE;
  }
  if (pageRows.length > 0 && state.pageFingerprints.has(fingerprint)) {
    throw pageError(
      page,
      "The server repeated an earlier page, so coverage may be incomplete.",
    );
  }
  if (pageRows.length > 0) state.pageFingerprints.add(fingerprint);

  for (const id of pageIds) {
    if (state.campaignIds.has(id)) {
      throw pageError(
        page,
        `Campaign ${id} appeared on more than one page, so coverage may be incomplete.`,
      );
    }
    state.campaignIds.add(id);
  }
  state.rows.push(...pageRows);
}

function campaignPageIdentity(
  pageRows: Campaign[],
  page: number,
): { fingerprint: string; ids: string[] } {
  const ids = pageRows.map((campaign) => {
    const id = campaign.id;
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      String(id).trim() === ""
    ) {
      throw pageError(page, "A campaign was missing its stable identifier.");
    }
    return String(id);
  });
  return { fingerprint: ids.join("\u001f"), ids };
}

/**
 * Fetches a complete campaign snapshot without ever returning a partial one.
 * A short page is the server contract's end marker; exact page multiples are
 * followed by one final empty request. Stable IDs, page fingerprints, and
 * exact counts defend against shifted/repeated offset pages and count races.
 */
export async function reconcileAllCampaignPages(
  fetchPage: CampaignPageFetcher,
  fetchCount: CampaignCountFetcher,
  signal: AbortSignal,
): Promise<Campaign[]> {
  const state: ReconciliationState = {
    campaignIds: new Set(),
    firstPageFingerprint: null,
    firstPageWasFull: false,
    pageFingerprints: new Set(),
    rows: [],
  };
  const countBefore = await fetchVerifiedCampaignCount(
    fetchCount,
    signal,
    "before",
  );
  const maximumCampaigns =
    CAMPAIGN_RECONCILIATION_MAX_FULL_PAGES * CAMPAIGN_RECONCILIATION_PAGE_SIZE;
  if (countBefore > maximumCampaigns) {
    throw new Error(
      `Couldn't verify the complete campaign list. The workspace has ${countBefore.toLocaleString()} campaigns, above the ${maximumCampaigns.toLocaleString()}-campaign desktop reconciliation safety limit.`,
    );
  }

  for (
    let page = 1;
    page <= CAMPAIGN_RECONCILIATION_MAX_FULL_PAGES + 1;
    page += 1
  ) {
    const pageRows = await fetchVerifiedCampaignPage(fetchPage, page, signal);
    if (page === CAMPAIGN_RECONCILIATION_MAX_FULL_PAGES + 1) {
      if (pageRows.length === 0) break;
      throw pageError(
        page,
        `The workspace exceeded the ${maximumCampaigns.toLocaleString()}-campaign desktop reconciliation safety limit while loading.`,
      );
    }
    appendVerifiedCampaignPage(state, pageRows, page);
    if (pageRows.length < CAMPAIGN_RECONCILIATION_PAGE_SIZE) break;
  }

  if (state.firstPageWasFull) {
    const anchorRows = await fetchVerifiedCampaignPage(fetchPage, 1, signal);
    const anchor = campaignPageIdentity(anchorRows, 1);
    if (
      anchorRows.length !== CAMPAIGN_RECONCILIATION_PAGE_SIZE ||
      anchor.fingerprint !== state.firstPageFingerprint
    ) {
      throw new Error(
        "Couldn't verify the complete campaign list. The first page changed while later pages were loading. Retry to load a stable snapshot.",
      );
    }
  }

  const countAfter = await fetchVerifiedCampaignCount(
    fetchCount,
    signal,
    "after",
  );
  if (countBefore !== countAfter || state.rows.length !== countAfter) {
    throw new Error(
      `Couldn't verify the complete campaign list. The workspace count changed from ${countBefore.toLocaleString()} to ${countAfter.toLocaleString()} while ${state.rows.length.toLocaleString()} rows were reconciled. Retry to load a stable snapshot.`,
    );
  }
  return state.rows;
}
