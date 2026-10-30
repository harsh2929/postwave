/**
 * lib/campaignInsights.ts — the wire shapes and the pure readings of the
 * per-campaign analytics endpoints the mobile report never opened.
 *
 * The Go gateway has shipped these for a long time and mobile rendered none
 * of them, so "how did it do?" on a phone stopped at four tiles:
 *
 *   GET /campaigns/{id}/link-report   → []LinkRow      which URLs got clicked
 *   GET /campaigns/{id}/devices       → []DeviceRow    which mail clients
 *   GET /campaigns/{id}/geography     → []GeographyRow which countries
 *   GET /campaigns/{id}/bounces       → BounceCounts   hard vs soft vs trap
 *   GET /campaigns/{id}/goal-results  → GoalResults    the conversion goal
 *   GET /campaigns/{id}/holdout/lift  → lift report    incremental lift
 *
 * Everything here is pure and import-free (beyond the shared formatters) so
 * it runs in the node vitest environment: the components that render it
 * cannot be, since they import react-native.
 *
 * The bounces reading is the one with teeth. The report tile shows a single
 * `bounces` number, and a hard bounce (the address does not exist — remove it)
 * and a soft bounce (a full mailbox — retry later) are completely different
 * facts with completely different responses. A spam-trap hit is different
 * again, and is the one that ends a sending reputation.
 */
import { campaignCount, campaignRate } from "@/lib/campaignFormat";
import { money, num, percent } from "@/lib/format";

/* ------------------------------------------------------------------ links */

export interface CampaignLinkRow {
  url?: string;
  clicks?: number;
  unique_clickers?: number;
  ctr?: number;
}

export interface InsightRow {
  key: string;
  label: string;
  value: string;
  /** Exact spoken value for assistive tech, when `value` is compacted. */
  spoken?: string;
  /** 0..1 share of the largest row, for the inline bar. */
  share: number;
}

function shareOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

/** Shorten a URL to something readable in a 320pt-wide row. */
export function shortLinkLabel(raw: string | undefined, max = 46): string {
  const url = (raw ?? "").trim();
  if (!url) return "(no URL)";
  const stripped = url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  return stripped.length > max ? `${stripped.slice(0, max - 1)}…` : stripped;
}

export function linkRows(raw: unknown, limit = 5): InsightRow[] {
  const list = Array.isArray(raw) ? (raw as CampaignLinkRow[]) : [];
  const usable = list.filter((r) => typeof r?.clicks === "number");
  const max = usable.reduce((m, r) => Math.max(m, r.clicks ?? 0), 0);
  return usable
    .slice()
    .sort((a, b) => (b.clicks ?? 0) - (a.clicks ?? 0))
    .slice(0, limit)
    .map((r, i) => ({
      key: `${r.url ?? "link"}-${i}`,
      label: shortLinkLabel(r.url),
      value: campaignCount(r.clicks),
      spoken: `${shortLinkLabel(r.url, 200)}, ${num(r.clicks ?? 0)} clicks${
        typeof r.ctr === "number"
          ? `, ${campaignRate(r.ctr, { scale: "fraction" })} click-through`
          : ""
      }`,
      share: shareOf(r.clicks ?? 0, max),
    }));
}

/* ------------------------------------------------- devices and geography */

export interface CampaignNamedRow {
  client?: string;
  country?: string;
  opens?: number;
  clicks?: number;
}

/**
 * Devices and geography share a shape: a name plus opens/clicks. `field`
 * picks which name key the endpoint used.
 */
export function namedOpenRows(
  raw: unknown,
  field: "client" | "country",
  limit = 5,
): InsightRow[] {
  const list = Array.isArray(raw) ? (raw as CampaignNamedRow[]) : [];
  const usable = list.filter((r) => typeof r?.opens === "number");
  const max = usable.reduce((m, r) => Math.max(m, r.opens ?? 0), 0);
  return usable
    .slice()
    .sort((a, b) => (b.opens ?? 0) - (a.opens ?? 0))
    .slice(0, limit)
    .map((r, i) => {
      const name = (r[field] ?? "").trim() || "Unknown";
      return {
        key: `${name}-${i}`,
        label: name,
        value: campaignCount(r.opens),
        spoken: `${name}, ${num(r.opens ?? 0)} opens, ${num(r.clicks ?? 0)} clicks`,
        share: shareOf(r.opens ?? 0, max),
      };
    });
}

