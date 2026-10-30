/**
 * lib/bestTimeSchedule.ts — reading POST /api/v1/campaigns/{id}/
 * schedule-by-best-time{,/preview} into something a phone can render.
 *
 * WHY THIS EXISTS. Mobile's only send-time affordance was SendTimeOptBanner:
 * one "best hour UTC" for the whole audience, applied as a single fixed
 * `scheduled_at`. Desktop has always had the other half — commit the schedule
 * PER RECIPIENT, each at their own best hour, with a dry-run preview of where
 * the 24-hour distribution lands before anything is written. That is the
 * higher-leverage scheduling decision and it is one toggle plus one confirm,
 * which is a phone-shaped interaction, not a desktop one.
 *
 * It also happens to be the only schedule-like write the gateway currently
 * accepts from this client: the plain `scheduled_at` PATCH is answered with
 * 422 `campaign_dispatch_state_owned` while durable delivery is being
 * verified (see CampaignScheduleModal's header), whereas
 * /schedule-by-best-time owns dispatch state itself.
 *
 * DELIBERATELY IMPORT-FREE apart from lib/format (which is itself import-free).
 * No react-native, no ./connectivity — that is what keeps it testable in the
 * node vitest environment, the same contract approvalPolicy / chartScale /
 * typeScale keep.
 */
import { num, plural } from "@/lib/format";

/** One (hour, count) pair from the gateway's 24-bucket histogram. */
export interface BestTimeBucket {
  hour: number;
  count: number;
}

/** A sampled recipient row from `first_50` / `first_5`. */
export interface BestTimeSample {
  email: string;
  send_at: string;
  best_hour_utc: number;
}

/**
 * Mirrors send_time_opt.SchedulePreviewResponse. Every field is optional at
 * the type level because this is wire data: an older gateway, a partial
 * response or a proxy that drops a key must degrade to "we don't know", never
 * to a crash inside a chart.
 */
export interface BestTimeSchedulePreview {
  campaign_id?: string;
  scheduled?: number;
  within_days?: number;
  tenant_mean?: number;
  truncated?: boolean;
  hard_cap?: number;
  strategy?: string;
  reference_at?: string;
  distribution?: BestTimeBucket[];
  first_50?: BestTimeSample[];
  max_per_minute?: number;
  max_per_day?: number;
  peak_day_utc?: string;
  tier_cap_today?: number;
  warmup_cap_breach?: boolean;
  counted_at?: string;
}

/** Mirrors the commit response of POST …/schedule-by-best-time. */
export interface BestTimeScheduleCommit {
  campaign_id?: string;
  scheduled?: number;
  within_days?: number;
  truncated?: boolean;
  strategy?: string;
  reference_at?: string;
  first_5?: BestTimeSample[];
}

/**
 * The scheduling window. The gateway defaults to 7 and clamps <1 up to 7; the
 * phone offers the three windows that mean something operationally rather than
 * a free-text number.
 */
export const BEST_TIME_WINDOWS = [
  { value: 1, label: "1 day" },
  { value: 3, label: "3 days" },
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
] as const;

export type BestTimeWindow = (typeof BEST_TIME_WINDOWS)[number]["value"];

export const DEFAULT_BEST_TIME_WINDOW: BestTimeWindow = 7;

export function isBestTimeWindow(value: unknown): value is BestTimeWindow {
  return BEST_TIME_WINDOWS.some((w) => w.value === value);
}

/**
 * The request body shared by the preview and the commit.
 *
 * Both endpoints take the SAME shape deliberately (schedule_preview.go) so a
 * client can ship one form state to both; sending a different body to each is
 * exactly how the "preview showed 9am, the schedule fired at 3am" class of bug
 * happened on desktop before p0-sto-schedule-strategy.
 *
 * `reference_at` is the anchor the hour-of-week math is measured from, so the
 * sheet's own date wheel keeps meaning something in best-time mode: it stops
 * being "the moment everyone receives this" and becomes "start counting from
 * here". An invalid date is omitted rather than sent, because the gateway
 * silently falls back to server-now on a malformed value and the operator
 * would never learn their anchor was ignored.
 */
export function bestTimeRequestBody(input: {
  withinDays: number;
  referenceAt?: Date | null | undefined;
}): { within_days: number; strategy: string; reference_at?: string } {
  const withinDays = isBestTimeWindow(input.withinDays)
    ? input.withinDays
    : DEFAULT_BEST_TIME_WINDOW;
  const at = input.referenceAt;
  const usable = at instanceof Date && Number.isFinite(at.getTime());
  return {
    within_days: withinDays,
    strategy: "per_recipient",
    ...(usable ? { reference_at: at.toISOString() } : {}),
  };
}

/** One rendered histogram column. */
export interface BestTimeHourBar {
  hour: number;
  count: number;
  /** 0..1 of the busiest hour, for a width percentage. */
  ratio: number;
  /** "09" — the two-character axis tick. */
  label: string;
  /**
   * The exact spoken value beside the compacted column, so a screen reader
   * never has to infer a number from a bar's width.
   */
  spoken: string;
  /** True for the single busiest hour, so it can be marked without colour. */
  peak: boolean;
}

function readCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Exactly 24 bars, hour 0..23, whatever the gateway sent.
 *
 * The handler documents that it always returns 24 buckets including empty
 * hours, but a chart that trusts that and indexes positionally renders a
 * corrupt axis the first time a proxy or an older build disagrees. Reading by
 * `hour` and filling the gaps costs nothing and makes the axis unfalsifiable.
 */
