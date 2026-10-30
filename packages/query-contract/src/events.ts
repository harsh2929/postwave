/**
 * Canonical realtime-event → cache-resource authority — the single source of
 * truth for "when the server publishes event <topic>, which logical resources
 * did it dirty?", shared by every client's cache-invalidation layer.
 *
 * Before this module, web (apps/web/src/lib/realtime/event-query-map.ts),
 * desktop (apps/desktop/src/lib/cache-invalidator.ts) and mobile
 * (apps/mobile/src/api/event-cache-invalidation.ts) each hand-rolled their own
 * topic→resource table and they DISAGREED — e.g. an `approval.*` event
 * refreshed the dashboard+approvals queue on web, the *audit* feed on desktop
 * (a latent bug), and only the approvals queue on mobile. There was no shared
 * authority and no drift guard.
 *
 * This module owns the topic→resource decision ONCE. Each client keeps a small
 * `CanonicalResource → its own query-key(s)` adapter (key shapes legitimately
 * differ per surface — web/desktop use the `qk` tuple, mobile uses flat roots)
 * but derives WHICH resources to invalidate from `canonicalResourcesForEvent`
 * here. A per-client test asserts its adapter is TOTAL over
 * `CANONICAL_RESOURCES`, so no surface can silently drop a resource, and
 * because all three call this one function they can no longer disagree on the
 * mapping itself.
 *
 * The map keys off the topic's leading DOMAIN segment (`campaign.sent` →
 * `campaign`), so a newly-published concrete event under a known domain routes
 * correctly with no code change here — matching how the clients already
 * prefix-match. Collaboration topics (presence/cursor/selection) and the audit
 * *action* firehose that doesn't back a user-read query are intentionally
 * absent.
 */

/**
 * The client-agnostic resource vocabulary the invalidation layer reasons about.
 * These are logical domains, NOT any one client's query-key strings — each
 * client maps them to its own keys (web `qk`/`base`, desktop `[resource]`
 * prefixes, mobile flat roots incl. surface-local satellites like
 * `campaign-report`).
 */
export const CANONICAL_RESOURCES = [
  "campaigns",
  "campaign",
  "subscribers",
  "subscriber",
  "lists",
  "suppressions",
  "approvals",
  "audit",
  "dashboard",
  // The per-user in-app notification feed (the "bell"). Dirtied by the
  // server's `notification.created` fanout event (notifyfanout.Dispatch), so a
  // bell can react in realtime instead of polling.
  "notificationFeed",
  // Account deliverability health — the hub score, grade, threshold breaches,
  // blocklist listings and auto-throttle state. Dirtied by the hub worker's
  // `list_health.degraded` echo. This is the screen an operator opens when a
  // send is crawling at 2am, so a 60s staleTime is the wrong answer during an
  // active degradation.
  "deliverability",
  // The referral program's stats, leaderboard and program config. Dirtied by
  // `referral.milestone.unlocked` / `referral.payout.pending`, both of which
  // change numbers a user is watching.
  "referrals",
] as const;

export type CanonicalResource = (typeof CANONICAL_RESOURCES)[number];

/**
 * The event domains that back a cache-invalidatable resource.
 *
 * A domain belongs here only if the Go gateway actually calls `Bus.Publish`
 * with a topic under it. Deliberately ABSENT, with reasons, so the omissions
 * read as decisions rather than oversights:
 *
 *   - `account.*` (`account.compliance_suspend` / `.deactivate` /
 *     `.reactivate`) — the reserved emitter is guarded by explicit release
 *     locks because no authoritative account suspension/lifecycle state or
 *     paired mutation exists. Subscription deletion only removes paid sending
 *     and retains Studio access; dunning recovery is a separate debt state.
 *     Mapping those as deactivate/reactivate would publish a false lifecycle.
 *     Add the domain only with the future account-state owner and its durable
 *     transition contract.
 *   - `presence.*` / `cursor.*` / `selection.*` — collaboration transport,
 *     backs no cached query.
 *
 * `list.*` IS live: `subscribers/bulk_operations.go` emits
 * `outbound_webhooks.EventListSubscriberAdded` ("list.subscriber.added") through
 * `Deps.emit` → `Bus.Publish` on every bulk add-to-list. Do not remove it or
 * mobile's `list.*` subscription — the other `list.*` strings in the API are
 * audit-action names, which is what makes this one easy to mistake for dead.
 */