/* --------------------------------------------------------------- bounces */

export interface CampaignBounceCounts {
  hard?: number;
  soft?: number;
  spam_trap?: number;
  total?: number;
}

export interface BounceReading {
  rows: { key: string; label: string; value: string; detail: string }[];
  /** Non-null when the breakdown warrants an explicit warning. */
  warning: string | null;
  /** True when the endpoint answered but every category is zero. */
  clean: boolean;
}

export function readBounces(
  raw: CampaignBounceCounts | null | undefined,
): BounceReading {
  const hard = Number(raw?.hard) || 0;
  const soft = Number(raw?.soft) || 0;
  const trap = Number(raw?.spam_trap) || 0;
  const total = Number(raw?.total) || hard + soft + trap;
  return {
    rows: [
      {
        key: "hard",
        label: "Hard",
        value: campaignCount(hard),
        detail: "The address doesn't exist. These are suppressed permanently.",
      },
      {
        key: "soft",
        label: "Soft",
        value: campaignCount(soft),
        detail: "Temporary — a full mailbox or a busy server. Retried later.",
      },
      {
        key: "spam_trap",
        label: "Spam traps",
        value: campaignCount(trap),
        detail: "Addresses that exist only to catch senders with stale lists.",
      },
    ],
    warning:
      trap > 0
        ? "This send hit a spam trap. Traps are the single fastest way to lose sending reputation — review where these addresses came from before sending again."
        : null,
    clean: total === 0,
  };
}

/* ----------------------------------------------------------- goal results */

export interface CampaignGoalResults {
  goal_event?: string;
  goal_window_hours?: number;
  configured?: boolean;
  conversion_count?: number;
  recipients?: number;
  conversion_rate?: number;
  attributed_revenue_cents?: number;
  currency?: string;
}

export interface GoalReading {
  configured: boolean;
  headline: string;
  rows: { key: string; label: string; value: string }[];
}

export function readGoalResults(
  raw: CampaignGoalResults | null | undefined,
): GoalReading {
  if (!raw?.configured) {
    return {
      configured: false,
      headline:
        "No conversion goal is set on this campaign. Configure one on the web app to measure what the send actually caused.",
      rows: [],
    };
  }
  const window = Number(raw.goal_window_hours) || 0;
  const cents = Number(raw.attributed_revenue_cents);
  const rows = [
    {
      key: "conversions",
      label: "Conversions",
      value: campaignCount(raw.conversion_count),
    },
    {
      key: "rate",
      label: "Conversion rate",
      value: campaignRate(raw.conversion_rate, { scale: "fraction" }),
    },
    {
      key: "recipients",
      label: "Recipients counted",
      value: campaignCount(raw.recipients),
    },
  ];
  if (Number.isFinite(cents) && cents > 0) {
    rows.push({
      key: "revenue",
      label: "Attributed revenue",
      value: money(cents / 100, raw.currency || "USD"),
    });
  }
  return {
    configured: true,
    headline: `Goal: ${raw.goal_event || "conversion"}${
      window > 0 ? ` within ${window}h of the send` : ""
    }`,
    rows,
  };
}

/* ----------------------------------------------------------- holdout lift */

export interface CampaignHoldoutLift {
  status?: string;
  message?: string;
  percent?: number;
  result_id?: string;
  result_version?: string;
  methodology_version?: string;
  methodology_statement?: string;
  outcome_metric?: string;
  window_start?: string;
  window_end?: string;
  held_out_subs?: number;
  sent_subs?: number;
  held_out_conversions?: number;
  sent_conversions?: number;
  held_out_conversion_rate?: number;
  sent_conversion_rate?: number;
  significance?: {
    control_rate: number;
    treatment_rate: number;
    absolute_lift: number | null;
    relative_lift: number | null;
    incremental_conversions: number | null;
    p_value: number;
    ci_low: number | null;
    ci_high: number | null;
    powered: boolean;
    minimum_detectable_effect: number;
    underpowered_reason?: string;
  };
  // Deprecated compatibility aliases. New readers use the configured
  // outcome fields above; these names do not prove the outcome was a click.
  held_out_click_rate?: number;
  sent_click_rate?: number;
  incremental_lift?: number;
  lift_percent?: number;
  approximate?: boolean;
  caveat?: string;
}

