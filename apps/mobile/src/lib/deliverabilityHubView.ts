/**
 * deliverabilityHubView — the pure view-model behind the Deliverability Hub.
 *
 * The hub payload is the one place where "is this workspace in trouble?" is
 * already answered server-side (score, grade, breaches, auto-throttle), and
 * mobile rendered none of it. Everything in this module is the *decision* half
 * of that screen: which banner shows, what it says, how a screen reader hears
 * a score, and how a blocklist row is worded. It is separated from the screen
 * for the usual two reasons — it is the part worth unit-testing, and it must
 * not drift from desktop's wording.
 *
 * Imports nothing from react-native, so it runs under the node vitest project.
 */
import {
  gradeTone,
  scoreTone,
  severityRank,
  type SignalTone,
} from "./deliverabilitySignals";

export interface HubLike {
  score: number;
  grade: string;
  status: string;
  trend: string;
  trendDelta: number;
  history: number[];
  bounceRate: number;
  complaintRate: number;
  engagementRate: number;
  windowDays: number;
  sends7d: number;
  /** Server's verdict on whether the score rests on enough sending. */
  sampleQualified: boolean;
  sends30d: number;
  minimumSampleSends: number;
  sampleReason: string;
  autoThrottled: boolean;
  autoThrottleReason: string;
  breaches: {
    code: string;
    severity: string;
    title: string;
    detail: string;
    fixLabel: string;
    /** Optional so a snapshot written by an older build still renders. */
    fixHref?: string;
    fixSection?: string;
  }[];
  blocklistHits: {
    subject: string;
    zone: string;
    tier1: boolean;
    checkedAt: string;
  }[];
  computedAt: string;
}

/* --------------------------------------------------------------- headline --- */

export interface HubHeadline {
  score: string;
  grade: string;
  tone: SignalTone;
  /** Full sentence for VoiceOver — a bare "82" next to a coloured ring is not
   *  a status, and the grade word carries the meaning the colour implies. */
  spoken: string;
}

/**
 * A score of zero is a real, terrible score; a MISSING score is not. The hub
 * handler always emits a number, but a shape drift or an unparsed body must
 * not render "0 — Critical" and start a fire drill, so `null`/NaN is surfaced
 * as unknown rather than clamped to zero.
 */
export function hubHeadline(
  hub:
    | (Pick<HubLike, "score" | "grade"> &
        Partial<
          Pick<
            HubLike,
            | "sampleQualified"
            | "sends30d"
            | "minimumSampleSends"
            | "sampleReason"
          >
        >)
    | null
    | undefined,
): HubHeadline {
  const raw = hub?.score;
  const score = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  const grade = (hub?.grade ?? "").trim();

  // AN UNQUALIFIED SAMPLE IS NOT A SCORE.
  //
  // The handler always computes one, and with no sending at all the arithmetic
  // lands on a perfect 100/A: zero bounces over zero sends. The server says so
  // itself — `sample_qualified: false` alongside `minimum_sample_sends: 1000`
  // and `totals.sends_30d: 0` — and this view dropped all three, so the app
  // printed "100 / 100  A" on the screen an operator opens to decide whether
  // their sending reputation is safe. Seen in-app on 2026-08-19 on a workspace
  // with 0 sends.
  //
  // Desktop's ScoreCard already refuses this: it shows the score only when
  // `sample_qualified`, grades "N/A" otherwise, and explains how far short the
  // sample is. Same rule here.
  if (hub && hub.sampleQualified === false) {
    const have = Math.max(0, hub.sends30d ?? 0);
    const need = Math.max(0, hub.minimumSampleSends ?? 0);
    return {
      score: "—",
      grade: "Not scored yet",
      tone: "neutral",
      // The server's sentence wins when it sent one.
      spoken: (hub.sampleReason ?? "").trim()
        ? `Deliverability score not available yet: ${(hub.sampleReason ?? "").trim()}`
        : need
          ? `Deliverability score not available yet: ${have} of ${need} sends needed`
          : "Deliverability score not available yet: not enough sending",
    };
  }

  if (score === null) {
    return {
      score: "—",
      grade: grade || "Unknown",
      tone: "neutral",
      spoken: "Deliverability score unavailable",
    };
  }
  const rounded = Math.round(score);
  return {
    score: String(rounded),
    grade: grade || "—",
    // Prefer the server's own grade word for the tone so the colour can never
    // contradict the letter printed beside it; fall back to the numeric bands.
    tone: grade ? gradeTone(grade) : scoreTone(rounded),
    spoken: grade
      ? `Deliverability score ${rounded} out of 100, graded ${grade}`
      : `Deliverability score ${rounded} out of 100`,
  };
}

/** "up 4 points vs last week" / "no change" — never a bare arrow glyph. */
export function trendCaption(
  hub: Pick<HubLike, "trend" | "trendDelta"> | null | undefined,
): string {
  const delta = Number.isFinite(hub?.trendDelta) ? Number(hub?.trendDelta) : 0;
  const trend = (hub?.trend ?? "flat").trim().toLowerCase();
  if (trend === "flat" || delta === 0) return "No change vs last week";
  const magnitude = Math.abs(delta);
  const word = trend === "up" ? "up" : "down";
  return `${word[0]?.toUpperCase()}${word.slice(1)} ${magnitude} point${magnitude === 1 ? "" : "s"} vs last week`;
}

/* ---------------------------------------------------------------- banner --- */

export interface HubBanner {
  tone: SignalTone;
  title: string;
  message: string;
}

