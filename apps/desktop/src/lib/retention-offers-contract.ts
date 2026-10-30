/**
 * Strict, privacy-minimized read contracts for the retention-history surface.
 *
 * The server returns unpaginated offer and funnel collections. Keep a bounded
 * local ceiling so an unexpected response cannot turn one route into an
 * unbounded render, sort, or aggregation job. A response above the ceiling is
 * rejected; it is never silently truncated because truncation would make the
 * reported funnel look complete when it is not.
 */
export const RETENTION_RECORD_CAP = 1_000;

const MAX_HEADLINE_BYTES = 1_000;
const MAX_BODY_BYTES = 10_000;
const MAX_PROVIDER_REFERENCE_BYTES = 512;
const MAX_TIER_NAME_BYTES = 1_000;
const MAX_TIER_DESCRIPTION_BYTES = 10_000;
const MAX_FIXED_OFF_CENTS = 2_147_483_647;
const MAX_EVENT_COUNT = Math.floor(
  Number.MAX_SAFE_INTEGER / (RETENTION_RECORD_CAP * 4),
);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

type UnknownRecord = Record<string, unknown>;

export type RetentionContractFailureReason =
  | "invalid-envelope"
  | "too-many-records"
  | "count-mismatch"
  | "invalid-record"
  | "duplicate-identity"
  | "tenant-mismatch";

export type RetentionContractResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: RetentionContractFailureReason;
      recordIndex?: number;
    };

export type RetentionOfferDiscount =
  | { kind: "percent"; percent: number }
  | { kind: "fixed"; minorUnits: number; currency: null };

/**
 * The route needs operational history, not the complete database projection.
 * Tenant IDs and raw Stripe references are deliberately absent. Offer copy is
 * retained only after bounded display-text normalization because the history
 * detail view needs to inspect what a member would have seen.
 */
export interface RetentionOfferRecord {
  id: string;
  tierId: string;
  discount: RetentionOfferDiscount;
  durationMonths: number;
  headline: string | null;
  body: string | null;
  providerCouponPresent: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RetentionOfferCollection {
  items: RetentionOfferRecord[];
  reportedCount: number;
}

/**
 * `acceptance_rate` is intentionally not represented. It is recomputed from
 * the accepted and shown counts after the tile has passed this contract.
 */
export interface RetentionFunnelTile {
  offerId: string;
  tierId: string;
  shown: number;
  accepted: number;
  declined: number;
  expired: number;
}

export interface RetentionFunnelCollection {
  items: RetentionFunnelTile[];
  reportedCount: number;
}

export interface RetentionTierRecord {
  id: string;
  name: string;
  active: boolean;
}

export interface RetentionTierCollection {
  items: RetentionTierRecord[];
}

export interface RetentionWinbackSettings {
  enabled: boolean;
  churnThreshold: number;
  churnProfilesScored: number;
}

export interface DecodeRetentionOffersOptions {
  /**
   * When the caller knows the active tenant, every row must agree with it.
   * The tenant identifier is checked and then discarded.
   */
  expectedTenantId?: string;
}

export type RetentionFunnelRowState =
  | "matched"
  | "unavailable"
  | "missing"
  | "duplicate"
  | "tier-mismatch"
  | "outcome-excess";

export interface RetentionOfferHistoryRow {
  offer: RetentionOfferRecord;
  tierName: string | null;
  funnel: RetentionFunnelTile | null;
  funnelState: RetentionFunnelRowState;
}

export interface RetentionFunnelTotals {
  shown: number;
  accepted: number;
  declined: number;
  expired: number;
}

export type RetentionFunnelIntegrity =
  | "unavailable"
  | "reconciled"
  | "inconsistent";

export interface RetentionReconciliation {
  rows: RetentionOfferHistoryRow[];
  integrity: RetentionFunnelIntegrity;
  matchedTotals: RetentionFunnelTotals;
  sourceTileCount: number | null;
  missingTileOfferIds: string[];
  duplicateTileOfferIds: string[];
  orphanTileOfferIds: string[];
  tierMismatchOfferIds: string[];
  outcomeExcessOfferIds: string[];
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
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

function failure(
  reason: RetentionContractFailureReason,
  recordIndex?: number,
): RetentionContractResult<never> {
  return recordIndex === undefined
    ? { ok: false, reason }
    : { ok: false, reason, recordIndex };
}

function parseUuid(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !UUID_PATTERN.test(value)
  ) {
    return null;
  }
  return value.toLowerCase();
}

function isSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function normalizedDisplayText(
  value: unknown,
  maximumBytes: number,
  required: boolean,
): string | null | false {
  if (value === undefined || value === null) return required ? false : null;
  if (
    typeof value !== "string" ||
    utf8ByteLength(value) > maximumBytes ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (required && normalized.length === 0) return false;
  return normalized || null;
}

function normalizedBodyText(
  value: unknown,
  maximumBytes: number,
): string | null | false {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    utf8ByteLength(value) > maximumBytes ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    return false;
  }
  // Keep authored paragraphs intact while normalizing platform line endings.
  // React renders this as text and the detail stylesheet uses pre-wrap.
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized || null;
}

function optionalProviderReference(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return false;
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    utf8ByteLength(value) > MAX_PROVIDER_REFERENCE_BYTES ||
    UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  ) {
    return null;
  }
  return true;
}

