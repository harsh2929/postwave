/**
 * lib/campaignProgress.ts — "is this still going out, and how far along?"
 *
 * A campaign in `sending` looked EXACTLY like one that had finished: the same
 * four tiles, the same static numbers, no denominator and no motion. The one
 * moment an operator most wants their phone — the send is running, is it
 * working? — was the moment the screen said least.
 *
 * The numbers already exist. `report.sent` is the numerator; the audience
 * count from GET /campaigns/{id}/send-preview is the denominator. This module
 * is the pure reading of the two, so the polling policy and the copy are
 * testable without a renderer.
 */
import { num, plural } from "@/lib/format";

/** Statuses where delivery is actively in flight. */
const LIVE_STATUSES = new Set(["sending", "running", "queued", "processing"]);

export function isLiveSendStatus(status: string | null | undefined): boolean {
  return LIVE_STATUSES.has((status ?? "").trim().toLowerCase());
}

/**
 * How often to re-read the report while a send is live. Ten seconds is the
 * same cadence desktop polls at; the query only runs while the app is
 * foregrounded because TanStack's focusManager is bridged to AppState
 * (src/lib/connectivity.ts), so this does not burn a backgrounded battery.
 */
export const LIVE_SEND_POLL_MS = 10_000;

export interface SendProgressInput {
  status?: string | null | undefined;
  /** `report.sent` — messages handed to the provider so far. */
  sent?: number | null | undefined;
  /** `report.delivered` — accepted by the receiving server. */
  delivered?: number | null | undefined;
  /** Audience size from the send-preview endpoint. */
  audience?: number | null | undefined;
}

export interface SendProgress {
  /** True when this campaign is actively sending. */
  live: boolean;
  /** 0..1, or null when the denominator is unknown. */
  fraction: number | null;
  /** "4,201 of 12,483 sent" — or an honest partial when there is no total. */
  headline: string;
  /** Spoken form; never a bare percentage without the counts. */
  spoken: string;
  /** True when the totals prove the send has reached everyone. */
  complete: boolean;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function sendProgress(input: SendProgressInput): SendProgress {
  const live = isLiveSendStatus(input.status);
  const sent = count(input.sent);
  const delivered = count(input.delivered);
  const audience = count(input.audience);

  if (sent === null) {
    return {
      live,
      fraction: null,
      headline: "Sending — no delivery events have arrived yet.",
      spoken: "Sending. No delivery events have arrived yet.",
      complete: false,
    };
  }

  if (audience === null || audience === 0) {
    // No denominator: state the numerator plainly rather than inventing a
    // percentage out of a total nobody supplied.
    return {
      live,
      fraction: null,
      headline: `${plural(sent, "message")} sent so far`,
      spoken: `${num(sent)} messages sent so far. The audience total isn't available.`,
      complete: false,
    };
  }

  const fraction = Math.max(0, Math.min(1, sent / audience));
  const pct = Math.round(fraction * 100);
  return {
    live,
    fraction,
    headline: `${num(sent)} of ${num(audience)} sent`,
    spoken: `${num(sent)} of ${num(audience)} sent, ${pct} percent${
      delivered !== null ? `. ${num(delivered)} delivered` : ""
    }.`,
    complete: sent >= audience,
  };
}
