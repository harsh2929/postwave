/**
 * lib/attributionVerdict.ts — the judgements the conversions monitor makes,
 * and the disclosures that keep each one honest.
 *
 * Split from `lib/conversionAttribution` (which owns the shapes) so the parsing
 * and the opinions are separately readable and separately testable. Every
 * function here corresponds to one of the six server facts documented at the
 * top of that module; if a function has no matching fact, it is inventing one.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */
import type {
  AttributionProvenance,
  CampaignAttribution,
  CurrencyTotal,
} from "@/lib/conversionAttribution";

/** Cents → whole currency units, for `money()` at the render edge. */
export function centsToUnits(cents: number): number {
  return cents / 100;
}

export interface AttributionCoverage {
  /** Dominant-currency revenue the server could tie to a campaign. */
  attributedCents: number;
  unattributedCents: number;
  totalCents: number;
  /**
   * Attributed share of dominant-currency revenue, or null when the window
   * holds no dominant-currency revenue at all — a share of nothing is not 0%,
   * it is undefined, and printing 0% would claim total attribution failure.
   */
  attributedShare: number | null;
}

export function attributionCoverage(
  data: CampaignAttribution,
): AttributionCoverage {
  const total = data.totalRevenueCents;
  // Clamped: the two figures come from two separate queries over the same
  // window, so a negative would mean the payload is internally inconsistent,
  // and a negative "attributed revenue" is worse than a conservative zero.
  const attributed = Math.max(0, total - data.unattributedCents);
  return {
    attributedCents: attributed,
    unattributedCents: data.unattributedCents,
    totalCents: total,
    attributedShare: total > 0 ? attributed / total : null,
  };
}

export interface ProvenanceShares {
  explicit: number;
  lastTouch: number;
  none: number;
  codeRedemption: number;
  campaignVanityPath: number;
  unclassified: number;
}

/** Fractions of every conversion in the window, or null when there were none. */
export function provenanceShares(
  provenance: AttributionProvenance,
): ProvenanceShares | null {
  if (provenance.total <= 0) return null;
  return {
    explicit: provenance.explicit / provenance.total,
    lastTouch: provenance.lastTouch / provenance.total,
    none: provenance.none / provenance.total,
    codeRedemption: provenance.codeRedemption / provenance.total,
    campaignVanityPath: provenance.campaignVanityPath / provenance.total,
    unclassified: provenance.unclassified / provenance.total,
  };
}

/**
 * The sentence that stops last-touch reading as certainty.
 *
 * Returned whenever ANY conversion in the window was attributed by the
 * heuristic — including when it is the minority, because the revenue figure
 * above it silently includes those conversions either way.
 */
export function lastTouchNotice(
  provenance: AttributionProvenance,
): string | null {
  if (provenance.lastTouch <= 0) return null;
  return `${provenance.lastTouch} of these conversions were matched to a campaign by last touch — the server joined them to the subscriber's most recent click in the previous 7 days. That is a heuristic, not a tag the conversion carried.`;
}

/** Pre-backfill rows. A separate fact from "unattributed", never merged. */
export function unclassifiedNotice(
  provenance: AttributionProvenance,
): string | null {
  if (provenance.unclassified <= 0) return null;
  return `${provenance.unclassified} conversions predate attribution recording and have not been classified yet. They are neither attributed nor known to be unattributed — an owner can drain this by running the backfill on the web admin.`;
}

/** Every currency whose money is NOT in the revenue figures. */
export function excludedCurrencies(
  data: CampaignAttribution,
): CurrencyTotal[] {
  return data.currencies.filter((row) => row.currency !== data.currency);
}

/**
 * What the headline revenue leaves out. Returns null when nothing is excluded.
 *
 * The empty-string currency gets a name rather than a blank: `currencyTotals`
 * COALESCEs a missing currency code to '', so those rows are real money whose
 * denomination nobody recorded.
 */
export function excludedCurrencyNotice(
  data: CampaignAttribution,
): string | null {
  const excluded = excludedCurrencies(data);
  if (excluded.length === 0) return null;
  const parts = excluded.map((row) => {
    const name = row.currency || "no currency recorded";
    return `${(row.revenueCents / 100).toFixed(2)} ${name}`;
  });
  return `Revenue above is in ${data.currency || "the dominant currency"} only. Also in this window: ${parts.join(", ")} — excluded from every figure on this screen, exactly as the server excludes them.`;
}

/**
 * "Top 50 of M". Returns null when the list IS the whole picture.
 *
 * Detected from the rolled-up row rather than from a hardcoded 50: the cap is
 * the server's constant and could move without this client shipping again.
 */
export function rollupNotice(data: CampaignAttribution): string | null {
  const named = data.items.filter((item) => !item.isRollup).length;
  if (data.totalCampaigns <= named) return null;
  return `Showing the top ${named} of ${data.totalCampaigns} campaigns with attributed conversions. The rest are summed into one row so the totals stay exact.`;
}

export type AttributionTone = "ok" | "warn" | "idle";

export interface AttributionVerdict {
  tone: AttributionTone;
  headline: string;
  detail: string;
}

/**
 * Below this attributed share the screen says so plainly. Attribution is never
 * complete — direct traffic exists — but under half means the revenue-by-
 * campaign list below is a minority report and should be read as one.
 */
const LOW_COVERAGE_SHARE = 0.5;

/**
 * The one sentence the screen exists to produce.
 *
 * NOTE THE TWO SEPARATE "NOTHING" CASES. A window with no conversions at all is
 * different from a window with conversions that carried no money, and both are
 * different from money the server could not attribute. Collapsing them would
 * tell an operator whose non-monetary signup events are firing perfectly that
 * their tracking is dead.
 */
export function attributionVerdict(
  data: CampaignAttribution | null,
  days: number,
): AttributionVerdict {
  const period = `${days} days`;
  if (!data) {
    return {
      tone: "idle",
      headline: "No reading yet",
      detail: `Nothing has been read for the last ${period}.`,
    };
  }
  if (data.provenance.total === 0) {
    return {
      tone: "idle",
      headline: `No conversions in the last ${period}`,
      detail:
        "Nothing has been reported to the conversion endpoint in this window. That is silence from the tracking script, not a zero revenue result.",
    };
  }
  if (!data.hasMonetary) {
    return {
      tone: "idle",
      headline: `${data.provenance.total} conversions, none carrying an amount`,
      detail: `In the last ${period}. Every conversion in this window was reported without a monetary value, so there is no revenue to attribute.`,
    };
  }
  const coverage = attributionCoverage(data);
  if (coverage.attributedShare !== null && coverage.attributedShare < LOW_COVERAGE_SHARE) {
    return {
      tone: "warn",
      headline: "Most revenue is not attributed to a campaign",
      detail: `In the last ${period} the server could tie ${Math.round(coverage.attributedShare * 100)}% of ${data.currency || "dominant-currency"} revenue to a campaign. The rest arrived with no campaign tag and no click in the 7-day last-touch window.`,
    };
  }
  return {
    tone: "ok",
    headline: `Revenue attributed across ${data.totalCampaigns} campaigns`,
    detail: `In the last ${period}, in ${data.currency || "the dominant currency"}. Conversions with no campaign are reported separately and never folded into a campaign's total.`,
  };
}
