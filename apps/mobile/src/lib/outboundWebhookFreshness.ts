/**
 * lib/outboundWebhookFreshness.ts — "has this endpoint delivered anything
 * lately?" from data the client already had.
 *
 * `GET /api/v1/outbound-webhooks` returns `last_succeeded_at` and
 * `last_failed_at`, and mobile parsed both and rendered neither: the row showed
 * the URL, the event pills and a bare `consecutive_failures` count. The
 * cheapest freshness win in the cluster was sitting in memory, unrendered.
 *
 * The ordering rule is the whole point: a webhook that succeeded on Monday and
 * has been failing since Tuesday must NOT read "Last delivered 4d ago" — the
 * most recent event wins, and when it is a failure the caller paints it in the
 * warning colour AND the text says "failure", so the state is never conveyed by
 * colour alone.
 *
 * Pure and free of React/native imports so the ordering can be unit-tested.
 */
import { dateTime, relativeTime } from "@/lib/format";

export interface WebhookFreshnessInput {
  last_succeeded_at?: string | null | undefined;
  last_failed_at?: string | null | undefined;
  consecutive_failures?: number | undefined;
}

export interface WebhookFreshness {
  /** Relative form, for the eye. */
  text: string;
  /** Absolute form, for assistive tech — a screen reader gets the real time. */
  spoken: string;
  /** True when the most recent recorded event was a failure. */
  failed: boolean;
}

function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function webhookFreshness(
  w: WebhookFreshnessInput,
): WebhookFreshness {
  const okAt = timeOf(w.last_succeeded_at);
  const badAt = timeOf(w.last_failed_at);
  const failures =
    typeof w.consecutive_failures === "number" && w.consecutive_failures > 0
      ? w.consecutive_failures
      : 0;

  if (badAt !== null && (okAt === null || badAt >= okAt)) {
    const suffix =
      failures > 0
        ? ` · ${failures} consecutive failure${failures === 1 ? "" : "s"}`
        : "";
    return {
      text: `Last failure ${relativeTime(badAt)}${suffix}`,
      spoken: `Last failure ${dateTime(badAt)}${suffix}`,
      failed: true,
    };
  }
  if (okAt !== null) {
    return {
      text: `Last delivered ${relativeTime(okAt)}`,
      spoken: `Last delivered ${dateTime(okAt)}`,
      failed: false,
    };
  }
  return {
    text: failures > 0 ? `No successful delivery yet · ${failures} failed attempt${failures === 1 ? "" : "s"}` : "No deliveries yet",
    spoken: failures > 0 ? `No successful delivery yet, ${failures} failed attempts` : "No deliveries yet",
    failed: failures > 0,
  };
}
