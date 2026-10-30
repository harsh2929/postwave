/**
 * lib/campaignFormat.ts — the campaigns cluster's single formatting vocabulary.
 *
 * Before this module the same three helpers existed three times each, with
 * divergent behaviour:
 *
 *   - `fmtPct` in campaigns.tsx did not clamp, the copy in campaigns/[id].tsx
 *     clamped to 0–100, and abtest/ResultsCard.tsx did a third thing. The same
 *     malformed rate therefore rendered differently on the list, the detail and
 *     the A/B card.
 *   - `campaignTone` existed in campaigns.tsx, campaigns/[id].tsx and
 *     dashboard.tsx; the list version handled `paused`/`cancelled` and the
 *     DETAIL version did not, so a paused campaign got a warning pill in the
 *     list and a neutral one on its own screen.
 *   - Status pills rendered the raw backend enum (`running`, `finished`), which
 *     reads as an error to anyone who does not know the Listmonk lifecycle.
 *
 * Everything here is pure so it can be unit-tested; the views import it.
 * Numbers/dates route through `@/lib/format` rather than re-implementing
 * `toLocaleString`.
 */
import { num, percent, relativeTime, dateTime } from "@/lib/format";

export type CampaignTone = "success" | "warning" | "danger" | "neutral";

/**
 * The complete backend campaign lifecycle. Mirrors the Go constants in
 * apps/api/internal/campaigns/types.go plus the two Listmonk engine states
 * (`running`, `finished`) that reach the wire through the same column.
 */
export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "running",
  "finished",
  "sent",
  "paused",
  "cancelled",
  "failed",
] as const;

export type CampaignStatusName = (typeof CAMPAIGN_STATUSES)[number];

function normalizeStatus(status: string | null | undefined): string {
  const s = (status ?? "").trim().toLowerCase();
  return s.length > 0 ? s : "draft";
}

/**
 * Semantic colour for a status pill. `paused`/`cancelled` are handled here
 * once so the list and the detail screen can never disagree again.
 */
export function campaignTone(status: string | null | undefined): CampaignTone {
  switch (normalizeStatus(status)) {
    case "sent":
    case "running":
    case "finished":
      return "success";
    case "scheduled":
    case "sending":
    case "paused":
      return "warning";
    case "failed":
    case "cancelled":
      return "danger";
    default:
      return "neutral";
  }
}

/**
 * Human label for a status. `running`/`finished` are engine words for "the
 * send completed" — an operator should read "Sent". Unknown states are
 * title-cased rather than leaking raw, so a future backend state degrades
 * gracefully instead of shouting `queued_for_reprocess` at someone.
 */
export function campaignStatusLabel(status: string | null | undefined): string {
  const s = normalizeStatus(status);
  switch (s) {
    case "draft":
      return "Draft";
    case "scheduled":
      return "Scheduled";
    case "sending":
      return "Sending";
    case "running":
    case "finished":
    case "sent":
      return "Sent";
    case "paused":
      return "Paused";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return s
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
  }
}

/** True for a status where delivery has finished (successfully or not). */
export function isTerminalCampaignStatus(
  status: string | null | undefined,
): boolean {
  const s = normalizeStatus(status);
  return s === "sent" || s === "finished" || s === "cancelled" || s === "failed";
}

