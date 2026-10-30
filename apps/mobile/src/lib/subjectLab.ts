/**
 * lib/subjectLab.ts — the pure readings behind the Subject Lab.
 *
 * Two server surfaces, two DIFFERENT authorization floors, and the difference
 * is why they are modelled separately here rather than as one blob:
 *
 *   GET  /api/v1/subject-analyzer/buckets  — read:reports at the mount site
 *        (subject_analyzer.go:99) and `session_minimum_role: viewer` in
 *        routeauth/manifest.json. Anyone signed in may see what has worked.
 *   POST /api/v1/subject-lab/score         — read:reports at the mount site
 *        (subject_lab.go:105) but `session_minimum_role: admin` in
 *        routeauth/manifest.json, which routeauth.Middleware enforces
 *        independently. The STRICTER binds, so scoring is admin-only.
 *
 * WHAT THIS FILE REFUSES TO DO. Both endpoints degrade to zeros rather than
 * erroring on a tenant with no send history: `scoringModel` swallows every
 * failure to `baseline=0, buckets={}` (subject_lab.go:288) and every variant
 * then comes back `low_confidence: true` with a baseline-derived point
 * estimate. Rendered literally that is "your subject will get a 0.0% open
 * rate", which is a measurement the server never made. `insufficient` /
 * `lowConfidence` carry that distinction out to the UI, and an unmeasurable
 * rate reads as an em-dash.
 *
 * Import-free beyond lib/format so mobile's node vitest can exercise it.
 */
import { EMDASH, percent } from "@/lib/format";

/** subject_lab.go: `subjects must contain 1..16 entries`. */
export const SUBJECT_LAB_MAX_CANDIDATES = 16;

/* ---------- candidate input ---------------------------------------- */

/**
 * One candidate per line. Trimmed, blank lines dropped, duplicates collapsed
 * (scoring the same string twice returns the same row and wastes a slot of
 * the server's 16).
 */
