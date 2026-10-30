/**
 * lib/dashboardInsights.ts — plain-language observations derived from figures
 * the dashboard has already fetched.
 *
 * There is no endpoint behind this and there should not be: `?compare=true`
 * already returns the previous window beside the current one, so every
 * observation here is arithmetic over a payload the screen is holding. Prose
 * scales down to a phone far better than a chart does — this is the one
 * analytics form the small screen is genuinely better at.
 *
 * THE HARD PART IS SAYING NOTHING. An insights strip that fires every day
 * trains the reader to skip the region on the day it matters, which is the same
 * reasoning that makes `AnomalyHistoryCard` render nothing on a healthy
 * workspace. So a movement must clear BOTH gates to be reported:
 *
 *  - a RELATIVE gate, so a 0.2pp wobble on a 24% open rate is not news;
 *  - an ABSOLUTE gate, so a rate going from 0.1% to 0.2% is not "up 100%".
 *
 * Counts get the relative gate plus a floor on the previous window, because
 * "campaigns sent doubled" is meaningless when the previous window was one.
 *
 * Import-free: pure arithmetic over numbers, formatted by the caller. The
 * strings are assembled here so the phrasing is tested rather than eyeballed.
 */

export interface InsightInput {
  /** Reporting-window label, e.g. "Last 30 days". Used in the copy. */
  rangeLabel: string;
  openRate: number | null;
  previousOpenRate: number | null;
  clickRate: number | null;
  previousClickRate: number | null;
  bounceRate: number | null;
  previousBounceRate: number | null;
  /** Net subscriber change over the window (adds − unsubs). */
  subscribersDelta: number | null;
  previousSubscribersDelta: number | null;
  campaignsSent: number | null;
  previousCampaignsSent: number | null;
}

export type InsightTone = "positive" | "negative" | "neutral";

export interface Insight {
  id: string;
  tone: InsightTone;
  /** One sentence. Complete, and safe to read aloud on its own. */
  text: string;
}

/** A rate must move at least this much RELATIVE to its previous value. */
export const RATE_RELATIVE_GATE = 0.15;
/** …and at least this much in absolute percentage points (0.005 = 0.5pp). */
export const RATE_ABSOLUTE_GATE = 0.005;
/** A count must move at least this much relative to its previous value. */
export const COUNT_RELATIVE_GATE = 0.25;
/** …over a previous window of at least this size, or the ratio is noise. */
export const COUNT_FLOOR = 3;
/** The strip shows at most this many observations. */
export const MAX_INSIGHTS = 3;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function movedRate(
  current: number | null,
  previous: number | null,
): { relative: number; absolute: number } | null {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }
  const absolute = current - previous;
  const relative = absolute / previous;
  if (
    Math.abs(relative) < RATE_RELATIVE_GATE ||
    Math.abs(absolute) < RATE_ABSOLUTE_GATE
  ) {
    return null;
  }
  return { relative, absolute };
}

function movedCount(
  current: number | null,
  previous: number | null,
): { relative: number; absolute: number } | null {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous < COUNT_FLOOR
  ) {
    return null;
  }
  const absolute = current - previous;
  const relative = absolute / previous;
  if (Math.abs(relative) < COUNT_RELATIVE_GATE) return null;
  return { relative, absolute };
}

/**
 * The observations worth printing, most important first.
 *
 * Order is fixed by CONSEQUENCE, not by magnitude: a bounce-rate rise outranks
 * a bigger open-rate rise because one of them threatens the sending domain and
 * the other does not. A strip sorted by percentage would bury the incident
 * under the good news.
 */
export function dashboardInsights(input: InsightInput): Insight[] {
  const out: Insight[] = [];
  const window = input.rangeLabel.toLowerCase();

  const bounce = movedRate(input.bounceRate, input.previousBounceRate);
  if (bounce && input.bounceRate !== null && input.previousBounceRate !== null) {
    out.push({
      id: "bounce",
      // Bounces rising is bad news even when the arrow points up.
      tone: bounce.relative > 0 ? "negative" : "positive",
      text:
        bounce.relative > 0
          ? `Bounce rate rose to ${pct(input.bounceRate)} from ${pct(input.previousBounceRate)} — worth checking list quality before the next send.`
          : `Bounce rate improved to ${pct(input.bounceRate)} from ${pct(input.previousBounceRate)}.`,
    });
  }

  const click = movedRate(input.clickRate, input.previousClickRate);
  if (click && input.clickRate !== null && input.previousClickRate !== null) {
    out.push({
      id: "click",
      tone: click.relative > 0 ? "positive" : "negative",
      text: `Click rate ${click.relative > 0 ? "rose" : "fell"} to ${pct(input.clickRate)} from ${pct(input.previousClickRate)} over the previous ${window}.`,
    });
  }

  const open = movedRate(input.openRate, input.previousOpenRate);
  if (open && input.openRate !== null && input.previousOpenRate !== null) {
    out.push({
      id: "open",
      tone: open.relative > 0 ? "positive" : "negative",
      text: `Open rate ${open.relative > 0 ? "rose" : "fell"} to ${pct(input.openRate)} from ${pct(input.previousOpenRate)}. Apple Mail privacy inflates opens, so read it beside clicks.`,
    });
  }

  const growth = movedCount(
    input.subscribersDelta,
    input.previousSubscribersDelta,
  );
  if (
    growth &&
    input.subscribersDelta !== null &&
    input.previousSubscribersDelta !== null
  ) {
    out.push({
      id: "growth",
      tone: growth.relative > 0 ? "positive" : "negative",
      text: `Net subscriber growth ${growth.relative > 0 ? "sped up" : "slowed"} to ${input.subscribersDelta} from ${input.previousSubscribersDelta} in the previous ${window}.`,
    });
  }

  const sent = movedCount(input.campaignsSent, input.previousCampaignsSent);
  if (sent && input.campaignsSent !== null && input.previousCampaignsSent !== null) {
    out.push({
      id: "volume",
      // Sending more or less is a choice, not an outcome: it is context for
      // the rates above and must not be coloured as a win or a loss.
      tone: "neutral",
      text: `You sent ${input.campaignsSent} campaigns, against ${input.previousCampaignsSent} in the previous ${window}.`,
    });
  }

  return out.slice(0, MAX_INSIGHTS);
}