export function bestTimeHourBars(
  distribution: readonly BestTimeBucket[] | null | undefined,
): BestTimeHourBar[] {
  const counts = new Array<number>(24).fill(0);
  for (const bucket of distribution ?? []) {
    const hour = bucket?.hour;
    if (typeof hour !== "number" || !Number.isInteger(hour)) continue;
    if (hour < 0 || hour > 23) continue;
    counts[hour] = (counts[hour] ?? 0) + readCount(bucket.count);
  }
  const max = counts.reduce((a, b) => (b > a ? b : a), 0);
  const peakHour = max > 0 ? counts.indexOf(max) : -1;
  return counts.map((count, hour) => ({
    hour,
    count,
    ratio: max > 0 ? count / max : 0,
    label: String(hour).padStart(2, "0"),
    spoken: `${String(hour).padStart(2, "0")}:00 UTC, ${plural(count, "recipient")}`,
    peak: hour === peakHour && count > 0,
  }));
}

/** The busiest hour, or null when nothing was scheduled. */
export function bestTimePeakBar(
  bars: readonly BestTimeHourBar[],
): BestTimeHourBar | null {
  return bars.find((bar) => bar.peak) ?? null;
}

/**
 * The one sentence above the histogram.
 *
 * `scheduled === 0` is not an error and must not read like one — it is what a
 * campaign with no resolvable audience, or a workspace with no engagement
 * history yet, honestly looks like.
 */
export function bestTimeHeadline(
  preview: BestTimeSchedulePreview | null | undefined,
): string {
  const scheduled = readCount(preview?.scheduled);
  const days = readCount(preview?.within_days) || DEFAULT_BEST_TIME_WINDOW;
  if (!preview) return "Preview the schedule before committing it.";
  if (scheduled === 0) {
    return "No recipients could be scheduled — this audience has no send-time history yet.";
  }
  return `${plural(scheduled, "recipient")} spread over the next ${plural(days, "day")}, each at their own best hour.`;
}

export type BestTimeNoticeTone = "info" | "warning" | "danger";

export interface BestTimeNotice {
  key: string;
  tone: BestTimeNoticeTone;
  message: string;
}

/**
 * Everything the preview knows that should stop, or at least slow, a commit.
 *
 * Ordered most-severe first so a caller that renders only the first one still
 * renders the one that matters. Each notice states the number AND what to do
 * about it — "warmup_cap_breach: true" is a fact, "split the send or wait a
 * day" is the reason the fact was surfaced.
 */
export function bestTimeNotices(
  preview: BestTimeSchedulePreview | null | undefined,
): BestTimeNotice[] {
  if (!preview) return [];
  const out: BestTimeNotice[] = [];

  const cap = readCount(preview.tier_cap_today);
  const perDay = readCount(preview.max_per_day);
  if (preview.warmup_cap_breach === true && cap > 0 && perDay > 0) {
    const day =
      typeof preview.peak_day_utc === "string" ? preview.peak_day_utc : "";
    out.push({
      key: "warmup",
      tone: "danger",
      message: `${num(perDay)} recipients land${day ? ` on ${day}` : " on the busiest day"}, above this workspace's warm-up cap of ${num(cap)}. Send-time limits will hold the rest back — split the campaign or widen the window.`,
    });
  }

  if (preview.truncated === true) {
    const hardCap = readCount(preview.hard_cap);
    out.push({
      key: "truncated",
      tone: "warning",
      message: hardCap
        ? `Only the first ${num(hardCap)} recipients were scheduled — the audience is larger than the per-campaign limit.`
        : "The audience is larger than the per-campaign limit, so only part of it was scheduled.",
    });
  }

  const perMinute = readCount(preview.max_per_minute);
  if (perMinute >= BURST_WARN_PER_MINUTE) {
    out.push({
      key: "burst",
      tone: "warning",
      message: `${num(perMinute)} recipients land in a single minute. If your sending pool throttles, delivery for that spike will queue.`,
    });
  }

  return out;
}

/**
 * Above this, a single minute's landing count is worth mentioning. Chosen to
 * sit above the rate a small workspace can ever produce and below the rate at
 * which a shared SMTP pool starts deferring.
 */
export const BURST_WARN_PER_MINUTE = 500;

/**
 * The line under a committed schedule.
 *
 * Reads the commit response rather than the preview, because the two can
 * legitimately differ — recipients unsubscribe between the dry run and the
 * commit — and quoting the preview's number after the fact would be a lie.
 */
export function bestTimeCommitMessage(
  commit: BestTimeScheduleCommit | null | undefined,
): string {
  const scheduled = readCount(commit?.scheduled);
  const days = readCount(commit?.within_days) || DEFAULT_BEST_TIME_WINDOW;
  if (scheduled === 0) {
    return "No recipients matched, so nothing was scheduled.";
  }
  return `Scheduled ${plural(scheduled, "recipient")} at their own best hour over the next ${plural(days, "day")}.`;
}

/**
 * Honest failure copy, matching SendTimeOptBanner's policy: an endpoint that
 * does not exist on this deployment is a CAPABILITY message, not an error, and
 * neither ever fabricates a recommendation.
 */
export function bestTimeUnavailableMessage(
  status: number,
  message: string,
): string {
  if (status === 404 || status === 405 || status === 501) {
    return "Best-time scheduling isn't available on this workspace yet — it needs at least 30 days of engagement history.";
  }
  if (status === 403) {
    return "You don't have permission to schedule by best time in this workspace.";
  }
  const trimmed = message.trim();
  return trimmed
    ? `Couldn't preview the best-time schedule: ${trimmed}`
    : "Couldn't preview the best-time schedule.";
}