/**
 * The single most important thing this screen can say. Auto-throttle means the
 * platform has ALREADY cut the workspace's send rate — an operator who does not
 * know that will spend the morning debugging "why is the campaign crawling".
 *
 * A critical breach with no throttle is the next tier: nothing is capped yet,
 * but something is about to be.
 */
export function hubBanner(hub: HubLike | null | undefined): HubBanner | null {
  if (!hub) return null;
  if (hub.autoThrottled) {
    return {
      tone: "danger",
      title: "Sending is auto-throttled",
      message:
        hub.autoThrottleReason.trim() ||
        "Moosewave reduced this workspace's send rate to protect your sender reputation.",
    };
  }
  const worst = sortedBreaches(hub.breaches)[0];
  if (worst && severityRank(worst.severity) === 0) {
    return {
      tone: "danger",
      title: worst.title,
      message: worst.detail || "Open the breach below for what to change.",
    };
  }
  return null;
}

/* ---------------------------------------------------------------- fix CTA --- */

export type BreachFixTarget =
  | { kind: "href"; label: string; url: string }
  | { kind: "route"; label: string; route: string };

/**
 * Desktop's fix CTA jumps to a SECTION of its single settings page; mobile's
 * fixing surfaces are tabs. This maps the server's section slug to the tab
 * that owns the same verb. Two deliberate nulls:
 *  - "deliverabilityHub" points at the screen the operator is ALREADY on
 *    (the blocklist evidence is rendered below the breach), so a button
 *    would be a link to here;
 *  - an unknown slug gets no button rather than a guessed destination —
 *    a CTA that lands somewhere unrelated is worse than none.
 * An http(s) `href` always wins: it is the server naming the exact external
 * remediation form.
 */
const FIX_SECTION_ROUTES: Record<string, string> = {
  suppressions: "/(tabs)/suppressions",
  campaigns: "/(tabs)/campaigns",
  sequences: "/(tabs)/sequences",
  domains: "/(tabs)/custom-domains",
};

export function breachFixTarget(
  breach: Pick<HubLike["breaches"][number], "fixLabel"> &
    Partial<Pick<HubLike["breaches"][number], "fixHref" | "fixSection">>,
): BreachFixTarget | null {
  const label = breach.fixLabel.trim();
  if (!label) return null;
  const href = (breach.fixHref ?? "").trim();
  if (/^https?:\/\//i.test(href)) return { kind: "href", label, url: href };
  const route = FIX_SECTION_ROUTES[(breach.fixSection ?? "").trim()];
  if (route) return { kind: "route", label, route };
  return null;
}

/** Most severe first, then alphabetical, so the list order is stable. */
export function sortedBreaches<T extends { severity: string; title: string }>(
  breaches: readonly T[] | undefined,
): T[] {
  return [...(breaches ?? [])].sort((a, b) => {
    const delta = severityRank(a.severity) - severityRank(b.severity);
    if (delta !== 0) return delta;
    return a.title.localeCompare(b.title);
  });
}

/* ------------------------------------------------------------- blocklist --- */

export interface BlocklistSummary {
  total: number;
  tier1: number;
  /** Sentence for the section header; empty when there is nothing listed. */
  caption: string;
  tone: SignalTone;
}

/**
 * A tier-1 listing (Spamhaus SBL and friends) is an operational emergency; a
 * tier-2 listing is a warning. Reporting only "3 blocklist hits" flattens that
 * difference, so the caption always names the tier-1 count when there is one.
 */
export function blocklistSummary(
  hits: readonly { tier1: boolean }[] | undefined,
): BlocklistSummary {
  const rows = hits ?? [];
  const total = rows.length;
  const tier1 = rows.filter((row) => row.tier1).length;
  if (total === 0) {
    return { total: 0, tier1: 0, caption: "", tone: "success" };
  }
  if (tier1 > 0) {
    return {
      total,
      tier1,
      caption: `${tier1} tier-1 listing${tier1 === 1 ? "" : "s"} of ${total}`,
      tone: "danger",
    };
  }
  return {
    total,
    tier1: 0,
    caption: `${total} tier-2 listing${total === 1 ? "" : "s"}`,
    tone: "warning",
  };
}

/* ----------------------------------------------------------------- rates --- */

export interface HubRate {
  key: "bounce" | "complaint" | "engagement";
  label: string;
  /** Server sends a 0-1 fraction; the caller formats it. */
  value: number;
  /** For bounce/complaint lower is better, so the caller can tone correctly. */
  higherIsBetter: boolean;
}

export function hubRates(hub: HubLike | null | undefined): HubRate[] {
  return [
    {
      key: "bounce",
      label: "Bounce rate",
      value: hub?.bounceRate ?? 0,
      higherIsBetter: false,
    },
    {
      key: "complaint",
      label: "Complaint rate",
      value: hub?.complaintRate ?? 0,
      higherIsBetter: false,
    },
    {
      key: "engagement",
      label: "Engagement",
      value: hub?.engagementRate ?? 0,
      higherIsBetter: true,
    },
  ];
}

/**
 * Desktop's thresholds, so the two clients never disagree about whether a
 * bounce rate is "fine". Bounce: 2% warn / 5% critical. Complaint: 0.1% warn /
 * 0.3% critical (the ESP-standard line). Engagement is inverted.
 */
export function rateTone(key: HubRate["key"], value: unknown): SignalTone {
  const n = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (n === null) return "neutral";
  if (key === "bounce") {
    return n >= 0.05 ? "danger" : n >= 0.02 ? "warning" : "success";
  }
  if (key === "complaint") {
    return n >= 0.003 ? "danger" : n >= 0.001 ? "warning" : "success";
  }
  return n >= 0.2 ? "success" : n >= 0.08 ? "warning" : "danger";
}