export const EVENT_DOMAINS = [
  "campaign",
  "subscriber",
  "list",
  "approval",
  "audit",
  "notification",
  "list_health",
  "referral",
] as const;

export type EventDomain = (typeof EVENT_DOMAINS)[number];

/**
 * Subscriber topics that additionally dirty the suppression list. A generic
 * subscriber edit does not; only deliverability-terminal transitions do. Kept
 * precise (rather than "any subscriber event") so a live-send engagement storm
 * doesn't needlessly refetch the suppressions view.
 */
const SUPPRESSION_TOPICS = new Set<string>([
  "subscriber.bounced",
  "subscriber.complained",
  "subscriber.unsubscribed",
]);

/**
 * The grammar for a `?topics=` stream-filter entry, as a pattern SOURCE string
 * so the Go and TypeScript copies can be compared character-for-character by
 * `scripts/check-event-map-parity.mjs`.
 *
 * This grammar was previously hand-copied into three places — the Go handler,
 * `apps/desktop/src/lib/event-bus-topics.ts`, and
 * `apps/mobile/src/api/event-bus-topics.ts` — and all three omitted `_` from
 * the segment character class while the gateway published `list_health.degraded`,
 * `subscriber.engagement_updated`, `subscriber.lifecycle_stage_changed` and
 * others. Every filter naming one of those topics was silently discarded: the
 * client asked, the server dropped it, and nothing logged or failed. Desktop
 * even listed `subscriber.lifecycle_stage_changed` in its own concrete-topic
 * array and never received it.
 *
 * Underscores cannot widen a match. The server's `matchOne` trims a `*` suffix
 * and prefix-compares the remainder INCLUDING its trailing dot, so `list.*`
 * (→ `list.`) and `list_health.*` (→ `list_health.`) stay disjoint.
 */
/**
 * Server-side bounds on a `?topics=` filter list (apps/api/internal/events/
 * handler.go `parseTopics`), shared so the STREAM and the REPLAY paths cannot
 * degrade differently.
 *
 * Exceeding either is not a partial degradation. On the stream an oversized CSV
 * makes the gateway substitute its no-match sentinel — the connection stays
 * open and delivers nothing. On replay it means every page comes back empty
 * while the cursor keeps advancing, so the gap is skipped rather than
 * recovered. Two hand-copied bounds is how those two silent failures become
 * different silent failures.
 */
export const MAX_EVENT_TOPIC_FILTERS = 50;
export const MAX_EVENT_TOPICS_CSV_CHARS = 1024;
export const MAX_EVENT_TOPIC_BYTES = 128;

/**
 * Reduce a topic list to what the gateway will actually accept, or null when
 * it would be rejected wholesale.
 *
 * Each bound mirrors what `parseTopics` in apps/api/internal/events/handler.go
 * actually does, because a client that degrades DIFFERENTLY from the gateway is
 * a second contract:
 *
 *   - CSV byte cap exceeded → the gateway substitutes its no-match sentinel and
 *     delivers nothing. Null here, so the caller sends `*` (stream) or omits
 *     the filter (replay): noisy, but not silently blind.
 *   - Entry count exceeded → the gateway `break`s at the cap, keeping the first
 *     N. Truncate identically. Returning null instead would WIDEN a
 *     subscription the server would have narrowed — a different wrong answer,
 *     not a safer one.
 *   - A single entry over the per-entry byte cap, or one that fails the
 *     grammar → the gateway drops that entry and keeps the rest. Same here.
 *
 * An earlier version of this comment claimed truncation was never an option,
 * while the code truncated. The code was right.
 */
