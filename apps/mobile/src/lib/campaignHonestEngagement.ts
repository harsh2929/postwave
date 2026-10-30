/**
 * lib/campaignHonestEngagement.ts — the per-campaign "how much of the open
 * rate to believe" reading, from GET /api/v1/campaigns/{id}/engagement
 * (apps/api/internal/analytics/engagement.go:33, session role viewer).
 *
 * Desktop twin: apps/desktop/src/components/analytics/EngagementPanel.tsx and
 * lib/engagement-helpers.ts. The same rules, restated here because each one
 * is a way to print a lie:
 *
 *  - ALL RATES ARE FRACTIONS 0..1 (engagement.go:57). Never divide by 100.
 *  - THE HUMAN FIELDS ARE ZEROED, NOT OMITTED, WHEN BOT-FILTERING IS OFF
 *    (engagement.go:53, decision D4 — and off by default in a stock
 *    deployment). `human_open_rate: 0` beside `raw_open_rate: 0.52` is not
 *    "no human opened it" and not "52 points of bots"; it is "the split was
 *    never measured". The human row and the inflation delta exist only when
 *    there is genuine filtering signal — a human open or a fired signature —
 *    exactly desktop's shouldShowHumanRow and lib/campaignEngagement's
 *    hasHumanEngagement.
 *  - A ZERO DENOMINATOR IS A ZERO RATE ON THE WIRE (engagement.go:264). The
 *    server guards its divisions and sends 0, so `delivered` decides whether
 *    an open rate is a rate at all, and `distinct_replyers` does the same for
 *    the reply rate, whose denominator (unique recipients) never leaves the
 *    server. No rate is printed without evidence of its denominator.
 *  - THE AI-SURFACING SCORE IS AN ESTIMATE, AND "low" CONFIDENCE MEANS THE
 *    SAMPLE IS TOO SMALL TO TRUST IT (engagement.go:96). The same rule as the
 *    deliverability score in lib/deliverabilityHubView: an unqualified sample
 *    is not a number. Low confidence renders the server's qualifier — the
 *    level and the sample it saw — and no percentage.
 *  - Go marshals a nil slice as `null`: `bot_signatures_applied` is null on
 *    every flag-off payload, and `ai_surfacing_basis` may be. Both read as [].
 *
 * Pure; imports lib/format only, so every rule is node-tested.
 */
import { num, percent } from "@/lib/format";

export type HonestEngagementMode = "human" | "raw";

export interface HonestEngagementRow {
  key: string;
  label: string;
  value: string;
  /** The qualifier that keeps the value honest; rendered under it. */
  detail: string;
}

export type AiSurfacingView =
  | {
      kind: "scored";
      /** Desktop's coarse bucket of the estimate (engagement-helpers.ts). */
      bucket: "Low" | "Moderate" | "High";
      score: string;
      confidence: string;
      sample: string;
      basis: string | null;
    }
  | {
      kind: "insufficient";
      /** The server's qualifier, in place of a number. */
      reason: string;
      basis: string | null;
    };

export interface HonestEngagementView {
  mode: HonestEngagementMode;
  headline: string;
  rows: HonestEngagementRow[];
  /** Disclosures that must travel with the numbers. */
  notes: string[];
  /** null when the payload carried no estimate at all. */
  aiSurfacing: AiSurfacingView | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

/** A 0..1 rate, or null when the field is absent/garbled — never a fake 0. */
function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.min(1, value);
}

/** A string list that survives `null` (Go's nil slice) and junk entries. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The server's basis keys (engagement.go:151) as words; unknown keys pass through. */
const BASIS_WORDS: Record<string, string> = {
  human_open_rate: "human open rate",
  reply_rate: "reply rate",
  hard_bounce_rate: "hard-bounce rate",
  click_to_open_rate: "click-to-open rate",
};

/** Desktop's aiSurfacingLabel thresholds: < 0.4 Low, < 0.7 Moderate, else High. */
export function aiSurfacingBucket(score: number): "Low" | "Moderate" | "High" {
  if (score < 0.4) return "Low";
  if (score < 0.7) return "Moderate";
  return "High";
}

interface OpenRates {
  mode: HonestEngagementMode;
  delivered: number;
  humanUniqueOpens: number;
  humanRate: number | null;
  rawRate: number | null;
}

function openRateRows({
  mode,
  delivered,
  humanUniqueOpens,
  humanRate,
  rawRate,
}: OpenRates): HonestEngagementRow[] {
  if (delivered === 0) return [];
  if (mode === "raw") {
    return [
      {
        key: "raw",
        label: "Open rate",
        value: percent(rawRate),
        detail: "bot filtering not enabled — showing raw rate",
      },
    ];
  }
  const rows: HonestEngagementRow[] = [
    {
      key: "human",
      label: "Human open rate",
      value: percent(humanRate),
      detail: `${num(humanUniqueOpens)} of ${num(delivered)} delivered, with machine and proxy opens stripped`,
    },
    {
      key: "raw",
      label: "Raw open rate",
      value: percent(rawRate),
      detail: "Every recorded open, machines included",
    },
  ];
  // Inflation can only be non-negative (bots add opens); a stripped rate that
  // came out higher is a glitch and reads as 0, never as negative.
  if (humanRate !== null && rawRate !== null) {
    const pts = Math.max(0, (rawRate - humanRate) * 100);
    rows.push({
      key: "inflation",
      label: "Machine inflation",
      value: `${pts.toFixed(1)} pts`,
      detail:
        pts < 0.05
          ? "The raw and human open rates agree"
          : "Points of the raw open rate that came from machines and proxies",
    });
  }
  return rows;
}

