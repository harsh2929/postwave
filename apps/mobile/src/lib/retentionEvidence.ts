/**
 * lib/retentionEvidence.ts — the reconciliation verdict behind one retention
 * offer's funnel numbers.
 *
 * Ported from desktop's RetentionOfferDetail + retention-offers-contract
 * (classification at contract.ts:574-589, labels at RetentionOfferDetail
 * .tsx:23-42). The server sends plain counter tiles and no verdict; the
 * verdict is a CLIENT judgement about whether those counters can be trusted:
 *
 *   missing        — no tile for this offer at all
 *   duplicate      — more than one tile claims this offer
 *   tier-mismatch  — the tile's tier is not the offer's tier
 *   outcome-excess — accepted+declined+expired exceed shown
 *   matched        — none of the above; the counters reconcile
 *   unavailable    — the funnel read itself did not resolve
 *
 * Only `matched` earns an acceptance rate. The server's own `acceptance_rate`
 * field is deliberately never used (desktop contract.ts:74-77): a rate
 * computed from counters that do not reconcile is a confident number about
 * nothing.
 *
 * Import-free apart from the sibling types; node-tested.
 */
import type {
  RetentionFunnelTile,
  RetentionOffer,
} from "./retentionOffers";

export type RetentionFunnelState =
  | "matched"
  | "duplicate"
  | "tier-mismatch"
  | "outcome-excess"
  | "missing"
  | "unavailable";

/** Desktop's classification, verbatim in priority order. */
export function classifyRetentionFunnel(
  offer: Pick<RetentionOffer, "id" | "tierId">,
  tiles: readonly RetentionFunnelTile[] | null,
): RetentionFunnelState {
  if (tiles === null) return "unavailable";
  const matches = tiles.filter((tile) => tile.offerId === offer.id);
  if (matches.length === 0) return "missing";
  if (matches.length > 1) return "duplicate";
  const tile = matches[0];
  if (!tile) return "missing";
  if (tile.tierId !== offer.tierId) return "tier-mismatch";
  if (tile.accepted + tile.declined + tile.expired > tile.shown) {
    return "outcome-excess";
  }
  return "matched";
}

/** Desktop's evidenceLabel copy, with the in-flight short-circuit. */
export function retentionEvidenceLabel(
  state: RetentionFunnelState,
  pending: boolean,
): string {
  if (pending) return "Reconciliation in progress";
  switch (state) {
    case "matched":
      return "Reconciled counters";
    case "outcome-excess":
      return "Outcome-count conflict";
    case "duplicate":
      return "Duplicate funnel records";
    case "tier-mismatch":
      return "Tier mismatch";
    case "missing":
      return "Funnel record missing";
    case "unavailable":
      return "Funnel unavailable";
  }
}

/** What each verdict means for the person reading it, in one sentence. */
export function retentionEvidenceExplanation(
  state: RetentionFunnelState,
): string {
  switch (state) {
    case "matched":
      return "The event counters reconcile, so the funnel numbers and the acceptance rate can be read at face value.";
    case "outcome-excess":
      return "More outcomes (accepted + declined + expired) than showings were recorded — the counters conflict, so no rate is computed from them.";
    case "duplicate":
      return "More than one funnel record claims this offer, so it is ambiguous which counters are real. The rows below are shown unverified.";
    case "tier-mismatch":
      return "The funnel record points at a different paywall tier than this offer — its counters may belong to something else.";
    case "missing":
      return "No funnel record exists for this offer. Either it has never been shown, or its events were recorded against something else.";
    case "unavailable":
      return "The funnel read didn't resolve, so nothing can be said about this offer's counters — that is not the same as zero.";
  }
}

/** The pill tone behind the verdict — the WORD stays the primary channel. */
export function retentionEvidenceTone(
  state: RetentionFunnelState,
  pending: boolean,
): "neutral" | "success" | "warning" {
  if (pending) return "neutral";
  if (state === "matched") return "success";
  if (state === "unavailable" || state === "missing") return "neutral";
  return "warning";
}

/**
 * accepted / shown, ONLY from a matched tile with a real denominator —
 * desktop's `acceptanceRateOf` guard (contract.ts:483-494).
 */
export function trustedAcceptanceRate(
  state: RetentionFunnelState,
  tile: RetentionFunnelTile | null,
): number | null {
  if (state !== "matched" || tile === null) return null;
  if (tile.shown <= 0) return null;
  if (tile.accepted + tile.declined + tile.expired > tile.shown) return null;
  return tile.accepted / tile.shown;
}