function parseIsoInstant(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (!match || match[1] === "0000") return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function parseDiscount(value: UnknownRecord): RetentionOfferDiscount | null {
  const percentValue = value["percent_off"];
  const fixedValue = value["fixed_off_cents"];
  const hasPercent = Object.prototype.hasOwnProperty.call(value, "percent_off");
  const hasFixed = Object.prototype.hasOwnProperty.call(
    value,
    "fixed_off_cents",
  );
  if (hasPercent === hasFixed) return null;
  if (hasPercent) {
    return isSafeInteger(percentValue, 1, 100)
      ? { kind: "percent", percent: percentValue }
      : null;
  }
  return isSafeInteger(fixedValue, 1, MAX_FIXED_OFF_CENTS)
    ? { kind: "fixed", minorUnits: fixedValue, currency: null }
    : null;
}

function parseOffer(
  value: unknown,
  expectedTenantId: string | null,
): RetentionContractResult<RetentionOfferRecord> {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "id",
        "tenant_id",
        "paywall_tier_id",
        "duration_months",
        "active",
        "created_at",
        "updated_at",
      ],
      [
        "percent_off",
        "fixed_off_cents",
        "headline",
        "body",
        "stripe_coupon_id",
      ],
    )
  ) {
    return failure("invalid-record");
  }
  const id = parseUuid(value["id"]);
  const tenantId = parseUuid(value["tenant_id"]);
  const tierId = parseUuid(value["paywall_tier_id"]);
  const discount = parseDiscount(value);
  const headline = normalizedDisplayText(
    value["headline"],
    MAX_HEADLINE_BYTES,
    false,
  );
  const body = normalizedBodyText(value["body"], MAX_BODY_BYTES);
  const providerCouponPresent = optionalProviderReference(
    value["stripe_coupon_id"],
  );
  const createdAt = parseIsoInstant(value["created_at"]);
  const updatedAt = parseIsoInstant(value["updated_at"]);
  if (
    !id ||
    !tenantId ||
    !tierId ||
    !discount ||
    !isSafeInteger(value["duration_months"], 1, 60) ||
    headline === false ||
    body === false ||
    providerCouponPresent === null ||
    typeof value["active"] !== "boolean" ||
    !createdAt ||
    !updatedAt ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    return failure("invalid-record");
  }
  if (
    (Object.prototype.hasOwnProperty.call(value, "headline") &&
      headline === null) ||
    (Object.prototype.hasOwnProperty.call(value, "body") && body === null) ||
    (Object.prototype.hasOwnProperty.call(value, "stripe_coupon_id") &&
      providerCouponPresent === false)
  ) {
    return failure("invalid-record");
  }
  if (expectedTenantId !== null && tenantId !== expectedTenantId) {
    return failure("tenant-mismatch");
  }
  return {
    ok: true,
    data: {
      id,
      tierId,
      discount,
      durationMonths: value["duration_months"],
      headline,
      body,
      providerCouponPresent,
      active: value["active"],
      createdAt,
      updatedAt,
    },
  };
}

function parseCountedEnvelope(
  value: unknown,
  key: "offers" | "tiles",
): RetentionContractResult<{ records: unknown[]; count: number }> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [key, "count"]) ||
    !Array.isArray(value[key])
  ) {
    return failure("invalid-envelope");
  }
  if (value[key].length > RETENTION_RECORD_CAP) {
    return failure("too-many-records");
  }
  if (
    !isSafeInteger(value["count"], 0, RETENTION_RECORD_CAP) ||
    value["count"] !== value[key].length
  ) {
    return failure("count-mismatch");
  }
  return {
    ok: true,
    data: { records: value[key], count: value["count"] },
  };
}

