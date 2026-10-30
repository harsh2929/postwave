/**
 * lib/retentionOffers.ts — parsing and judging the cancel-flow save-offer
 * funnel.
 *
 * WHAT THIS SUBSYSTEM ACTUALLY IS, read from the Go source rather than a doc.
 * `apps/api/internal/retention_offers` implements Ghost-style cancel-flow save
 * offers: one offer per paywall tier, and an append-only event log
 * (`retention_offer_events`, migration 0306) carrying recorded shown /
 * accepted / declined / expired counters.
 *
 * THE THREE FACTS THAT SHAPE EVERY DECISION IN HERE — each one verified in the
 * server source, because getting any of them wrong turns this screen into a
 * confident liar:
 *
 *  1. THE SURFACE IS READ-ONLY, AND NOT BY MOBILE'S CHOICE. `Deps.MountRoutes`
 *     in `retention_offers/handlers.go` registers exactly three GETs:
 *     `/retention-offers`, `/retention-offers/funnel`,
 *     `/retention-offers/winback-settings`. `Upsert`, `Deactivate`, `LogEvent`
 *     and the three portal handlers are WRITTEN but
 *     mounted nowhere — `grep -rn "retention_offers\." apps/api` outside the
 *     package returns only the two main.go lines that build Deps and mount
 *     those three GETs. The package's own header says why: "Paid
 *     retention-offer mutations and portal acceptance remain unmounted until a
 *     real Stripe adapter and reconciliation are certified."
 *
 *  2. EVERY ROUTE IS OWNER|ADMIN, AND THE GUARD IS INVISIBLE FROM THE HANDLER.
 *     The main composition mounts the three reads with
 *     `apikeys.RequireExactTenantAdmin`. Reading handlers.go alone would have
 *     said "ungated", so both navigation and each query fail closed first.
 *
 *  3. A MISSING FUNNEL IS NOT A ZERO FUNNEL. The offers list and the funnel
 *     are two independent reads. When the funnel read fails, "0 shown / 0
 *     accepted" is indistinguishable from a genuinely unused offer, and an
 *     operator would conclude a delivery path is active. The desktop learnt
 *     this the hard way (D11-commerce-growth#9, desktop `RetentionOffers`) and
 *     renders an em-dash instead; so does this. `funnel: null` on a row means
 *     UNKNOWN and never zero.
 *
 * DELIBERATELY PLATFORM-FREE so it runs under the node vitest environment.
 * Strict wire decoding lives in the sibling `retentionOffersWire` module.
 */
import { num } from "@/lib/format";

/** One row of `retention_offers`, as the server's `Offer` type. */
export interface RetentionOffer {
  id: string;
  /** `paywall_tier_id` — a UUID; the tier NAME comes from a separate read. */
  tierId: string;
  /** Percent XOR fixed is enforced by a CHECK in migration 0306. */
  percentOff: number | null;
  fixedOffCents: number | null;
  durationMonths: number;
  headline: string;
  /** "" when the offer was never mirrored into Stripe. Load-bearing — see
   *  `retentionObservations`. */
  couponId: string;
  active: boolean;
  createdAt: string;
}

/** One row of the funnel rollup, as the server's `FunnelTile` type. */
export interface RetentionFunnelTile {
  offerId: string;
  tierId: string;
  shown: number;
  accepted: number;
  declined: number;
  expired: number;
}

/** The server's `WinbackSettings` read model. */
export interface WinbackSettings {
  enabled: boolean;
  churnThreshold: number;
  /** Rows in `profile_predictions`. 0 means the model has not scored anyone. */
  churnProfilesScored: number;
}

export interface RetentionFunnelTotals {
  shown: number;
  accepted: number;
  declined: number;
  expired: number;
}

/** An offer joined to its funnel tile and (when known) its tier name. */
export interface RetentionOfferRow {
  offer: RetentionOffer;
  /** null = the funnel is UNKNOWN for this offer, never "zero events". */
  funnel: RetentionFunnelTile | null;
  /** null = the tier read did not resolve a name; render the id instead. */
  tierName: string | null;
}

export {
  normalizePaywallTierNames,
  normalizeRetentionFunnel,
  normalizeRetentionOffers,
  normalizeWinbackSettings,
  RetentionPayloadError,
} from "./retentionOffersWire";

/**
 * Acceptance rate as a ratio, or null when nothing was ever shown or the
 * recorded outcomes exceed showings.
 *
 * Recomputed from the two integers rather than read off `acceptance_rate`.
 * The server's `LoadFunnel` assigns that field only when `t.Shown > 0`, so the
 * wire carries a plain `0` for
 * "no denominator" — which renders as a damning "0% acceptance" for an offer
 * nobody has ever been shown. Deriving it here makes the missing case
 * unrepresentable.
 */
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

export function funnelTotals(
  tiles: readonly RetentionFunnelTile[],
): RetentionFunnelTotals {
  return tiles.reduce<RetentionFunnelTotals>(
    (acc, tile) => ({
      shown: acc.shown + tile.shown,
      accepted: acc.accepted + tile.accepted,
      declined: acc.declined + tile.declined,
      expired: acc.expired + tile.expired,
    }),
    { shown: 0, accepted: 0, declined: 0, expired: 0 },
  );
}

/**
 * Join offers to their tiles.
 *
 * `tiles === null` means the funnel read did not land, and EVERY row's funnel
 * is then null — not zero. A row whose offer has no matching tile is also
 * null: `LoadFunnel` LEFT JOINs from `retention_offers` so every offer should
 * have one, which makes a missing tile evidence that the two reads disagree,
 * and the honest rendering of a disagreement is "unknown".
 */
