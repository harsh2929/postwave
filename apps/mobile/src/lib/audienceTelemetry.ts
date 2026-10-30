/**
 * audienceTelemetry — the audience cluster's domain events, in one place.
 *
 * Before this, the entire cluster (subscribers list, profile, lists, tags,
 * segments) emitted NOTHING. The only mobile signal was `mobile.tab_viewed`
 * from the bottom-tab layout, so there was no way to know whether anyone
 * searches, filters, opens a profile, tags or suppresses — and therefore no
 * data behind any decision about the surface.
 *
 * Call sites are one-liners on purpose: the property vocabulary lives in
 * src/lib/audienceTelemetryProps.ts (import-free and unit-tested), and every
 * key it produces is already on the sanitizer's allowlist, so no event here
 * can widen what leaves the device.
 *
 * `track()` is a no-op unless the operator has BOTH configured a PostHog key
 * and opted in, so these calls are safe to make unconditionally.
 */
import { EVENTS } from "@postwave/telemetry";

import { track } from "@/lib/telemetry";
import {
  audienceFilterProps,
  audienceSearchProps,
  audienceStatusProps,
  audienceSuppressProps,
  audienceTagProps,
  type AudienceFilterSource,
  type SuppressOutcome,
  type SuppressSource,
  type TagOutcome,
  type TagSource,
} from "@/lib/audienceTelemetryProps";

export function trackAudienceSearch(
  query: string,
  resultCount: number | undefined,
): void {
  track(EVENTS.SUBSCRIBER_SEARCHED, audienceSearchProps(query, resultCount));
}

export function trackAudienceFilter(
  filterKey: string,
  source: AudienceFilterSource,
): void {
  track(
    EVENTS.SUBSCRIBER_FILTER_APPLIED,
    audienceFilterProps(filterKey, source),
  );
}

/** Fired once per profile OPEN. Carries no subscriber id — it is PII-adjacent
 *  and the question this answers ("do people open profiles?") never needs it. */
export function trackSubscriberProfileViewed(source: string): void {
  track(EVENTS.SUBSCRIBER_PROFILE_VIEWED, {
    source: source === "deep_link" ? "deep_link" : "list",
  });
}

export function trackSubscriberTagged(
  outcome: TagOutcome,
  source: TagSource,
): void {
  track(EVENTS.SUBSCRIBER_TAGGED, audienceTagProps(outcome, source));
}

export function trackSubscriberStatusChanged(status: string): void {
  track(EVENTS.SUBSCRIBER_STATUS_CHANGED, audienceStatusProps(status));
}

export function trackSubscriberSuppressed(
  source: SuppressSource,
  outcome: SuppressOutcome,
): void {
  track(EVENTS.SUBSCRIBER_SUPPRESSED, audienceSuppressProps(source, outcome));
}
