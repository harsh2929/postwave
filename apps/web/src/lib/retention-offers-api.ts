// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Strict client contract for the read-only win-back evidence surface.
 *
 * These responses describe stored configuration and historical counters. A
 * malformed 200 is therefore an error, never an empty workspace or a set of
 * invented zeroes. Keeping the decoders here also gives every caller the same
 * bounds, identity checks, and count-parity rules.
 */
import { api } from "@/lib/api";
import { listPaywallTiers } from "@/lib/monetisation-api";

const MAX_RETENTION_ROWS = 1_000;
const MAX_HEADLINE_BYTES = 1_000;
const MAX_BODY_BYTES = 10_000;
const MAX_PROVIDER_REFERENCE_BYTES = 512;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EVENT_COUNT = Math.floor(
  Number.MAX_SAFE_INTEGER / (MAX_RETENTION_ROWS * 4),
);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const UNSAFE_DISPLAY_CHARACTER_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export interface WinbackSettings {
  enabled: boolean;
  /** Probability in the range 0..1, NOT a percentage. */
  churn_threshold: number;
  churn_profiles_scored: number;
}

export interface RetentionOffer {
  id: string;
  paywall_tier_id: string;
  percent_off?: number;
  fixed_off_cents?: number;
  duration_months: number;
  headline: string;
  body: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  /**
   * Presence of a provider coupon reference, never the reference itself.
   * A coupon id is a provider-side handle; "a coupon is attached" is the fact
   * an operator needs, and it is not evidence the provider ever applied it.
   */
  provider_coupon_present: boolean;
}

export interface RetentionFunnelTile {
  offer_id: string;
  tier_id: string;
  shown: number;
  accepted: number;
  declined: number;
  expired: number;
  /** Validated against the integer counters, but display derives from them. */
  acceptance_rate: number;
}

export interface RetentionOffersResponse {
  offers: RetentionOffer[];
  count: number;
}

export interface RetentionFunnelResponse {
  tiles: RetentionFunnelTile[];
  count: number;
}

export class RetentionOffersContractError extends Error {
  readonly code = "retention_offers_contract_invalid";

  constructor(surface: string) {
    super(
      `Moosewave returned an invalid ${surface} response. Refresh and try again.`,
    );
    this.name = "RetentionOffersContractError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint > 0xffff) index += 1;
    length +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return length;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    utf8ByteLength(value) <= maxBytes &&
    !UNSAFE_DISPLAY_CHARACTER_RE.test(value)
  );
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = RFC3339_RE.exec(value);
  if (!match || match[1] === "0000") return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    Number.isFinite(Date.parse(value))
  );
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedEventCount(value: unknown): value is number {
  return nonnegativeSafeInteger(value) && Number(value) <= MAX_EVENT_COUNT;
}

function unitInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function positiveUnitInterval(value: unknown): value is number {
  return unitInterval(value) && value > 0;
}