export function decodeRetentionOffers(
  value: unknown,
  options: DecodeRetentionOffersOptions = {},
): RetentionContractResult<RetentionOfferCollection> {
  const envelope = parseCountedEnvelope(value, "offers");
  if (!envelope.ok) return envelope;
  const expectedTenantId =
    options.expectedTenantId === undefined
      ? null
      : parseUuid(options.expectedTenantId);
  if (options.expectedTenantId !== undefined && expectedTenantId === null) {
    return failure("invalid-envelope");
  }

  const items: RetentionOfferRecord[] = [];
  const offerIds = new Set<string>();
  const tierIds = new Set<string>();
  for (const [index, candidate] of envelope.data.records.entries()) {
    const parsed = parseOffer(candidate, expectedTenantId);
    if (!parsed.ok) return failure(parsed.reason, index);
    if (offerIds.has(parsed.data.id) || tierIds.has(parsed.data.tierId)) {
      return failure("duplicate-identity", index);
    }
    offerIds.add(parsed.data.id);
    tierIds.add(parsed.data.tierId);
    items.push(parsed.data);
  }
  return {
    ok: true,
    data: { items, reportedCount: envelope.data.count },
  };
}

function parseFunnelTile(value: unknown): RetentionFunnelTile | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "offer_id",
      "tier_id",
      "shown",
      "accepted",
      "declined",
      "expired",
      "acceptance_rate",
    ])
  ) {
    return null;
  }
  const offerId = parseUuid(value["offer_id"]);
  const tierId = parseUuid(value["tier_id"]);
  const shown = value["shown"];
  const accepted = value["accepted"];
  const declined = value["declined"];
  const expired = value["expired"];
  const acceptanceRate = value["acceptance_rate"];
  if (
    !offerId ||
    !tierId ||
    !isSafeInteger(shown, 0, MAX_EVENT_COUNT) ||
    !isSafeInteger(accepted, 0, MAX_EVENT_COUNT) ||
    !isSafeInteger(declined, 0, MAX_EVENT_COUNT) ||
    !isSafeInteger(expired, 0, MAX_EVENT_COUNT) ||
    typeof acceptanceRate !== "number" ||
    !Number.isFinite(acceptanceRate) ||
    acceptanceRate < 0 ||
    acceptanceRate > 1 ||
    accepted > shown ||
    Math.abs(acceptanceRate - (shown === 0 ? 0 : accepted / shown)) > 1e-12
  ) {
    return null;
  }
  return {
    offerId,
    tierId,
    shown,
    accepted,
    declined,
    expired,
  };
}

export function decodeRetentionFunnel(
  value: unknown,
): RetentionContractResult<RetentionFunnelCollection> {
  const envelope = parseCountedEnvelope(value, "tiles");
  if (!envelope.ok) return envelope;
  const items: RetentionFunnelTile[] = [];
  for (const [index, candidate] of envelope.data.records.entries()) {
    const tile = parseFunnelTile(candidate);
    if (!tile) return failure("invalid-record", index);
    items.push(tile);
  }
  return {
    ok: true,
    data: { items, reportedCount: envelope.data.count },
  };
}

export function decodeRetentionTiers(
  value: unknown,
): RetentionContractResult<RetentionTierCollection> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["tiers"]) ||
    !Array.isArray(value["tiers"])
  ) {
    return failure("invalid-envelope");
  }
  if (value["tiers"].length > RETENTION_RECORD_CAP) {
    return failure("too-many-records");
  }
  const items: RetentionTierRecord[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of value["tiers"].entries()) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(
        candidate,
        ["id", "name", "active", "createdAt", "updatedAt"],
        ["description", "stripePriceId"],
      )
    ) {
      return failure("invalid-record", index);
    }
    const id = parseUuid(candidate["id"]);
    const name = normalizedDisplayText(
      candidate["name"],
      MAX_TIER_NAME_BYTES,
      true,
    );
    const description = normalizedBodyText(
      candidate["description"],
      MAX_TIER_DESCRIPTION_BYTES,
    );
    const providerReference = optionalProviderReference(
      candidate["stripePriceId"],
    );
    const createdAt = parseIsoInstant(candidate["createdAt"]);
    const updatedAt = parseIsoInstant(candidate["updatedAt"]);
    if (
      !id ||
      typeof name !== "string" ||
      typeof candidate["active"] !== "boolean" ||
      description === false ||
      providerReference === null ||
      !createdAt ||
      !updatedAt ||
      Date.parse(updatedAt) < Date.parse(createdAt) ||
      (Object.prototype.hasOwnProperty.call(candidate, "description") &&
        description === null) ||
      (Object.prototype.hasOwnProperty.call(candidate, "stripePriceId") &&
        providerReference === false)
    ) {
      return failure("invalid-record", index);
    }
    if (ids.has(id)) return failure("duplicate-identity", index);
    ids.add(id);
    items.push({ id, name, active: candidate["active"] });
  }
  return { ok: true, data: { items } };
}

export function decodeRetentionWinbackSettings(
  value: unknown,
): RetentionContractResult<RetentionWinbackSettings> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "enabled",
      "churn_threshold",
      "churn_profiles_scored",
    ]) ||
    typeof value["enabled"] !== "boolean" ||
    typeof value["churn_threshold"] !== "number" ||
    !Number.isFinite(value["churn_threshold"]) ||
    value["churn_threshold"] <= 0 ||
    value["churn_threshold"] > 1 ||
    !isSafeInteger(value["churn_profiles_scored"], 0, MAX_EVENT_COUNT)
  ) {
    return failure("invalid-record");
  }
  return {
    ok: true,
    data: {
      enabled: value["enabled"],
      churnThreshold: value["churn_threshold"],
      churnProfilesScored: value["churn_profiles_scored"],
    },
  };
}