export function usableEventTopicFilters(
  topics: readonly string[],
): readonly string[] | null {
  const kept: string[] = [];
  for (const topic of topics) {
    if (kept.length >= MAX_EVENT_TOPIC_FILTERS) break;
    if (!isValidEventTopicFilter(topic) || kept.includes(topic)) continue;
    if (topic.length > MAX_EVENT_TOPIC_BYTES) continue;
    kept.push(topic);
  }
  if (kept.length === 0) return null;
  return kept.join(",").length > MAX_EVENT_TOPICS_CSV_CHARS ? null : kept;
}

export const EVENT_TOPIC_FILTER_PATTERN =
  "^(\\*|[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*(\\.\\*)?)$";

const EVENT_TOPIC_FILTER_RE = new RegExp(EVENT_TOPIC_FILTER_PATTERN);

/**
 * Whether a topic filter will survive the gateway's `?topics=` parser. A client
 * MUST validate with this before treating a topic as subscribed — an invalid
 * entry is dropped silently, which is indistinguishable from an event that
 * never fires.
 */
export function isValidEventTopicFilter(topic: string): boolean {
  if (typeof topic !== "string") return false;
  return EVENT_TOPIC_FILTER_RE.test(topic);
}

/** The leading domain segment of a dotted topic (`campaign.sent` → `campaign`). */
export function eventDomain(topic: string): string {
  if (typeof topic !== "string") return "";
  const dot = topic.indexOf(".");
  return dot === -1 ? topic : topic.slice(0, dot);
}

const DOMAIN_RESOURCES: Record<EventDomain, readonly CanonicalResource[]> = {
  // A campaign lifecycle event refreshes the list, that campaign's detail, and
  // the dashboard (counts / recent-activity live there).
  campaign: ["campaigns", "campaign", "dashboard"],
  // A subscriber change refreshes the list, that subscriber's detail, and the
  // dashboard tiles. Suppression views are added only for terminal topics
  // (see SUPPRESSION_TOPICS).
  subscriber: ["subscribers", "subscriber", "dashboard"],
  // List membership changes shift subscriber counts/segments.
  list: ["lists", "subscribers"],
  // An approval decision refreshes the approvals queue and the dashboard's
  // pending-work card. (NOT the audit feed — that was the desktop bug.)
  approval: ["approvals", "dashboard"],
  // Audit events refresh the audit feed only.
  audit: ["audit"],
  // A server-authored notification (notifyfanout `notification.created`)
  // refreshes the in-app notification feed / bell.
  notification: ["notificationFeed"],
  // The hub worker's degradation echo (deliverability_hub/hub.go emitDegraded).
  // Only the deliverability surfaces — the score does not appear on any
  // dashboard tile, and the mobile home-screen widget mirrors the hub query,
  // so refreshing the hub cascades to it without a second entry here.
  list_health: ["deliverability"],
  // Referral milestone / payout events move the numbers on the referral
  // stats, leaderboard and program views and nothing else.
  referral: ["referrals"],
};

/**
 * The canonical resources a realtime event dirties, or `[]` for an unknown /
 * collaboration / non-cache-relevant topic (so a client that predates a new
 * server event simply no-ops rather than crashing). Deduplicated, order-stable.
 */
export function canonicalResourcesForEvent(
  topic: string,
): readonly CanonicalResource[] {
  const domain = eventDomain(topic);
  const base = DOMAIN_RESOURCES[domain as EventDomain];
  if (!base) return [];
  if (domain === "subscriber" && SUPPRESSION_TOPICS.has(topic)) {
    return [...base, "suppressions"];
  }
  // Return a copy, never the shared DOMAIN_RESOURCES reference, so a caller
  // can't mutate the authoritative table. (Typed readonly, but belt-and-braces.)
  return [...base];
}

/** Whether a topic maps to at least one cache-invalidatable resource. */
export function isInvalidatingTopic(topic: string): boolean {
  return canonicalResourcesForEvent(topic).length > 0;
}