function parseOffer(value: unknown): RetentionOffer & { tenant_id: string } {
  const row = record(value);
  const required = [
    "id",
    "tenant_id",
    "paywall_tier_id",
    "duration_months",
    "active",
    "created_at",
    "updated_at",
  ] as const;
  const optional = [
    "percent_off",
    "fixed_off_cents",
    "headline",
    "body",
    "stripe_coupon_id",
  ] as const;
  if (
    !row ||
    !exactKeys(row, required, optional) ||
    !uuid(row.id) ||
    !uuid(row.tenant_id) ||
    !uuid(row.paywall_tier_id) ||
    !Number.isSafeInteger(row.duration_months) ||
    Number(row.duration_months) < 1 ||
    Number(row.duration_months) > 60 ||
    typeof row.active !== "boolean" ||
    !timestamp(row.created_at) ||
    !timestamp(row.updated_at) ||
    (row.headline !== undefined &&
      !boundedString(row.headline, MAX_HEADLINE_BYTES)) ||
    (row.body !== undefined && !boundedString(row.body, MAX_BODY_BYTES)) ||
    (row.stripe_coupon_id !== undefined &&
      !boundedString(row.stripe_coupon_id, MAX_PROVIDER_REFERENCE_BYTES))
  ) {
    throw new RetentionOffersContractError("retention offer list");
  }

  const hasPercent = Object.prototype.hasOwnProperty.call(row, "percent_off");
  const hasFixed = Object.prototype.hasOwnProperty.call(row, "fixed_off_cents");
  if (hasPercent === hasFixed) {
    throw new RetentionOffersContractError("retention offer list");
  }
  if (
    hasPercent &&
    (!Number.isSafeInteger(row.percent_off) ||
      Number(row.percent_off) < 1 ||
      Number(row.percent_off) > 100)
  ) {
    throw new RetentionOffersContractError("retention offer list");
  }
  if (
    hasFixed &&
    (!Number.isSafeInteger(row.fixed_off_cents) ||
      Number(row.fixed_off_cents) < 1 ||
      Number(row.fixed_off_cents) > POSTGRES_INTEGER_MAX)
  ) {
    throw new RetentionOffersContractError("retention offer list");
  }

  if (Date.parse(row.updated_at) < Date.parse(row.created_at)) {
    throw new RetentionOffersContractError("retention offer list");
  }

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    paywall_tier_id: row.paywall_tier_id,
    ...(hasPercent ? { percent_off: Number(row.percent_off) } : {}),
    ...(hasFixed ? { fixed_off_cents: Number(row.fixed_off_cents) } : {}),
    duration_months: Number(row.duration_months),
    headline: typeof row.headline === "string" ? row.headline : "",
    body: typeof row.body === "string" ? row.body : "",
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
    provider_coupon_present: typeof row.stripe_coupon_id === "string",
  };
}

export function parseWinbackSettings(value: unknown): WinbackSettings {
  const row = record(value);
  if (
    !row ||
    !exactKeys(row, ["enabled", "churn_threshold", "churn_profiles_scored"]) ||
    typeof row.enabled !== "boolean" ||
    !positiveUnitInterval(row.churn_threshold) ||
    !nonnegativeSafeInteger(row.churn_profiles_scored)
  ) {
    throw new RetentionOffersContractError("win-back settings");
  }
  return {
    enabled: row.enabled,
    churn_threshold: row.churn_threshold,
    churn_profiles_scored: row.churn_profiles_scored,
  };
}

export function parseRetentionOffers(
  value: unknown,
  expectedTenantId?: string,
): RetentionOffersResponse {
  const envelope = record(value);
  if (
    !envelope ||
    !exactKeys(envelope, ["offers", "count"]) ||
    !Array.isArray(envelope.offers) ||
    envelope.offers.length > MAX_RETENTION_ROWS ||
    !nonnegativeSafeInteger(envelope.count) ||
    envelope.count > MAX_RETENTION_ROWS ||
    envelope.count !== envelope.offers.length
  ) {
    throw new RetentionOffersContractError("retention offer list");
  }

  if (expectedTenantId !== undefined && !uuid(expectedTenantId)) {
    throw new RetentionOffersContractError("retention offer list");
  }
  const decoded = envelope.offers.map(parseOffer);
  const offerIds = new Set(decoded.map((offer) => offer.id));
  const tierIds = new Set(decoded.map((offer) => offer.paywall_tier_id));
  const tenantIds = new Set(decoded.map((offer) => offer.tenant_id));
  if (
    offerIds.size !== decoded.length ||
    tierIds.size !== decoded.length ||
    tenantIds.size > 1 ||
    (expectedTenantId !== undefined &&
      decoded.some(
        (offer) =>
          offer.tenant_id.toLowerCase() !== expectedTenantId.toLowerCase(),
      ))
  ) {
    throw new RetentionOffersContractError("retention offer list");
  }

  return {
    offers: decoded.map(({ tenant_id: _tenantId, ...offer }) => offer),
    count: envelope.count,
  };
}

