/**
 * lib/campaignEngagement.ts — which engagement numbers the report screen may
 * actually show.
 *
 * THE TRAP THIS MODULE EXISTS FOR. The Go report always serialises the nine
 * `human_*` fields (apps/api/internal/analytics/analytics.go CampaignReport —
 * no `omitempty`), and they are all **zero** unless the backend env flag
 * `POSTWAVE_HUMAN_ENGAGEMENT` is set to "true", which it is NOT by default
 * (apps/api/main.go:2637). So on a stock deployment the wire says:
 *
 *   { "open_rate": 0.41, "human_open_rate": 0, "bot_signatures_applied": [] }
 *
 * A presence test of the form `typeof r.human_open_rate === "number"` is
 * therefore ALWAYS true, and `r.human_opens ?? r.opens` never falls back —
 * `??` only fires on null/undefined, not on 0. A screen that defaults to the
 * human figures under those two mistakes renders "0.0% open rate" for every
 * campaign that ever sent. That is the exact failure mode a report screen must
 * never have: a confident, wrong, empty number.
 *
 * The gate is therefore EVIDENCE-BASED, matching the contract desktop's
 * api-client documents verbatim ("the toggle … gates on
 * `bot_signatures_applied > 0 || human_opens > 0` to stay stable across the
 * flag flip"): only when the server proves it actually stripped something may
 * the human figures be shown or defaulted to.
 */
import type { CampaignReport } from "@/hooks/useCampaigns";

export type EngagementMode = "human" | "raw";

export interface EngagementFigures {
  opens: number | undefined;
  uniqueOpens: number | undefined;
  uniqueClicks: number | undefined;
  openRate: number | undefined;
  clickRate: number | undefined;
  /** unique_clicks ÷ unique_opens, already scaled to 0..100 by the server. */
  clickToOpenRate: number | undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * True only when the server actually computed MPP-stripped figures.
 *
 * Deliberately NOT a presence check: the fields are always present on the
 * wire and are zero when the feature is off.
 */
export function hasHumanEngagement(
  report: CampaignReport | null | undefined,
): boolean {
  if (!report) return false;
  const signatures = Array.isArray(report.bot_signatures_applied)
    ? report.bot_signatures_applied
    : [];
  if (signatures.length > 0) return true;
  return (
    count(report.human_opens) > 0 ||
    count(report.human_unique_opens) > 0 ||
    count(report.human_clicks) > 0 ||
    count(report.human_unique_clicks) > 0
  );
}

/**
 * The mode that may actually be rendered. A "human" preference on a report
 * with no human data degrades to raw rather than to zeroes — the toggle is
 * hidden in that case, so the user is never shown a control that disagrees
 * with what they are reading.
 */
export function effectiveEngagementMode(
  report: CampaignReport | null | undefined,
  preferred: EngagementMode,
): EngagementMode {
  return preferred === "human" && hasHumanEngagement(report) ? "human" : "raw";
}

/**
 * Pick the figures for a mode. `mode` must already be the EFFECTIVE mode; the
 * per-field `??` fallbacks here only cover an older gateway that omits a
 * single field entirely, never the flag-off all-zeroes case (which
 * effectiveEngagementMode has already routed to "raw").
 */
export function engagementFigures(
  report: CampaignReport | null | undefined,
  mode: EngagementMode,
): EngagementFigures {
  if (!report) {
    return {
      opens: undefined,
      uniqueOpens: undefined,
      uniqueClicks: undefined,
      openRate: undefined,
      clickRate: undefined,
      clickToOpenRate: undefined,
    };
  }
  if (mode === "raw") {
    return {
      opens: report.opens,
      uniqueOpens: report.unique_opens,
      uniqueClicks: report.unique_clicks,
      openRate: report.open_rate,
      clickRate: report.click_rate,
      clickToOpenRate: report.click_to_open_rate,
    };
  }
  return {
    opens: report.human_opens ?? report.opens,
    uniqueOpens: report.human_unique_opens ?? report.unique_opens,
    uniqueClicks: report.human_unique_clicks ?? report.unique_clicks,
    openRate: report.human_open_rate ?? report.open_rate,
    clickRate: report.human_click_rate ?? report.click_rate,
    clickToOpenRate:
      report.human_click_to_open_rate ?? report.click_to_open_rate,
  };
}

/**
 * The three rates the report ships and the phone never rendered:
 * click-to-open, bounce rate and unsubscribe rate.
 *
 * A ZERO HERE IS USUALLY "NO DENOMINATOR", AND THAT IS THE WHOLE POINT OF THIS
 * FUNCTION. The Go builder guards each rate with its denominator and simply
 * leaves the field at its zero value when the guard fails
 * (analytics.go:359-369):
 *
 *   open/click/unsub  computed only when delivered-or-sent > 0
 *   bounce            computed only when sent > 0
 *   click-to-open     computed only when unique_opens > 0
 *
 * So a campaign nobody opened reports `click_to_open_rate: 0`, which is
 * indistinguishable on the wire from "of the people who opened it, none
 * clicked". Printing "0.0%" asserts the second. Reconstructing the server's
 * own guard from the counts — which are in the same payload — lets the screen
 * render an em-dash for the first, which is what it actually knows.
 *
 * `figures` must be the EFFECTIVE mode's figures: the human click-to-open rate
 * has a human denominator (analytics.go:518), so checking the raw
 * `unique_opens` would show a rate whose denominator is a different number.
 */
export interface ReportRates {
  /** Null when the rate has no denominator, never 0. */
  clickToOpen: number | null;
  bounce: number | null;
  unsub: number | null;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function rateOrNull(value: unknown, hasDenominator: boolean): number | null {
  if (!hasDenominator) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function reportRates(
  report: CampaignReport | null | undefined,
  figures: EngagementFigures,
): ReportRates {
  if (!report) return { clickToOpen: null, bounce: null, unsub: null };
  // The same fallback the Go builder uses: legacy send paths emit `sent`
  // without a separate `delivered`, and treating that as a zero denominator
  // would blank the unsubscribe rate for every one of those campaigns.
  const deliveredOrSent = positive(report.delivered)
    ? report.delivered
    : report.sent;
  return {
    clickToOpen: rateOrNull(
      figures.clickToOpenRate,
      positive(figures.uniqueOpens),
    ),
    bounce: rateOrNull(report.bounce_rate, positive(report.sent)),
    unsub: rateOrNull(report.unsub_rate, positive(deliveredOrSent)),
  };
}

/** Caption under the Human/Raw toggle, naming what was subtracted. */
export function engagementCaption(
  report: CampaignReport | null | undefined,
  mode: EngagementMode,
): string {
  if (mode === "raw") {
    return "Raw counts, including Apple Mail Privacy Protection opens.";
  }
  const signatures = Array.isArray(report?.bot_signatures_applied)
    ? report.bot_signatures_applied
    : [];
  const applied =
    signatures.length > 0
      ? ` (${signatures.length} signature${signatures.length === 1 ? "" : "s"} applied)`
      : "";
  return `Machine opens removed${applied} — this matches the desktop default.`;
}
