// SPDX-License-Identifier: AGPL-3.0-only
//
// Fail-closed adapters for the dormant affiliate source prototype. Local mock
// mode can exercise its design fixtures, but production never constructs an
// HTTP request because the gateway intentionally mounts no affiliate program.

import { isMockModeEnabled } from "./mock-mode";
import type {
  Affiliate,
  AffiliateConversion,
  AffiliateDetail,
  AffiliatePayout,
  AffiliateStatus,
  AffiliateUpdateInput,
  ConversionStatus,
} from "./affiliates-types";

const USE_MOCKS = isMockModeEnabled();
const loadMocks = () => import("./affiliates-mocks");

function unavailable<T>(capability: string): Promise<T> {
  return Promise.reject(
    affiliateReleaseHeldError(
      capability,
      "The production runtime does not mount affiliate administration or settlement.",
    ),
  );
}

// ---------- admin ----------

export interface ListAffiliatesQuery {
  status?: AffiliateStatus[];
  country?: string;
  sort?: "created_at" | "total_commission" | "name";
}

export interface AffiliateProgramRow {
  affiliate: Affiliate;
  last30: import("./affiliates-types").AffiliateStats;
  lifetime: import("./affiliates-types").AffiliateStats;
}

export interface AffiliateProgramPage {
  rows: AffiliateProgramRow[];
  overview: {
    activeCount: number;
    clicks30d: number;
    conversions30d: number;
    pendingPayoutCents: number;
  };
  total: number;
  page: number;
  perPage: number;
}

function emptyProgramPage(page: number, perPage: number): AffiliateProgramPage {
  return {
    rows: [],
    overview: {
      activeCount: 0,
      clicks30d: 0,
      conversions30d: 0,
      pendingPayoutCents: 0,
    },
    total: 0,
    page,
    perPage,
  };
}

export function getAffiliateProgramPage(
  page = 1,
  perPage = 50,
  filters: { status?: string; country?: string; sort?: string } = {},
): Promise<AffiliateProgramPage> {
  // Mock mode may still render the source prototype for local design work.
  // Production must reject before transport: even a read would disclose
  // partner and commission data through a route the gateway intentionally
  // excludes.
  if (USE_MOCKS) return Promise.resolve(emptyProgramPage(page, perPage));
  void filters;
  return unavailable("Affiliate program access");
}

/** Retained admin-create input. The production route is release-held, so the
 * wrapper below deliberately rejects before transport. */
export interface CreateAffiliateInput {
  email: string;
  name: string;
  country?: string;
  slug?: string;
  website?: string;
  audienceSize?: number;
  audienceDesc?: string;
}

export async function createAffiliate(
  _input: CreateAffiliateInput,
): Promise<Affiliate> {
  throw affiliateReleaseHeldError(
    "Affiliate creation",
    "The production runtime does not mount affiliate administration.",
  );
}

export function listAffiliates(
  q: ListAffiliatesQuery = {},
): Promise<Affiliate[]> {
  if (USE_MOCKS) return loadMocks().then((m) => m.mockListAffiliates());
  void q;
  return unavailable("Affiliate listing");
}

export function getAffiliate(id: string): Promise<AffiliateDetail> {
  if (USE_MOCKS) return loadMocks().then((m) => m.mockGetAffiliate(id));
  return unavailable("Affiliate record access");
}

export function updateAffiliate(
  id: string,
  patch: AffiliateUpdateInput,
): Promise<Affiliate> {
  if (USE_MOCKS)
    return loadMocks().then((m) => m.mockUpdateAffiliate(id, patch));
  return unavailable("Affiliate moderation");
}

/**
 * Recent conversions, bounded (BILL-018). The detail page shows + charts these
 * without loading the full history up front; the chart uses the server-side
 * monthly aggregate and CSV export fetches everything on demand.
 */
export async function listConversions(
  id: string,
  limit = 200,
): Promise<AffiliateConversion[]> {
  if (USE_MOCKS) return (await loadMocks()).mockListConversions(id);
  void limit;
  return unavailable("Affiliate conversion access");
}

/** Full conversion history (all pages) — used only for on-demand CSV export. */
export async function listAllConversions(
  id: string,
): Promise<AffiliateConversion[]> {
  if (USE_MOCKS) return (await loadMocks()).mockListConversions(id);
  return unavailable("Affiliate conversion export");
}

export function listPayouts(id: string): Promise<AffiliatePayout[]> {
  if (USE_MOCKS) return loadMocks().then((m) => m.mockListPayouts(id));
  return unavailable("Affiliate payout access");
}

/** Retained payout prototype. Affiliate settlement is not mounted and this
 * wrapper must remain fail-closed until the complete program is certified. */
export async function createPayout(_id: string): Promise<AffiliatePayout> {
  throw affiliateReleaseHeldError(
    "Affiliate payout execution",
    "The production runtime does not mount affiliate administration or settlement.",
  );
}

function affiliateReleaseHeldError(capability: string, detail: string): Error {
  return new Error(`${capability} is release-held. ${detail}`);
}

/** Mark a pending payout as sent with an external reference (BILL-004). */
export function markPayoutSent(
  _affiliateId: string,
  _payoutId: string,
  _reference: string,
): Promise<{ id: string; status: string; payout_reference: string }> {
  return unavailable("Affiliate payout settlement");
}

/** Moderate a single conversion — approve / reverse / dispute (BILL-033). */
export function updateConversionStatus(
  _affiliateId: string,
  _conversionId: number,
  _status: ConversionStatus,
): Promise<AffiliateConversion> {
  return unavailable("Affiliate conversion moderation");
}