function parseFunnelTile(value: unknown): RetentionFunnelTile {
  const row = record(value);
  if (
    !row ||
    !exactKeys(row, [
      "offer_id",
      "tier_id",
      "shown",
      "accepted",
      "declined",
      "expired",
      "acceptance_rate",
    ]) ||
    !uuid(row.offer_id) ||
    !uuid(row.tier_id) ||
    !boundedEventCount(row.shown) ||
    !boundedEventCount(row.accepted) ||
    !boundedEventCount(row.declined) ||
    !boundedEventCount(row.expired) ||
    !unitInterval(row.acceptance_rate) ||
    row.accepted > row.shown
  ) {
    throw new RetentionOffersContractError("retention funnel");
  }

  const expectedRate = row.shown === 0 ? 0 : row.accepted / row.shown;
  if (Math.abs(row.acceptance_rate - expectedRate) > 1e-12) {
    throw new RetentionOffersContractError("retention funnel");
  }

  return {
    offer_id: row.offer_id,
    tier_id: row.tier_id,
    shown: row.shown,
    accepted: row.accepted,
    declined: row.declined,
    expired: row.expired,
    acceptance_rate: row.acceptance_rate,
  };
}

export function parseRetentionFunnel(value: unknown): RetentionFunnelResponse {
  const envelope = record(value);
  if (
    !envelope ||
    !exactKeys(envelope, ["tiles", "count"]) ||
    !Array.isArray(envelope.tiles) ||
    envelope.tiles.length > MAX_RETENTION_ROWS ||
    !nonnegativeSafeInteger(envelope.count) ||
    envelope.count > MAX_RETENTION_ROWS ||
    envelope.count !== envelope.tiles.length
  ) {
    throw new RetentionOffersContractError("retention funnel");
  }

  const tiles = envelope.tiles.map(parseFunnelTile);
  const offerIds = new Set(tiles.map((tile) => tile.offer_id));
  const tierIds = new Set(tiles.map((tile) => tile.tier_id));
  if (offerIds.size !== tiles.length || tierIds.size !== tiles.length) {
    throw new RetentionOffersContractError("retention funnel");
  }
  return { tiles, count: envelope.count };
}

export async function getWinbackSettings(): Promise<WinbackSettings> {
  return parseWinbackSettings(
    await api.get<unknown>("/api/v1/retention-offers/winback-settings"),
  );
}

export async function listRetentionOffers(
  expectedTenantId: string,
): Promise<RetentionOffersResponse> {
  return parseRetentionOffers(
    await api.get<unknown>("/api/v1/retention-offers"),
    expectedTenantId,
  );
}

export async function getRetentionFunnel(): Promise<RetentionFunnelResponse> {
  return parseRetentionFunnel(
    await api.get<unknown>("/api/v1/retention-offers/funnel"),
  );
}