function headlineFor({ mode, delivered, humanRate, rawRate }: OpenRates): string {
  if (delivered === 0) {
    return "No delivered recipients have been recorded for this send, so open rates can't be computed yet.";
  }
  return mode === "human"
    ? `${percent(humanRate)} of ${num(delivered)} delivered were opened by a person; the raw rate is ${percent(rawRate)}.`
    : `${percent(rawRate)} of ${num(delivered)} delivered were opened. No human/machine split was measured for this send, so this is the raw rate.`;
}

function replyRow(row: Record<string, unknown>): HonestEngagementRow {
  const replyCount = count(row.reply_count);
  const replyers = count(row.distinct_replyers);
  const replyRate = fraction(row.reply_rate);
  if (replyers > 0 && replyRate !== null && replyRate > 0) {
    return {
      key: "replies",
      label: "Reply rate",
      value: percent(replyRate),
      detail: `${num(replyers)} ${replyers === 1 ? "person" : "people"} replied · ${num(replyCount)} ${replyCount === 1 ? "reply" : "replies"}`,
    };
  }
  if (replyCount > 0) {
    return {
      key: "replies",
      label: "Replies",
      value: num(replyCount),
      detail: "Reply rate not reported for this send",
    };
  }
  return {
    key: "replies",
    label: "Replies",
    value: "0",
    detail: "No replies recorded for this send",
  };
}

function conversionRow(row: Record<string, unknown>): HonestEngagementRow {
  const decoupled = count(row.open_decoupled_conversions);
  const attributed = count(row.total_attributed_conversions);
  if (attributed > 0) {
    return {
      key: "conversions",
      label: "Acted without an open",
      value: `${num(decoupled)} of ${num(attributed)}`,
      detail:
        "Attributed conversions with no recorded open — open rate alone undercounts what this send caused",
    };
  }
  return {
    key: "conversions",
    label: "Attributed conversions",
    value: "0",
    detail: "No attributed conversions yet",
  };
}

function aiSurfacingView(row: Record<string, unknown>): AiSurfacingView | null {
  const score = fraction(row.ai_surfacing_score);
  if (score === null) return null;
  const level =
    typeof row.ai_surfacing_confidence_level === "string"
      ? row.ai_surfacing_confidence_level.trim()
      : "";
  const sampleOpens = count(row.ai_surfacing_sample_opens);
  const sample = `${num(sampleOpens)} ${sampleOpens === 1 ? "open" : "opens"} analysed`;
  const basisWords = strings(row.ai_surfacing_basis).map(
    (key) => BASIS_WORDS[key] ?? key,
  );
  const basis = basisWords.length > 0 ? `Based on ${basisWords.join(", ")}` : null;
  if (level === "low") {
    return {
      kind: "insufficient",
      reason: `Estimate not shown: the server rates its confidence low (${sample}).`,
      basis,
    };
  }
  return {
    kind: "scored",
    bucket: aiSurfacingBucket(score),
    score: percent(score, { digits: 0 }),
    confidence: level || "unstated",
    sample,
    basis,
  };
}

export function readHonestEngagement(raw: unknown): HonestEngagementView | null {
  const row = record(raw);
  if (!row) return null;

  const signatures = strings(row.bot_signatures_applied);
  const open: OpenRates = {
    delivered: count(row.delivered),
    humanUniqueOpens: count(row.human_unique_opens),
    humanRate: fraction(row.human_open_rate),
    rawRate: fraction(row.raw_open_rate),
    mode: "raw",
  };
  open.mode =
    open.humanUniqueOpens > 0 || signatures.length > 0 ? "human" : "raw";

  const notes: string[] = [];
  if (open.mode === "human" && open.delivered > 0 && signatures.length > 0) {
    notes.push(`Stripped: ${signatures.join(", ")}`);
  }
  // The F01 band the counts were computed under travels with them
  // (engagement.go:45); "all" is the default and needs no caveat.
  const band =
    typeof row.classification_filter === "string"
      ? row.classification_filter.trim()
      : "";
  if (band && band !== "all") {
    notes.push(`Opens and clicks counted under the "${band}" classification band.`);
  }

  return {
    mode: open.mode,
    headline: headlineFor(open),
    rows: [...openRateRows(open), replyRow(row), conversionRow(row)],
    notes,
    aiSurfacing: aiSurfacingView(row),
  };
}
