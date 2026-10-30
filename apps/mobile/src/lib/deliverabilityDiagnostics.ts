/**
 * deliverabilityDiagnostics — the parsers and derivations behind the three
 * diagnostic reads the hub was missing: ISP breakdown, bounce-class breakdown
 * and domain warm-up.
 *
 * Why these live together: each is a small pre-aggregated payload that answers
 * one branch of the same investigation.
 *
 *   "Our score dropped."
 *     → which mailbox provider?      isp-breakdown      (ispVerdict)
 *     → why did they bounce?         bounce-class       (parseBounceClasses)
 *     → are we ramping a new domain? domain-warmup      (warmupMeter)
 *
 * The two sending CONTROLS — the send-window policy and push-token
 * suppressions — are the same shape of read but they are levers rather than
 * diagnoses, and they live next door in `deliverabilityControls`.
 *
 * DELIBERATELY IMPORT-LIGHT. Only `deliverabilityContracts`, which is itself
 * import-free, so every rule here is testable in the node vitest environment —
 * the same reason `approvalPolicy` and `chartScale` are pure. No react-native,
 * no `./connectivity`.
 *
 * Endpoints, each read from the Go handler and not from a doc:
 *   GET /api/v1/isp-breakdown?days=                 isp_breakdown.go:67
 *   GET /api/v1/deliverability/hub/bounce-class-breakdown?window=
 *                                                   deliverability_hub/handlers.go:41
 *   GET /api/v1/domain-warmup                       domain_warmup.go:95  (admin)
 *   GET /api/v1/domain-warmup/{domain}/today        domain_warmup.go:99  (admin)
 */
import {
  bool,
  itemsOf,
  numberOr,
  str,
  WireShapeError,
} from "@/lib/deliverabilityContracts";
import type { SignalTone } from "@/lib/deliverabilitySignals";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* --------------------------------------------------------------- notice --- */

/**
 * The card-level sibling of `sideSignalNotice`.
 *
 * `sideSignalNotice` is written for a signal rendered INSIDE a row ("shown as
 * —, not as not-configured"). A whole diagnostic card has no em-dash to
 * explain; what it owes the reader is why the section is empty, so that an
 * absent breakdown is never read as "no bounces". Returns null when there is
 * nothing to say, so the caller renders the data in the common case.
 */
export function diagnosticNotice(
  what: string,
  failed: boolean,
  offline: boolean,
): string | null {
  if (!failed) return null;
  return offline
    ? `${what} needs a connection — this is not "nothing to report".`
    : `${what} couldn't be loaded. This is a failed read, not an empty result.`;
}

/* ------------------------------------------------------------------ isp --- */

export interface IspBucket {
  /** The server's bucket key: gmail | outlook | yahoo | apple | … */
  isp: string;
  /** Display name. The wire key is a slug; nobody says "b2b_other". */
  label: string;
  subscribers: number;
  opens: number;
  clicks: number;
  bounces: number;
  complaints: number;
  /** FRACTIONS (0-1), not percents — scanBuckets divides by the denominator. */
  openRate: number;
  bounceRate: number;
  complaintRate: number;
}

export interface IspBreakdown {
  windowDays: number;
  buckets: IspBucket[];
}

const ISP_LABELS: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Microsoft",
  yahoo: "Yahoo",
  apple: "Apple",
  proton: "Proton",
  aol: "AOL",
  fastmail: "Fastmail",
  zoho: "Zoho",
  b2b_other: "Business / other",
};

/**
 * The wire ships slugs and the CASE expression's fallthrough is literally
 * `b2b_other`. Rendering that raw is the difference between a diagnostic and
 * a database dump.
 */
export function ispLabel(code: unknown): string {
  const key = str(code).trim().toLowerCase();
  if (!key) return "Unknown";
  return ISP_LABELS[key] ?? key.replace(/_/g, " ");
}

export function parseIspBreakdown(value: unknown): IspBreakdown {
  if (!isRecord(value) && !Array.isArray(value)) {
    throw new WireShapeError("ISP breakdown");
  }
  const windowDays = isRecord(value) ? numberOr(value["window_days"], 30) : 30;
  const rows = isRecord(value)
    ? itemsOf(value["buckets"] ?? value, "ISP breakdown")
    : value;
  const buckets: IspBucket[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const isp = str(row["isp"]).trim();
    if (!isp) continue;
    const subscribers = numberOr(row["sent"] ?? row["subscribers"], 0);
    buckets.push({
      isp,
      label: ispLabel(isp),
      subscribers,
      opens: numberOr(row["opens"], 0),
      clicks: numberOr(row["clicks"], 0),
      bounces: numberOr(row["bounces"], 0),
      complaints: numberOr(row["complaints"], 0),
      openRate: numberOr(row["open_rate"], 0),
      bounceRate: numberOr(row["bounce_rate"], 0),
      complaintRate: numberOr(row["complaint_rate"], 0),
    });
  }
  buckets.sort((a, b) => b.subscribers - a.subscribers);
  return { windowDays, buckets };
}