/** Render a probability as a percentage without changing its meaning. */
export function formatChurnThreshold(fraction: number): string {
  if (!positiveUnitInterval(fraction)) return "—";
  const pct = fraction * 100;
  const shown = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${shown}%`;
}

/**
 * Fixed discounts deliberately stay in raw minor units: this wire shape has
 * neither currency nor decimal precision. Dividing by 100 would silently
 * assume two-decimal money even after removing an invented USD symbol.
 */
export function formatOfferDiscount(percent?: number, cents?: number): string {
  if (Number.isSafeInteger(percent) && Number(percent) >= 1) {
    return `${Number(percent).toLocaleString()}% off`;
  }
  if (Number.isSafeInteger(cents) && Number(cents) >= 1) {
    return `${Number(cents).toLocaleString()} minor units off; currency unavailable`;
  }
  return "Discount unavailable";
}

/** A zero shown count has no denominator, so its acceptance is unknown. */
export function formatAcceptanceRate(
  tile: Pick<
    RetentionFunnelTile,
    "shown" | "accepted" | "declined" | "expired"
  >,
): string {
  if (
    tile.shown === 0 ||
    tile.accepted + tile.declined + tile.expired > tile.shown
  ) {
    return "Unknown";
  }
  const percentage = (tile.accepted / tile.shown) * 100;
  return `${percentage.toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;
}

export function hasRetentionOutcomeConflict(
  tile: Pick<
    RetentionFunnelTile,
    "shown" | "accepted" | "declined" | "expired"
  >,
): boolean {
  return tile.accepted + tile.declined + tile.expired > tile.shown;
}

/** True when scores exist but the stored switch cannot imply action. */
export function scoredButInert(settings: WinbackSettings): boolean {
  return !settings.enabled && settings.churn_profiles_scored > 0;
}

// ---------------------------------------------------------------------------
// Paywall tier names (commerce-59)
// ---------------------------------------------------------------------------

export interface RetentionTier {
  id: string;
  name: string;
  active: boolean;
}

/**
 * Tier names, decoded from the rows `listPaywallTiers` returns.
 *
 * The transport stays in monetisation-api so `/api/v1/paywall/tiers` has ONE
 * literal in the app. What is added here is the decode: an offer labelled with
 * a raw tier UUID is unreadable, and a *wrong* name is worse than a UUID, so a
 * row that does not decode contributes no name at all rather than a guess.
 *
 * A malformed row is skipped instead of failing the whole read: the tier
 * catalogue is a labelling aid, and losing every label because one tier is
 * malformed would be a worse outcome than losing one label.
 */
export function parseRetentionTiers(rows: readonly unknown[]): RetentionTier[] {
  const out: RetentionTier[] = [];
  const seen = new Set<string>();
  for (const candidate of rows.slice(0, MAX_RETENTION_ROWS)) {
    const row = record(candidate);
    if (
      !row ||
      !uuid(row.id) ||
      seen.has(row.id.toLowerCase()) ||
      typeof row.active !== "boolean" ||
      !boundedString(row.name, MAX_HEADLINE_BYTES)
    ) {
      continue;
    }
    seen.add(row.id.toLowerCase());
    out.push({ id: row.id, name: row.name, active: row.active });
  }
  return out;
}

export async function listRetentionTiers(): Promise<RetentionTier[]> {
  return parseRetentionTiers(await listPaywallTiers());
}

// ---------------------------------------------------------------------------
// Client-side history controls (commerce-57 / commerce-58)
//
// The offer list is bounded at 1,000 rows by contract (MAX_RETENTION_ROWS) and
// the service mounts no search, filter, sort, or paging parameters — so these
// operate over the rows already in hand. That bound is what makes it safe:
// this is not paging-in-the-client over an unbounded collection.
// ---------------------------------------------------------------------------

export const RETENTION_HISTORY_PAGE_SIZE = 10;

export type RetentionStatusFilter = "all" | "active" | "inactive";
export type RetentionDiscountFilter = "all" | "percent" | "fixed";
export type RetentionEvidenceFilter =
  | "all"
  | "measured"
  | "zero"
  | "unknown"
  | "anomaly";
export type RetentionHistorySort =
  | "newest"
  | "oldest"
  | "updated-desc"
  | "tier-asc"
  | "shown-desc"
  | "accepted-desc";

/**
 * How much an offer's counters can be trusted.
 *
 * `missing` and `unavailable` are kept apart deliberately: "the funnel says
 * nothing about this offer" and "the funnel could not be read" are different
 * claims, and collapsing them would let a failed request read as a quiet
 * offer.
 */
export type RetentionEvidenceState =
  | "measured"
  | "zero"
  | "missing"
  | "unavailable"
  | "outcome-excess"
  | "tier-mismatch";

export interface RetentionOfferRow {
  offer: RetentionOffer;
  /** Null when the catalogue has no name for this tier, or was not read. */
  tierName: string | null;
  funnel: RetentionFunnelTile | null;
  evidence: RetentionEvidenceState;
}

export function retentionEvidenceLabel(state: RetentionEvidenceState): string {
  switch (state) {
    case "measured":
      return "Reconciled counters";
    case "zero":
      return "No recorded events";
    case "missing":
      return "Funnel record missing";
    case "unavailable":
      return "Funnel unavailable";
    case "outcome-excess":
      return "Outcome-count conflict";
    case "tier-mismatch":
      return "Tier mismatch";
  }
}

function evidenceStateOf(
  offer: RetentionOffer,
  tile: RetentionFunnelTile | null,
  funnelRead: boolean,
): RetentionEvidenceState {
  if (!funnelRead) return "unavailable";
  if (!tile) return "missing";
  if (tile.tier_id !== offer.paywall_tier_id) return "tier-mismatch";
  if (hasRetentionOutcomeConflict(tile)) return "outcome-excess";
  return tile.shown === 0 ? "zero" : "measured";
}

/**
 * Join offers, the funnel and the tier catalogue into one row per offer.
 *
 * `tiles`/`tiers` are nullable on purpose — null means "that read did not
 * succeed", which is what separates `unavailable` from `missing` above.
 */
export function buildRetentionOfferRows(
  offers: readonly RetentionOffer[],
  tiles: readonly RetentionFunnelTile[] | null,
  tiers: readonly RetentionTier[] | null,
): RetentionOfferRow[] {
  const byOffer = new Map((tiles ?? []).map((tile) => [tile.offer_id, tile]));
  const names = new Map((tiers ?? []).map((tier) => [tier.id, tier.name]));
  return offers.map((offer) => {
    const tile = byOffer.get(offer.id) ?? null;
    return {
      offer,
      tierName: names.get(offer.paywall_tier_id) ?? null,
      funnel: tile,
      evidence: evidenceStateOf(offer, tile, tiles !== null),
    };
  });
}

/** The tier label an operator sees: a name when known, a reference otherwise. */
export function retentionTierLabel(
  row: RetentionOfferRow,
  catalogueRead: boolean,
): string {
  if (row.tierName) return row.tierName;
  const reference = `Tier ${row.offer.paywall_tier_id.slice(0, 8)}…`;
  return catalogueRead ? `${reference} · absent from catalogue` : reference;
}

export function retentionOfferMatchesQuery(
  row: RetentionOfferRow,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  const haystack = [
    row.tierName ?? "",
    row.offer.paywall_tier_id,
    row.offer.id,
    row.offer.headline,
    row.offer.body,
    row.offer.active ? "active" : "inactive",
    formatOfferDiscount(row.offer.percent_off, row.offer.fixed_off_cents),
  ]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(needle);
}

function matchesEvidence(
  row: RetentionOfferRow,
  evidence: RetentionEvidenceFilter,
): boolean {
  switch (evidence) {
    case "all":
      return true;
    case "measured":
      return row.evidence === "measured";
    case "zero":
      return row.evidence === "zero";
    case "unknown":
      return row.evidence === "missing" || row.evidence === "unavailable";
    case "anomaly":
      return (
        row.evidence === "outcome-excess" || row.evidence === "tier-mismatch"
      );
  }
}

export function filterRetentionOfferRows(
  rows: readonly RetentionOfferRow[],
  controls: {
    query: string;
    status: RetentionStatusFilter;
    discount: RetentionDiscountFilter;
    evidence: RetentionEvidenceFilter;
  },
): RetentionOfferRow[] {
  return rows.filter((row) => {
    if (controls.status === "active" && !row.offer.active) return false;
    if (controls.status === "inactive" && row.offer.active) return false;
    if (
      controls.discount === "percent" &&
      row.offer.percent_off === undefined
    ) {
      return false;
    }
    if (
      controls.discount === "fixed" &&
      row.offer.fixed_off_cents === undefined
    ) {
      return false;
    }
    if (!matchesEvidence(row, controls.evidence)) return false;
    return retentionOfferMatchesQuery(row, controls.query);
  });
}

/**
 * A row with no reconciled counters sorts last under a counter sort rather
 * than as a zero — "unknown" is not "none", and putting it above a measured
 * zero would state something the funnel never said.
 */
function counterOf(
  row: RetentionOfferRow,
  field: "shown" | "accepted",
): number {
  return row.evidence === "measured" || row.evidence === "zero"
    ? (row.funnel?.[field] ?? -1)
    : -1;
}

export function sortRetentionOfferRows(
  rows: readonly RetentionOfferRow[],
  sort: RetentionHistorySort,
): RetentionOfferRow[] {
  const at = (value: string): number => Date.parse(value) || 0;
  return [...rows].sort((left, right) => {
    switch (sort) {
      case "oldest":
        return at(left.offer.created_at) - at(right.offer.created_at);
      case "updated-desc":
        return at(right.offer.updated_at) - at(left.offer.updated_at);
      case "tier-asc":
        return (
          retentionTierLabel(left, true).localeCompare(
            retentionTierLabel(right, true),
          ) || at(right.offer.created_at) - at(left.offer.created_at)
        );
      case "shown-desc":
        return (
          counterOf(right, "shown") - counterOf(left, "shown") ||
          at(right.offer.created_at) - at(left.offer.created_at)
        );
      case "accepted-desc":
        return (
          counterOf(right, "accepted") - counterOf(left, "accepted") ||
          at(right.offer.created_at) - at(left.offer.created_at)
        );
      default:
        return at(right.offer.created_at) - at(left.offer.created_at);
    }
  });
}