export interface LiftReading {
  state: "pending" | "underpowered" | "measured" | "unavailable";
  /** Compatibility boolean: true only when a powered estimate was released. */
  decided: boolean;
  headline: string;
  badge: { label: string; tone: "neutral" | "success" | "warning" } | null;
  /** Positive only for a released positive estimate. */
  positive: boolean;
  rows: { key: string; label: string; value: string }[];
  caveat: string | null;
}

export function readHoldoutLift(
  raw: CampaignHoldoutLift | null | undefined,
): LiftReading {
  if (!raw || raw.status === "pending") {
    return {
      state: "pending",
      decided: false,
      headline:
        raw?.message ??
        "This holdout hasn't been decided yet — lift becomes measurable after the send completes.",
      positive: false,
      badge: null,
      rows: [],
      caveat: null,
    };
  }
  if (raw.status === "unavailable" || !raw.significance) {
    return {
      state: "unavailable",
      decided: false,
      headline:
        raw.message ??
        "The immutable assignment evidence required to calculate lift is unavailable. No measurement was made.",
      badge: { label: "— Unavailable", tone: "neutral" },
      positive: false,
      rows: [],
      caveat: "This is not a result of zero lift.",
    };
  }
  const significance = raw.significance;
  const controlRate = significance.control_rate;
  const treatmentRate = significance.treatment_rate;
  const outcome = (raw.outcome_metric ?? "configured outcome").replaceAll(
    "_",
    " ",
  );
  const rows = [
    {
      key: "sent_rate",
      label: `Sent group ${outcome} rate`,
      value: campaignRate(treatmentRate, { scale: "fraction" }),
    },
    {
      key: "held_rate",
      label: `Held-out ${outcome} rate`,
      value: campaignRate(controlRate, { scale: "fraction" }),
    },
    {
      key: "held_subs",
      label: "Held out",
      value: campaignCount(raw.held_out_subs),
    },
    {
      key: "sent_subs",
      label: "Sent to",
      value: campaignCount(raw.sent_subs),
    },
  ];
  if (!significance.powered || significance.absolute_lift === null) {
    const reason =
      significance.underpowered_reason?.trim() ||
      "The two groups are too small to separate a real effect from noise.";
    return {
      state: "underpowered",
      decided: false,
      headline: `Not enough data to measure lift: ${reason} No lift number is shown.`,
      badge: { label: "○ Underpowered", tone: "warning" },
      positive: false,
      rows,
      caveat: `At this sample size, an effect smaller than ${percent(significance.minimum_detectable_effect)} cannot be distinguished from chance.`,
    };
  }
  const relative = significance.relative_lift;
  const absolute = significance.absolute_lift;
  const positive = (relative ?? absolute) > 0;
  const intervalAvailable =
    significance.ci_low !== null && significance.ci_high !== null;
  const spansZero =
    intervalAvailable &&
    (significance.ci_low as number) <= 0 &&
    (significance.ci_high as number) >= 0;
  const estimate =
    relative === null
      ? `${percent(absolute)} percentage-point difference`
      : `${relative >= 0 ? "+" : ""}${percent(relative)} vs. the held-out group`;
  return {
    state: "measured",
    decided: true,
    headline: estimate,
    badge: {
      label: positive
        ? "▲ Lift"
        : absolute < 0
          ? "▼ Negative lift"
          : "— No detected lift",
      tone: positive ? "success" : "warning",
    },
    positive,
    rows,
    caveat: spansZero
      ? "The 95% confidence interval includes zero, so the campaign may have caused no additional conversions. Treat this as directional, not conclusive."
      : intervalAvailable
        ? `95% confidence interval ${percent(significance.ci_low)} to ${percent(significance.ci_high)}; p = ${significance.p_value.toFixed(3)}.`
        : null,
  };
}
