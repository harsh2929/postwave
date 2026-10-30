/**
 * Strict wire decoders for the retention-offer read surface.
 *
 * A malformed 2xx response is an error. It must never become a successful
 * empty catalogue, zero funnel, default win-back setting, or partial tier
 * index. Kept import-light so the contract remains testable under node.
 *
 * The field-level validators these compose — the bounds, the scalar checks and
 * the `{rows,count}` envelope check — live in the sibling
 * `retentionOffersWirePrimitives.ts`. `RetentionPayloadError` is re-exported
 * from here, where every caller already imports it.
 */
import type {
  RetentionFunnelTile,
  RetentionOffer,
  WinbackSettings,
} from "./retentionOffers";
import {
  bool,
  boundedString,
  countedRows,
  exactKeys,
  finiteNumber,
  instantMillis,
  integer,
  MAX_BODY_BYTES,
  MAX_EVENT_COUNT,
  MAX_HEADLINE_BYTES,
  MAX_PROVIDER_REFERENCE_BYTES,
  MAX_RETENTION_ROWS,
  MAX_TIER_DESCRIPTION_BYTES,
  MAX_TIER_NAME_BYTES,
  mismatch,
  optionalBoundedString,
  POSTGRES_INTEGER_MAX,
  record,
  rfc3339,
  uuid,
} from "./retentionOffersWirePrimitives";

export { RetentionPayloadError } from "./retentionOffersWirePrimitives";

/** `{offers:[…],count:n}` from `retention_offers.Deps.List`. */
export function normalizeRetentionOffers(
  raw: unknown,
  expectedTenantId?: string,
): RetentionOffer[] {
  const expectedTenant =
    expectedTenantId === undefined
      ? null
      : uuid(expectedTenantId, "$expectedTenantId");
  const rows = countedRows(raw, "offers");
  const offerIds = new Set<string>();
  const tierIds = new Set<string>();
  const tenantIds = new Set<string>();

  const offers = rows.map((row, index) => {
    const path = `$response.offers[${index}]`;
    exactKeys(
      row,
      path,
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
    );

    const id = uuid(row.id, `${path}.id`);
    const tenantId = uuid(row.tenant_id, `${path}.tenant_id`);
    const tierId = uuid(row.paywall_tier_id, `${path}.paywall_tier_id`);
    if (expectedTenant !== null && tenantId !== expectedTenant) {
      mismatch(`${path}.tenant_id`, "the active workspace tenant id");
    }
    if (offerIds.has(id))
      mismatch(`${path}.id`, "an offer id that appears once");
    if (tierIds.has(tierId)) {
      mismatch(`${path}.paywall_tier_id`, "a tier id that appears once");
    }
    offerIds.add(id);
    tierIds.add(tierId);
    tenantIds.add(tenantId);

    const hasPercent = Object.prototype.hasOwnProperty.call(row, "percent_off");
    const hasFixed = Object.prototype.hasOwnProperty.call(
      row,
      "fixed_off_cents",
    );
    if (hasPercent === hasFixed) {
      mismatch(path, "exactly one of percent_off or fixed_off_cents");
    }

    const createdAt = rfc3339(row.created_at, `${path}.created_at`);
    const updatedAt = rfc3339(row.updated_at, `${path}.updated_at`);
    if (
      instantMillis(updatedAt, `${path}.updated_at`) <
      instantMillis(createdAt, `${path}.created_at`)
    ) {
      mismatch(`${path}.updated_at`, "an instant at or after created_at");
    }
    const headline = optionalBoundedString(
      row,
      "headline",
      `${path}.headline`,
      MAX_HEADLINE_BYTES,
    );
    const couponId = optionalBoundedString(
      row,
      "stripe_coupon_id",
      `${path}.stripe_coupon_id`,
      MAX_PROVIDER_REFERENCE_BYTES,
    );
    // Body is not retained by the compact mobile model, but validating it
    // prevents a malformed full projection from masquerading as success.
    optionalBoundedString(row, "body", `${path}.body`, MAX_BODY_BYTES);

    return {
      id,
      tierId,
      percentOff: hasPercent
        ? integer(row.percent_off, `${path}.percent_off`, { min: 1, max: 100 })
        : null,
      fixedOffCents: hasFixed
        ? integer(row.fixed_off_cents, `${path}.fixed_off_cents`, {
            min: 1,
            max: POSTGRES_INTEGER_MAX,
          })
        : null,
      durationMonths: integer(row.duration_months, `${path}.duration_months`, {
        min: 1,
        max: 60,
      }),
      headline,
      couponId,
      active: bool(row.active, `${path}.active`),
      createdAt,
    };
  });

  if (tenantIds.size > 1) {
    mismatch("$response.offers", "rows from exactly one workspace tenant");
  }
  return offers;
}