export function acceptanceRateOf(
  tile: RetentionFunnelTile | null,
): number | null {
  if (
    !tile ||
    tile.shown <= 0 ||
    tile.accepted + tile.declined + tile.expired > tile.shown
  ) {
    return null;
  }
  return tile.accepted / tile.shown;
}

function sumTiles(
  tiles: readonly RetentionFunnelTile[],
): RetentionFunnelTotals {
  return tiles.reduce<RetentionFunnelTotals>(
    (totals, tile) => ({
      shown: totals.shown + tile.shown,
      accepted: totals.accepted + tile.accepted,
      declined: totals.declined + tile.declined,
      expired: totals.expired + tile.expired,
    }),
    { shown: 0, accepted: 0, declined: 0, expired: 0 },
  );
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

/**
 * Reconcile the independently loaded offer and funnel endpoints.
 *
 * `tiles === null` means the endpoint is unavailable. A loaded empty array is
 * different: because the server LEFT JOINs from offers, every absent tile is a
 * consistency defect. Duplicate and tier-mismatched tiles are ambiguous and
 * therefore never attached to a row.
 */
export function reconcileRetentionHistory(
  offers: readonly RetentionOfferRecord[],
  tiles: readonly RetentionFunnelTile[] | null,
  tiers: readonly RetentionTierRecord[] = [],
): RetentionReconciliation {
  const tierNames = new Map(tiers.map((tier) => [tier.id, tier.name]));
  if (tiles === null) {
    return {
      rows: offers.map((offer) => ({
        offer,
        tierName: tierNames.get(offer.tierId) ?? null,
        funnel: null,
        funnelState: "unavailable",
      })),
      integrity: "unavailable",
      matchedTotals: { shown: 0, accepted: 0, declined: 0, expired: 0 },
      sourceTileCount: null,
      missingTileOfferIds: [],
      duplicateTileOfferIds: [],
      orphanTileOfferIds: [],
      tierMismatchOfferIds: [],
      outcomeExcessOfferIds: [],
    };
  }

  const offerIds = new Set(offers.map((offer) => offer.id));
  const groupedTiles = new Map<string, RetentionFunnelTile[]>();
  for (const tile of tiles) {
    const group = groupedTiles.get(tile.offerId) ?? [];
    group.push(tile);
    groupedTiles.set(tile.offerId, group);
  }

  const missing = new Set<string>();
  const duplicates = new Set<string>();
  const orphans = new Set<string>();
  const tierMismatches = new Set<string>();
  const outcomeExcess = new Set<string>();
  for (const [offerId, group] of groupedTiles) {
    if (!offerIds.has(offerId)) orphans.add(offerId);
    if (group.length > 1) duplicates.add(offerId);
  }

  const matched: RetentionFunnelTile[] = [];
  const rows = offers.map<RetentionOfferHistoryRow>((offer) => {
    const group = groupedTiles.get(offer.id) ?? [];
    const base = {
      offer,
      tierName: tierNames.get(offer.tierId) ?? null,
    };
    if (group.length === 0) {
      missing.add(offer.id);
      return { ...base, funnel: null, funnelState: "missing" };
    }
    if (group.length > 1) {
      return { ...base, funnel: null, funnelState: "duplicate" };
    }
    const tile = group[0];
    if (tile.tierId !== offer.tierId) {
      tierMismatches.add(offer.id);
      return { ...base, funnel: null, funnelState: "tier-mismatch" };
    }
    if (tile.accepted + tile.declined + tile.expired > tile.shown) {
      outcomeExcess.add(offer.id);
      return { ...base, funnel: tile, funnelState: "outcome-excess" };
    }
    matched.push(tile);
    return { ...base, funnel: tile, funnelState: "matched" };
  });

  const inconsistent =
    missing.size > 0 ||
    duplicates.size > 0 ||
    orphans.size > 0 ||
    tierMismatches.size > 0 ||
    outcomeExcess.size > 0;
  return {
    rows,
    integrity: inconsistent ? "inconsistent" : "reconciled",
    matchedTotals: sumTiles(matched),
    sourceTileCount: tiles.length,
    missingTileOfferIds: sorted(missing),
    duplicateTileOfferIds: sorted(duplicates),
    orphanTileOfferIds: sorted(orphans),
    tierMismatchOfferIds: sorted(tierMismatches),
    outcomeExcessOfferIds: sorted(outcomeExcess),
  };
}