/**
 * Providers too small to draw a conclusion from. Four bounces out of five
 * addresses at some vanity domain is a 80% bounce rate and means nothing; the
 * verdict must not open an investigation on it.
 */
export const ISP_VERDICT_MIN_VOLUME = 25;

export interface IspVerdict {
  /** The provider to look at first, or null when nothing stands out. */
  worst: IspBucket | null;
  tone: SignalTone;
  /** One sentence. Empty when there is nothing to say. */
  sentence: string;
}

/**
 * "Gmail is fine, Microsoft is bouncing" — the first branch of every
 * deliverability investigation, stated rather than left for the reader to
 * derive from a table.
 *
 * Compares each bucket with enough volume against the SAME thresholds the hub
 * score uses (2% warn / 5% critical), so the sentence can never contradict the
 * rate tile two cards above it.
 */
export function ispVerdict(buckets: readonly IspBucket[]): IspVerdict {
  const eligible = buckets.filter(
    (b) => b.subscribers >= ISP_VERDICT_MIN_VOLUME,
  );
  if (eligible.length === 0) {
    return {
      worst: null,
      tone: "neutral",
      sentence:
        buckets.length === 0
          ? ""
          : "Not enough volume at any one provider to compare them yet.",
    };
  }
  const worst = eligible.reduce((a, b) =>
    b.bounceRate > a.bounceRate ? b : a,
  );
  if (worst.bounceRate < 0.02) {
    return {
      worst: null,
      tone: "success",
      sentence: "Every provider with real volume is bouncing under 2%.",
    };
  }
  const tone: SignalTone = worst.bounceRate >= 0.05 ? "danger" : "warning";
  const best = eligible.reduce((a, b) => (b.bounceRate < a.bounceRate ? b : a));
  const contrast =
    best.isp !== worst.isp && best.bounceRate < 0.02
      ? ` ${best.label} is fine at ${pct(best.bounceRate)}.`
      : "";
  return {
    worst,
    tone,
    sentence: `${worst.label} is bouncing ${pct(worst.bounceRate)}.${contrast}`,
  };
}

/** One decimal, no Intl — this module stays import-free of the formatter. */
function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/* --------------------------------------------------------- bounce class --- */

export interface BounceClassRow {
  code: string;
  label: string;
  count: number;
  /** 0-1 share of all bounces in the window. */
  share: number;
}

export interface BounceClassBreakdown {
  windowDays: number;
  totalBounces: number;
  classes: BounceClassRow[];
}

export function parseBounceClasses(value: unknown): BounceClassBreakdown {
  if (!isRecord(value)) throw new WireShapeError("bounce breakdown");
  const rows = itemsOf(value["classes"] ?? [], "bounce breakdown");
  const total = numberOr(value["total_bounces"], 0);
  const classes: BounceClassRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const code = str(row["class_code"]).trim() || "unknown";
    const count = numberOr(row["count"], 0);
    // The server computes `share`, but it divides by its own total; recompute
    // when it is absent so a legacy payload does not render every row at 0%.
    const share =
      row["share"] === undefined || row["share"] === null
        ? total > 0
          ? count / total
          : 0
        : numberOr(row["share"], 0);
    classes.push({
      code,
      label: str(row["label"]).trim() || bounceClassFallbackLabel(code),
      count,
      share,
    });
  }
  classes.sort((a, b) => b.count - a.count);
  return {
    windowDays: numberOr(value["window_days"], 30),
    totalBounces: total,
    classes,
  };
}

/** Only used when the server omits `label` — it normally supplies one. */
function bounceClassFallbackLabel(code: string): string {
  const key = code.toLowerCase();
  if (key === "hard") return "Hard bounce";
  if (key === "soft") return "Soft bounce";
  if (key === "spam_trap") return "Spam trap";
  if (key === "unknown") return "Unclassified";
  return code.replace(/_/g, " ");
}

/**
 * A hard bounce is a list-hygiene problem you must act on; a soft bounce is
 * usually transient. Tone follows that, never the raw magnitude.
 */
export function bounceClassTone(code: string): SignalTone {
  const key = code.trim().toLowerCase();
  if (key.includes("spam") || key.includes("trap")) return "danger";
  if (key.includes("hard") || key.includes("block")) return "danger";
  if (key.includes("soft") || key.includes("defer")) return "warning";
  return "neutral";
}

/* -------------------------------------------------------------- warm-up --- */

export interface WarmupPlan {
  id: string;
  domain: string;
  targetDaily: number;
  days: number;
  status: string;
  lastSentCount: number;
}

export interface WarmupToday {
  domain: string;
  status: string;
  /** 0-based index into the ramp schedule. */
  dayIndex: number;
  dayQuota: number;
  sentToday: number;
  remaining: number;
  /** True once the ramp has reached the target daily volume. */
  atTarget: boolean;
}