/** `{tiles:[…],count:n}` from `retention_offers.Deps.Funnel`. */
export function normalizeRetentionFunnel(raw: unknown): RetentionFunnelTile[] {
  const rows = countedRows(raw, "tiles");
  const offerIds = new Set<string>();
  const tierIds = new Set<string>();

  return rows.map((row, index) => {
    const path = `$response.tiles[${index}]`;
    exactKeys(row, path, [
      "offer_id",
      "tier_id",
      "shown",
      "accepted",
      "declined",
      "expired",
      "acceptance_rate",
    ]);
    const offerId = uuid(row.offer_id, `${path}.offer_id`);
    const tierId = uuid(row.tier_id, `${path}.tier_id`);
    if (offerIds.has(offerId)) {
      mismatch(`${path}.offer_id`, "an offer id that appears once");
    }
    if (tierIds.has(tierId)) {
      mismatch(`${path}.tier_id`, "a tier id that appears once");
    }
    offerIds.add(offerId);
    tierIds.add(tierId);

    const shown = integer(row.shown, `${path}.shown`, {
      min: 0,
      max: MAX_EVENT_COUNT,
    });
    const accepted = integer(row.accepted, `${path}.accepted`, {
      min: 0,
      max: MAX_EVENT_COUNT,
    });
    const declined = integer(row.declined, `${path}.declined`, {
      min: 0,
      max: MAX_EVENT_COUNT,
    });
    const expired = integer(row.expired, `${path}.expired`, {
      min: 0,
      max: MAX_EVENT_COUNT,
    });
    const acceptanceRate = finiteNumber(
      row.acceptance_rate,
      `${path}.acceptance_rate`,
    );
    const expectedRate = shown === 0 ? 0 : accepted / shown;
    if (
      accepted > shown ||
      acceptanceRate < 0 ||
      acceptanceRate > 1 ||
      Math.abs(acceptanceRate - expectedRate) > 1e-12
    ) {
      mismatch(
        `${path}.acceptance_rate`,
        "a unit-interval rate equal to accepted / shown (or zero when unshown)",
      );
    }

    return { offerId, tierId, shown, accepted, declined, expired };
  });
}

/** Direct-object `WinbackSettings` wire shape. */
export function normalizeWinbackSettings(raw: unknown): WinbackSettings {
  const row = record(raw, "$response");
  exactKeys(row, "$response", [
    "enabled",
    "churn_threshold",
    "churn_profiles_scored",
  ]);
  const threshold = finiteNumber(
    row.churn_threshold,
    "$response.churn_threshold",
  );
  if (threshold <= 0 || threshold > 1) {
    mismatch("$response.churn_threshold", "a number in (0, 1]");
  }
  return {
    enabled: bool(row.enabled, "$response.enabled"),
    churnThreshold: threshold,
    churnProfilesScored: integer(
      row.churn_profiles_scored,
      "$response.churn_profiles_scored",
      { min: 0, max: MAX_EVENT_COUNT },
    ),
  };
}

/** `{tiers:[…]}` from `paywall.Deps.ListTiers`, reduced to id -> name. */
export function normalizePaywallTierNames(
  raw: unknown,
): Record<string, string> {
  const envelope = record(raw, "$response");
  exactKeys(envelope, "$response", ["tiers"]);
  if (
    !Array.isArray(envelope.tiers) ||
    envelope.tiers.length > MAX_RETENTION_ROWS
  ) {
    return mismatch(
      "$response.tiers",
      `an array of at most ${MAX_RETENTION_ROWS} records`,
    );
  }

  const out: Record<string, string> = {};
  for (const [index, candidate] of envelope.tiers.entries()) {
    const path = `$response.tiers[${index}]`;
    const row = record(candidate, path);
    exactKeys(
      row,
      path,
      ["id", "name", "active", "createdAt", "updatedAt"],
      ["description", "stripePriceId"],
    );
    const id = uuid(row.id, `${path}.id`);
    const name = boundedString(row.name, `${path}.name`, MAX_TIER_NAME_BYTES, {
      required: true,
    });
    bool(row.active, `${path}.active`);
    optionalBoundedString(
      row,
      "description",
      `${path}.description`,
      MAX_TIER_DESCRIPTION_BYTES,
    );
    optionalBoundedString(
      row,
      "stripePriceId",
      `${path}.stripePriceId`,
      MAX_PROVIDER_REFERENCE_BYTES,
    );
    const createdAt = rfc3339(row.createdAt, `${path}.createdAt`);
    const updatedAt = rfc3339(row.updatedAt, `${path}.updatedAt`);
    if (
      instantMillis(updatedAt, `${path}.updatedAt`) <
      instantMillis(createdAt, `${path}.createdAt`)
    ) {
      mismatch(`${path}.updatedAt`, "an instant at or after createdAt");
    }
    if (Object.prototype.hasOwnProperty.call(out, id)) {
      mismatch(`${path}.id`, "a tier id that appears only once");
    }
    out[id] = name;
  }
  return out;
}