/**
 * WHICH CONVENTION A RATE ARRIVED IN — and why this has to be declared at
 * every call site rather than guessed.
 *
 * This backend genuinely uses BOTH conventions, on endpoints the campaign
 * screens read side by side:
 *
 *   FRACTION (0..1)
 *     GET /api/v1/campaigns              open_rate / click_rate
 *                                        (repo.go attachListRates:
 *                                         `float64(uOpens) / float64(denom)`)
 *     GET /api/v1/campaigns/{id}/ab-results   variant.rate
 *                                        (abtests/handlers.go:451 —
 *                                         `hits / RecipientsCount`, despite
 *                                         the local variable being named
 *                                         `ratePct`)
 *     GET /api/v1/campaigns/{id}/link-report  ctr
 *                                        (analytics/service.go:408)
 *     GET /api/v1/campaigns/{id}/goal-results conversion_rate
 *                                        (campaigns/goal_results.go:121)
 *     GET /api/v1/campaigns/{id}/holdout/lift held_out_click_rate /
 *                                        sent_click_rate (holdout.go:331
 *                                        `safeRate` = num/den)
 *
 *   PERCENT (0..100)
 *     GET /api/v1/campaigns/{id}/report  open_rate, click_rate,
 *                                        human_open_rate, human_click_rate,
 *                                        click_to_open_rate, bounce_rate,
 *                                        unsub_rate — all built by
 *                                        analytics.go:1460 `pct`, which ends
 *                                        `/ float64(denom) * 100.0`.
 *
 * The previous implementation guessed with `value > 1 ? value : value * 100`,
 * which is WRONG for the report on exactly the values that matter most: a
 * report open_rate of 1.0 means one percent and rendered as "100.0%", and a
 * genuine 0.5% rendered as "50.0%". A campaign whose open rate collapsed to
 * half a percent was the single case where the phone reported a triumph.
 * `format.ts::percent` was written against the same trap and says so.
 */
export type CampaignRateScale = "fraction" | "percent";

export interface CampaignRateOptions {
  /** Required: see CampaignRateScale for the per-endpoint map. */
  scale: CampaignRateScale;
  fallback?: string | undefined;
}

/**
 * Rate → a 0–100 number, or null when the value is not a usable measurement.
 * Null is deliberately distinct from 0: a missing rate is an em-dash, never a
 * zero-width bar. Clamped so a malformed rate can never draw "-50%"/"4200%".
 */
export function campaignRatePercent(
  value: unknown,
  scale: CampaignRateScale,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scaled = scale === "percent" ? value : value * 100;
  return Math.max(0, Math.min(100, scaled));
}

/** Engagement rate → display string. `scale` is required, by design. */
export function campaignRate(
  value: unknown,
  options: CampaignRateOptions,
): string {
  const scaled = campaignRatePercent(value, options.scale);
  if (scaled === null) return options.fallback ?? "—";
  return percent(scaled, { alreadyPercent: true, digits: 1 });
}

/** Count → display string, delegating to the shared number formatter. */
export function campaignCount(value: unknown, fallback = "—"): string {
  return num(value, fallback);
}

export interface CampaignDateFields {
  status?: string | null | undefined;
  scheduled_at?: string | null | undefined;
  sent_at?: string | null | undefined;
  created_at?: string | null | undefined;
}

export interface CampaignRowDate {
  /** "Sends", "Sent" or "Created" — the list row was previously unlabelled. */
  prefix: string;
  /** Relative rendering, e.g. "in 3 days" / "2h ago". */
  relative: string;
  /** Absolute rendering for the accessibility label. */
  absolute: string;
  /** The raw timestamp chosen, or null when the campaign has none. */
  iso: string | null;
}

/**
 * Which timestamp a campaign row should show, and what to call it.
 *
 * The list previously rendered `sent_at ?? created_at` with no qualifying
 * label, so "Mar 3" meant "sent on Mar 3" for one row and "created on Mar 3"
 * for the next — and a campaign scheduled for next Tuesday showed the day it
 * was CREATED, the single most misleading thing that row could say.
 */
export function campaignRowDate(
  campaign: CampaignDateFields | null | undefined,
): CampaignRowDate | null {
  if (!campaign) return null;
  const status = normalizeStatus(campaign.status);
  const scheduled = campaign.scheduled_at ?? null;
  const sent = campaign.sent_at ?? null;
  const created = campaign.created_at ?? null;

  if (status === "scheduled" && scheduled) {
    return describe("Sends", scheduled);
  }
  if (sent) return describe("Sent", sent);
  if (status === "scheduled" && !scheduled && created) {
    return describe("Created", created);
  }
  if (created) return describe("Created", created);
  return null;
}

function describe(prefix: string, iso: string): CampaignRowDate {
  return {
    prefix,
    relative: relativeTime(iso),
    absolute: dateTime(iso),
    iso,
  };
}