export function parseWarmupPlans(value: unknown): WarmupPlan[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value)
      ? itemsOf(value["plans"] ?? value, "domain warm-up")
      : itemsOf(value, "domain warm-up");
  const out: WarmupPlan[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const domain = str(row["domain"]).trim();
    if (!domain) continue;
    out.push({
      id: str(row["id"]) || domain,
      domain,
      targetDaily: numberOr(row["target_daily"], 0),
      days: numberOr(row["days"], 0),
      status: str(row["status"]).trim() || "active",
      lastSentCount: numberOr(row["last_sent_count"], 0),
    });
  }
  return out;
}

export function parseWarmupToday(value: unknown): WarmupToday {
  if (!isRecord(value)) throw new WireShapeError("warm-up status");
  return {
    domain: str(value["domain"]).trim(),
    status: str(value["status"]).trim() || "active",
    dayIndex: numberOr(value["day_index"], 0),
    dayQuota: numberOr(value["day_quota"], 0),
    sentToday: numberOr(value["sent_today"], 0),
    remaining: numberOr(value["remaining"], 0),
    atTarget: bool(value["at_target"], false),
  };
}

export interface WarmupMeter {
  /** 0-1 of today's allowance consumed; null when no quota is set. */
  fraction: number | null;
  tone: SignalTone;
  caption: string;
  /** "Day 4 of 21" — the ramp position, which is the other half of the story. */
  dayLabel: string;
}

/**
 * Warm-up is a multi-week ramp whose daily question is ONE number: today's
 * allowance and how much of it is spent. Note the tone inversion versus the
 * rate-limit meter — running out of warm-up quota is not a danger state, it is
 * the plan working, so a full bar is neutral-to-warning, never red.
 */
export function warmupMeter(
  today: WarmupToday | null | undefined,
): WarmupMeter {
  if (!today || today.dayQuota <= 0) {
    return {
      fraction: null,
      tone: "neutral",
      caption: today
        ? "No quota for today — the plan is not ramping."
        : "No warm-up plan for this domain.",
      dayLabel: "",
    };
  }
  const fraction = Math.min(1, Math.max(0, today.sentToday / today.dayQuota));
  const dayLabel = today.atTarget
    ? "At full target volume"
    : `Day ${today.dayIndex + 1}`;
  const tone: SignalTone =
    today.remaining <= 0 ? "warning" : fraction >= 0.9 ? "info" : "success";
  return {
    fraction,
    tone,
    caption:
      today.remaining <= 0
        ? `${today.sentToday} of ${today.dayQuota} today · allowance used up`
        : `${today.sentToday} of ${today.dayQuota} today · ${today.remaining} left`,
    dayLabel,
  };
}

/**
 * Which warm-up control is meaningful for a plan's current status.
 *
 * `PATCH /api/v1/domain-warmup/{domain}/status` accepts
 * active|paused|completed|cancelled. Only the first two ship on a phone:
 *
 *   pause / resume   a ramp is sending more mail every day on a schedule, and
 *                    "stop that while I look at a reputation problem" is
 *                    precisely an away-from-desk act. Reversible by the same
 *                    control that set it.
 *   completed        declares the warm-up finished, which changes how the
 *                    sending limiter treats the domain from then on.
 *   cancelled        abandons the ramp outright.
 *
 * The last two are terminal judgements about a multi-week programme, not
 * moment-to-moment control, and neither is undone by tapping again. They stay
 * on a desk.
 *
 * A plan already completed or cancelled offers nothing: re-activating a
 * finished warm-up would silently restart a ramp somebody deliberately ended.
 */
export type WarmupControl = "pause" | "resume" | "none";

export function warmupControlFor(plan: { status: string }): WarmupControl {
  switch (plan.status.trim().toLowerCase()) {
    case "active":
      return "pause";
    case "paused":
      return "resume";
    default:
      return "none";
  }
}

/** The status value the control sends. */
export function warmupControlStatus(control: WarmupControl): string | null {
  if (control === "pause") return "paused";
  if (control === "resume") return "active";
  return null;
}

export function warmupControlLabel(control: WarmupControl): string | null {
  if (control === "pause") return "Pause ramp";
  if (control === "resume") return "Resume ramp";
  return null;
}

/**
 * What pausing actually does, in the terms the operator cares about.
 *
 * Naming the daily target matters: a paused ramp does not merely "stop
 * increasing" — the domain stops being allowed its rising allowance, and
 * somebody who thinks they have only frozen a counter will be surprised by
 * throttling.
 */
export function warmupPauseConsequence(plan: {
  domain: string;
  targetDaily: number;
}): string {
  return (
    `${plan.domain} stops climbing toward ${plan.targetDaily} a day and holds ` +
    `at its current allowance. Sending is not stopped, but it will not grow ` +
    `until you resume.`
  );
}
