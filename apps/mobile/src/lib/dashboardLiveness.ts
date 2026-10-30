/**
 * lib/dashboardLiveness.ts — what the dashboard's freshness badge is allowed
 * to claim.
 *
 * THE PROBLEM THIS EXISTS FOR. The badge said "Live" whenever the last
 * successful poll was under a minute old. That is a claim about a 30-second
 * timer, not about liveness: with the realtime stream dead, the badge kept
 * saying "Live" while the screen was, at best, up to thirty seconds behind and
 * — during a stall — arbitrarily further. Two different mechanisms were being
 * reported as one word.
 *
 * WHAT ACTUALLY MAKES THIS SCREEN LIVE. Not `GET /api/v1/dashboard/live`. That
 * endpoint is real (apps/api/internal/analytics/dashboard_live.go, 2s cadence,
 * 5-minute connection cap) and the desktop consumes it, but it is HARDCODED to
 * a 30-day window — `dashboardLiveStatsOptions()` returns `Range: "30d"` with
 * no way to ask for another. The mobile dashboard has a 7d/30d/90d control, so
 * two of its three windows would be painted with 30-day figures under a "Last
 * 7 days" label. A stream that silently answers a different question than the
 * one on screen is worse than a poll.
 *
 * What the phone has instead is better shaped for it: the app already holds an
 * authenticated event-bus stream (lib/eventCacheSync.ts) that invalidates the
 * `dashboard-stats` query root on every `campaign.*` / `subscriber.*` /
 * `approval.*` server event (api/event-cache-invalidation.ts). A change on the
 * server reaches the tiles in ~600ms of debounce, and nothing is transferred
 * while nothing happens — the opposite of a full stats payload every 2s on
 * cellular. The 30s poll is the SAFETY NET beneath that, not the mechanism.
 *
 * So the badge reports which of the two is actually carrying the screen, and
 * this module is the only place that decides. It is free of React Native
 * imports on purpose (`lib/i18n` and `lib/format` are too), so the rule is
 * testable under node.
 *
 * COPY LIVES IN THE CATALOGUE (DASHBOARD#83). The spoken forms used to be
 * template literals that appended `${age}` to the end of an English clause.
 * That is the exact shape lib/messagesEn.ts's rule 2 forbids: it freezes the
 * position of the age, and several languages put "read 4 minutes ago" at the
 * head of the sentence rather than the tail. Each spoken form is now one whole
 * frame carrying `{age}` where it belongs, so a translator can move it.
 */
import { msg } from "@/lib/i18n";

/** Health tones lib/eventBusStatus.ts maps the transport onto. */
export type StreamTone = "live" | "degraded" | "off";

export type LivenessTone = "live" | "degraded" | "idle";

export interface DashboardLiveness {
  /** Two-to-three words for the pill. Never the word "Live" for a poll. */
  label: string;
  tone: LivenessTone;
  /** Which mechanism the claim rests on. Drives the hint, not the colour. */
  mechanism: "push" | "poll" | "none";
  /** Sentence spoken by assistive tech; carries state AND mechanism AND age. */
  spoken: string;
}

export interface DashboardLivenessInput {
  /** Wall-clock ms of the last successful stats load; 0 when none. */
  lastUpdatedAt: number;
  now: number;
  /** The last poll failed. However recent the previous success, this is stale. */
  errored?: boolean;
  /**
   * Realtime stream tone, or "off" when the stream is closed/paused/idle.
   * Callers pass `eventBusFreshness().tone`.
   */
  stream: StreamTone;
  /** Rendered age, e.g. "4m ago". The caller formats it (locale lives there). */
  age: string;
}

/**
 * Past this the 30-second poll has demonstrably missed a beat, so even the
 * fallback mechanism has stopped being a live claim. Two intervals rather than
 * one: a single missed tick on a slow connection is not a fault.
 */
export const POLL_FRESH_WINDOW_MS = 60_000;

export function dashboardLiveness({
  lastUpdatedAt,
  now,
  errored = false,
  stream,
  age,
}: DashboardLivenessInput): DashboardLiveness {
  if (lastUpdatedAt <= 0) {
    // A FIRST LOAD THAT FAILED IS NOT A LOAD IN PROGRESS. This branch used to
    // answer "Loading" for every never-loaded screen, `errored` included,
    // because the never-loaded check ran BEFORE the error check. With the API
    // unreachable the dashboard therefore showed the pill "LOADING" beside
    // "Something went wrong loading the dashboard" for as long as the user
    // left it open — observed at two and a half minutes on device. Two claims,
    // one screen, opposite meanings; and the one that looks like progress is
    // the one that stops the user retrying.
    //
    // It stays a SEPARATE state from `stale` below rather than falling through
    // to it: `stale` says "these figures were read {age}", and here there are
    // no figures and no age to be honest about.
    return errored
      ? {
          label: msg("dashboard.live.label.failed"),
          tone: "idle",
          mechanism: "none",
          spoken: msg("dashboard.live.spoken.failed"),
        }
      : {
          label: msg("dashboard.live.label.loading"),
          tone: "idle",
          mechanism: "none",
          spoken: msg("dashboard.live.spoken.loading"),
        };
  }

  // A failed refresh outranks everything: an open stream does not make figures
  // that could not be re-read current.
  if (errored) {
    return {
      label: msg("dashboard.live.label.stale"),
      tone: "idle",
      mechanism: "none",
      spoken: msg("dashboard.live.spoken.stale", { age }),
    };
  }

  const pollFresh = now - lastUpdatedAt < POLL_FRESH_WINDOW_MS;

  if (stream === "live") {
    return {
      label: msg("dashboard.live.label.live"),
      tone: "live",
      mechanism: "push",
      spoken: msg("dashboard.live.spoken.live", { age }),
    };
  }

  if (stream === "degraded") {
    return {
      label: msg("dashboard.live.label.reconnecting"),
      tone: "degraded",
      mechanism: "poll",
      spoken: pollFresh
        ? msg("dashboard.live.spoken.reconnecting", { age })
        : msg("dashboard.live.spoken.reconnectingBehind", { age }),
    };
  }

  // Stream off. The poll is the only mechanism, and the badge says so rather
  // than borrowing the word the stream earns.
  return pollFresh
    ? {
        label: msg("dashboard.live.label.onTimer"),
        tone: "degraded",
        mechanism: "poll",
        spoken: msg("dashboard.live.spoken.onTimer", { age }),
      }
    : {
        label: msg("dashboard.live.label.idle"),
        tone: "idle",
        mechanism: "none",
        spoken: msg("dashboard.live.spoken.idle", { age }),
      };
}