export function joinOffersToFunnel(
  offers: readonly RetentionOffer[],
  tiles: readonly RetentionFunnelTile[] | null,
  tierNames: Record<string, string> = {},
): RetentionOfferRow[] {
  const byOffer = new Map<string, RetentionFunnelTile>();
  for (const tile of tiles ?? []) byOffer.set(tile.offerId, tile);
  return offers.map((offer) => ({
    offer,
    funnel: tiles === null ? null : (byOffer.get(offer.id) ?? null),
    tierName: tierNames[offer.tierId] ?? null,
  }));
}

export type RetentionAmountKind = "percent" | "fixed" | "none";

export interface RetentionAmount {
  kind: RetentionAmountKind;
  /** What the row prints. */
  label: string;
  /** What VoiceOver says — expands the missing-currency caveat. */
  spoken: string;
}

/**
 * The discount an offer carries.
 *
 * RAW MINOR UNITS on the fixed branch, and that is deliberate. Migration
 * 0306 stores `fixed_off_cents INTEGER` with no currency column and the wire
 * shape (`Offer`, retention_offers.go) carries none either. The dormant server
 * formatter now declines to produce a fixed-amount label without currency.
 * Dividing by 100 here would still assume a currency's precision, so the only
 * honest visible unit is the stored minor-unit count.
 */
export function offerAmount(offer: RetentionOffer): RetentionAmount {
  if (offer.percentOff !== null && offer.percentOff > 0) {
    return {
      kind: "percent",
      label: `${offer.percentOff}% off`,
      spoken: `${offer.percentOff} percent off`,
    };
  }
  if (offer.fixedOffCents !== null && offer.fixedOffCents > 0) {
    const minorUnits = num(offer.fixedOffCents);
    return {
      kind: "fixed",
      label: `${minorUnits} minor units off`,
      spoken: `${minorUnits} minor units off; this record does not identify the billing currency`,
    };
  }
  return {
    kind: "none",
    label: "No discount recorded",
    spoken: "No discount recorded on this offer",
  };
}

/** `duration_months` is a literal month count, not an inferred billing cycle. */
export function durationLabel(offer: RetentionOffer): string {
  return offer.durationMonths === 1
    ? "1 month"
    : `${offer.durationMonths} months`;
}

export type RetentionObservationTone = "attention" | "info" | "good";

export interface RetentionObservation {
  id: string;
  tone: RetentionObservationTone;
  text: string;
}

/**
 * What an operator would notice if they read the whole screen carefully.
 *
 * Every line is derived from a fact on the wire and states only what that fact
 * supports. In particular there is NO "acceptance rate is low" judgement:
 * no mounted runtime currently records an acceptance, so a low historical rate
 * says nothing about current offer delivery.
 */
export function retentionObservations(input: {
  offers: readonly RetentionOffer[];
  /** null = funnel unknown. */
  tiles: readonly RetentionFunnelTile[] | null;
  /** null = win-back settings unknown. */
  winback: WinbackSettings | null;
}): RetentionObservation[] {
  const out: RetentionObservation[] = [];
  const active = input.offers.filter((offer) => offer.active);

  if (input.offers.length > 0 && active.length === 0) {
    out.push({
      id: "no-active-offer",
      tone: "attention",
      text: "No stored offer row is marked active. This release does not mount offer presentation or delivery.",
    });
  }

  // An active offer with no mirrored coupon cannot complete an acceptance:
  // `AcceptOffer` returns ErrProviderReferenceRequired when
  // `stripe_coupon_id` is blank.
  const unmirrored = active.filter((offer) => offer.couponId === "").length;
  if (unmirrored > 0) {
    out.push({
      id: "no-coupon-mirrored",
      tone: "attention",
      text:
        unmirrored === 1
          ? "1 offer marked active has no Stripe coupon on record; coupon application is unavailable and cannot be inferred."
          : `${unmirrored} offers marked active have no Stripe coupon on record; coupon application is unavailable and cannot be inferred.`,
    });
  }

  if (input.tiles !== null && active.length > 0) {
    const totals = funnelTotals(input.tiles);
    if (totals.shown === 0) {
      out.push({
        id: "never-shown",
        tone: "attention",
        text: "No recorded shown event exists for the stored active offers.",
      });
    } else if (totals.accepted > 0) {
      out.push({
        id: "accepted",
        tone: "good",
        text:
          totals.accepted === 1
            ? "The historical funnel contains 1 recorded accepted outcome."
            : `The historical funnel contains ${totals.accepted} recorded accepted outcomes.`,
      });
    }
  }

  if (input.winback?.enabled && input.winback.churnProfilesScored === 0) {
    out.push({
      id: "winback-unscored",
      tone: "attention",
      text: "The stored win-back switch is enabled, but no churn-scored profiles are recorded. Runtime dispatch remains release-held and unavailable.",
    });
  }

  return out;
}

/**
 * A 403 on this surface is an ANSWER, not a fault: every route is
 * protected at composition time by `RequireExactTenantAdmin`, so a viewer or
 * editor session gets one on all three reads and there is no read-scoped
 * alternative. Rendering "no retention offers" there would invent a fact
 * about the workspace.
 */
export function isRetentionScopeDenied(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return Number((err as { status?: unknown }).status) === 403;
}