export function parseSubjectCandidates(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** The refusal reason, or null when the list is submittable. */
export function subjectCandidateError(candidates: string[]): string | null {
  if (candidates.length === 0) return "Add at least one subject line to score.";
  if (candidates.length > SUBJECT_LAB_MAX_CANDIDATES) {
    return `Score up to ${SUBJECT_LAB_MAX_CANDIDATES} subject lines at a time — you have ${candidates.length}.`;
  }
  return null;
}

/* ---------- POST /api/v1/subject-lab/score ------------------------- */

export interface SubjectLabScoredVariantWire {
  text?: string;
  axis?: string;
  predicted_open?: number;
  ci_low?: number;
  ci_high?: number;
  matched_n?: number;
  low_confidence?: boolean;
  below_baseline?: boolean;
}

export interface SubjectLabScoreWire {
  baseline_open?: number;
  window_days?: number;
  variants?: SubjectLabScoredVariantWire[];
}

export type SubjectVerdict = "above" | "below" | "inline" | "unknown";

export interface SubjectScoreRow {
  key: string;
  text: string;
  /** null when the corpus could not support an estimate. */
  predictedOpen: number | null;
  predictedLabel: string;
  /** "12.1%–19.4%" or the em-dash. */
  bandLabel: string;
  matchedN: number;
  lowConfidence: boolean;
  verdict: SubjectVerdict;
  /** "+2.4 pts vs your baseline" — null when there is nothing to compare to. */
  deltaLabel: string | null;
  /** Why this row cannot be trusted, when it cannot. */
  caveat: string | null;
}

export interface SubjectScoreReading {
  /** null when the tenant has no scoreable send history. */
  baselineOpen: number | null;
  baselineLabel: string;
  windowDays: number | null;
  rows: SubjectScoreRow[];
  /**
   * True when nothing in the response rests on real history: no baseline AND
   * every row low-confidence. The screen must say so instead of ranking noise.
   */
  insufficient: boolean;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The server reports rates as 0..1 fractions — which is exactly the convention
 * `percent` expects by default, so `alreadyPercent` stays off.
 */
function rateLabel(value: number | null): string {
  return value === null ? EMDASH : percent(value, { digits: 1 });
}

function verdictFor(
  baselineOpen: number | null,
  predictedOpen: number | null,
  ciLow: number | null,
  belowBaseline: boolean,
): SubjectVerdict {
  if (baselineOpen === null || predictedOpen === null) return "unknown";
  if (belowBaseline) return "below";
  // "Above" only when the WHOLE interval clears the baseline. A point estimate
  // one notch above the mean with a band straddling it has not beaten anything.
  if (ciLow !== null && ciLow > baselineOpen) return "above";
  return "inline";
}

function caveatFor(lowConfidence: boolean, matchedN: number): string | null {
  if (!lowConfidence) return null;
  if (matchedN === 0) {
    return "No past send matches this subject's shape — this is a guess, not a measurement.";
  }
  return `Only ${matchedN} past send${matchedN === 1 ? "" : "s"} match this shape, so the estimate is weak.`;
}

function scoreRow(
  variant: SubjectLabScoredVariantWire,
  index: number,
  baselineOpen: number | null,
): SubjectScoreRow | null {
  const text = typeof variant.text === "string" ? variant.text.trim() : "";
  if (!text) return null;
  const matchedN = Math.max(0, Math.trunc(finite(variant.matched_n) ?? 0));
  const lowConfidence = variant.low_confidence === true || matchedN === 0;
  // Without a baseline the server's fallback is "baseline ± 15%" of nothing,
  // so there is no estimate to show — only an em-dash.
  const predictedOpen =
    baselineOpen === null && lowConfidence ? null : finite(variant.predicted_open);
  const ciLow = finite(variant.ci_low);
  const ciHigh = finite(variant.ci_high);
  const delta =
    baselineOpen !== null && predictedOpen !== null
      ? (predictedOpen - baselineOpen) * 100
      : null;

  return {
    key: `${index}-${text}`,
    text,
    predictedOpen,
    predictedLabel: rateLabel(predictedOpen),
    bandLabel:
      predictedOpen !== null && ciLow !== null && ciHigh !== null
        ? `${rateLabel(ciLow)}–${rateLabel(ciHigh)}`
        : EMDASH,
    matchedN,
    lowConfidence,
    verdict: verdictFor(
      baselineOpen,
      predictedOpen,
      ciLow,
      variant.below_baseline === true,
    ),
    deltaLabel:
      delta === null
        ? null
        : `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} pts vs your baseline`,
    caveat: caveatFor(lowConfidence, matchedN),
  };
}

export function readSubjectLabScore(raw: unknown): SubjectScoreReading {
  const wire = (raw && typeof raw === "object" ? raw : {}) as SubjectLabScoreWire;
  const baselineRaw = finite(wire.baseline_open);
  // A baseline of exactly 0 is what an empty/unreadable corpus produces
  // (subject_lab.go scoringModel returns 0 on every error path), not a real
  // measurement of "nobody opens anything".
  const baselineOpen = baselineRaw !== null && baselineRaw > 0 ? baselineRaw : null;
  const list = Array.isArray(wire.variants) ? wire.variants : [];
  const rows: SubjectScoreRow[] = [];

  for (const [index, variant] of list.entries()) {
    if (!variant || typeof variant !== "object") continue;
    const row = scoreRow(variant, index, baselineOpen);
    if (row) rows.push(row);
  }

  return {
    baselineOpen,
    baselineLabel: rateLabel(baselineOpen),
    windowDays: finite(wire.window_days),
    rows,
    insufficient:
      baselineOpen === null && rows.every((row) => row.lowConfidence),
  };
}

/**
 * Ranked best-first, but ONLY among rows that carry a real estimate. A row the
 * server could not measure must not be sorted as if it scored zero — it sinks
 * to the bottom carrying its caveat instead.
 */
export function rankSubjectScoreRows(
  rows: readonly SubjectScoreRow[],
): SubjectScoreRow[] {
  return [...rows].sort((a, b) => {
    if (a.predictedOpen === null && b.predictedOpen === null) return 0;
    if (a.predictedOpen === null) return 1;
    if (b.predictedOpen === null) return -1;
    if (a.lowConfidence !== b.lowConfidence) return a.lowConfidence ? 1 : -1;
    return b.predictedOpen - a.predictedOpen;
  });
}

/* ---------- GET /api/v1/subject-analyzer/buckets ------------------- */

export interface SubjectBucketWire {
  attribute?: string;
  bucket?: string;
  campaigns?: number;
  open_rate?: number;
  click_rate?: number;
}

export interface SubjectBucketsWire {
  window_days?: number;
  campaigns_total?: number;
  buckets?: SubjectBucketWire[];
}

export interface SubjectBucketRow {
  key: string;
  label: string;
  campaigns: number;
  openRate: number;
  openLabel: string;
  clickLabel: string;
}

export interface SubjectBucketGroup {
  attribute: string;
  label: string;
  question: string;
  rows: SubjectBucketRow[];
}

export interface SubjectBucketsReading {
  windowDays: number | null;
  campaignsTotal: number;
  groups: SubjectBucketGroup[];
  /** True when the tenant has too little history for any of this to mean much. */
  insufficient: boolean;
}

/** The attribute vocabulary subject_analyzer.rollup emits, in reading order. */
const ATTRIBUTE_SPEC: readonly {
  attribute: string;
  label: string;
  question: string;
}[] = [
  { attribute: "length", label: "Length", question: "How long should it be?" },
  {
    attribute: "has_question",
    label: "Questions",
    question: "Does asking a question help?",
  },
  {
    attribute: "has_emoji",
    label: "Emoji",
    question: "Do emoji help or hurt?",
  },
  {
    attribute: "has_personalize",
    label: "Personalisation",
    question: "Does a merge tag help?",
  },
  {
    attribute: "all_caps",
    label: "All caps",
    question: "Does shouting work?",
  },
];

const LENGTH_LABELS: Record<string, string> = {
  short: "Under 30 characters",
  medium: "30–49 characters",
  long: "50–79 characters",
  very_long: "80+ characters",
};

function bucketLabel(attribute: string, bucket: string): string {
  if (attribute === "length") return LENGTH_LABELS[bucket] ?? bucket;
  if (bucket === "yes") return "Yes";
  if (bucket === "no") return "No";
  return bucket;
}

/**
 * A bucket built from one or two campaigns is an anecdote. The server reports
 * the count honestly, so the reading keeps it and the UI shows it — but the
 * threshold below which a row is not worth ranking is a client decision, and
 * it matches the n>=5 the scoring endpoint itself uses for low_confidence.
 */
export const SUBJECT_BUCKET_MIN_CAMPAIGNS = 5;

export function readSubjectBuckets(raw: unknown): SubjectBucketsReading {
  const wire = (raw && typeof raw === "object" ? raw : {}) as SubjectBucketsWire;
  const list = Array.isArray(wire.buckets) ? wire.buckets : [];
  const groups: SubjectBucketGroup[] = [];

  for (const spec of ATTRIBUTE_SPEC) {
    const rows: SubjectBucketRow[] = [];
    for (const bucket of list) {
      if (!bucket || typeof bucket !== "object") continue;
      if (bucket.attribute !== spec.attribute) continue;
      const name = typeof bucket.bucket === "string" ? bucket.bucket : "";
      const openRate = finite(bucket.open_rate);
      if (!name || openRate === null) continue;
      rows.push({
        key: `${spec.attribute}:${name}`,
        label: bucketLabel(spec.attribute, name),
        campaigns: Math.max(0, Math.trunc(finite(bucket.campaigns) ?? 0)),
        openRate,
        openLabel: rateLabel(openRate),
        clickLabel: rateLabel(finite(bucket.click_rate)),
      });
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => b.openRate - a.openRate);
    groups.push({ ...spec, rows });
  }

  const campaignsTotal = Math.max(0, Math.trunc(finite(wire.campaigns_total) ?? 0));
  return {
    windowDays: finite(wire.window_days),
    campaignsTotal,
    groups,
    insufficient: campaignsTotal < SUBJECT_BUCKET_MIN_CAMPAIGNS,
  };
}

/**
 * The one-line takeaway for a group: which bucket won and by how much. Null
 * when the group has a single bucket (nothing was compared) or when the
 * winning bucket is too thin to be worth a recommendation.
 */
export function subjectBucketTakeaway(
  group: SubjectBucketGroup,
): string | null {
  if (group.rows.length < 2) return null;
  const best = group.rows[0];
  const worst = group.rows[group.rows.length - 1];
  if (!best || !worst) return null;
  if (best.campaigns < SUBJECT_BUCKET_MIN_CAMPAIGNS) return null;
  const gap = (best.openRate - worst.openRate) * 100;
  if (gap < 0.1) return `No measurable difference across ${group.label.toLowerCase()}.`;
  return `${best.label} opens ${gap.toFixed(1)} pts higher than ${worst.label.toLowerCase()}.`;
}
