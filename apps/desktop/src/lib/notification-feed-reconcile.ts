/**
 * notification-feed-reconcile — the pure rules for keeping desktop's local
 * notification vault in agreement with the server notification feed.
 *
 * WHY THIS EXISTS
 *
 * Desktop was the only client with a private notification store. Web
 * (`lib/notification-feed-api.ts`) and mobile (`api/notifications.ts`) both read
 * `GET /api/v1/notifications`; desktop kept an encrypted local vault
 * (`lib/notification-center.ts`) and never called the endpoint. Read/unread was
 * therefore not one truth: marking something read on a phone left it bold on
 * the desktop, and "mark all read" on the desktop meant nothing anywhere else.
 *
 * WHAT CORRELATION HAS TO SURVIVE
 *
 * The vault and the feed describe the same notification with DIFFERENT values,
 * and a first version of this module assumed they matched. They do not:
 *
 *   - the vault's `topic` is a desktop-local name; the server's `kind` is a
 *     client-routing hint (`approval_request`) that is NOT the event type. The
 *     field that actually carries the canonical type is `event_type`
 *     (`notification_feed.go` selectCols; `notifyfanout.Event.Type`), and two
 *     desktop topics are spelled differently from it entirely —
 *     `dashboard.anomaly` → `analytics.anomaly`,
 *     `dashboard.milestone` → `audience.milestone`;
 *   - the vault's `deepLink` is a `moosewave://entity/id` custom-scheme link
 *     (validated through route-map's `parseDeepLink`), while the server writes
 *     a WEB path — `/app/campaigns/<id>`. Comparing the two strings can never
 *     match, for any topic;
 *   - titles diverge: the vault stores manifest copy ("Campaign sent") and the
 *     server renders per-record copy ("Campaign sent: Spring promo").
 *
 * So both sides are normalised to what they genuinely share: the canonical
 * event type, plus the ENTITY the notification is about, parsed out of whichever
 * link form that surface uses. Where no entity can be recovered the key is
 * marked WEAK, and weak keys are refused for anything that mutates state —
 * because the fallback (`type` + timestamp) collides by construction: several
 * approvals in one second all carry `/app/approvals` and "Approval needed".
 *
 * A false match HIDES a notification the user never saw. A miss costs one stale
 * bold row until the next pass. Those are not comparable, which is why every
 * ambiguity here resolves to "do nothing".
 */

import { parseDeepLink, parseUniversalLink } from "@postwave/route-map";

import type {
  DesktopNotificationTopic,
  NotificationCenterEntry,
  NotificationDeliveryState,
} from "./notification-center";

/** The server feed row (GET /api/v1/notifications), as it is actually served. */
export interface ServerFeedItem {
  id: string;
  /** Client-routing hint (`approval_request`) — NOT the event type. */
  kind: string;
  /** The canonical manifest event type. This is the field that correlates. */
  event_type?: string;
  title: string;
  body?: string;
  /** A WEB path (`/app/campaigns/<id>`), not a `moosewave://` link. */
  deep_link?: string;
  seen_at?: string;
  read_at?: string;
  created_at: string;
}

/**
 * Desktop topics whose canonical server `event_type` is spelled differently.
 *
 * Verified against the producers: `dashboardnotify.go` dispatches
 * `EventAnomaly = "analytics.anomaly"` and `EventMilestone =
 * "audience.milestone"`. The other three desktop topics
 * (`approval.requested`, `campaign.sent`, `subscriber.bounced`) match their
 * `event_type` exactly.
 */
const SERVER_EVENT_TYPE_FOR_TOPIC: Partial<
  Record<DesktopNotificationTopic, string>
> = {
  "dashboard.anomaly": "analytics.anomaly",
  "dashboard.milestone": "audience.milestone",
};

export interface CorrelationKey {
  key: string;
  /**
   * False when the key had to fall back to `type + timestamp` because no entity
   * could be recovered from either side's link. Weak keys collide by
   * construction and must never drive a state change.
   */
  strong: boolean;
}

/** Second-precision ISO timestamp — sub-second jitter must not break a match. */
function toSecond(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(Math.floor(at / 1000) * 1000).toISOString();
}

/**
 * `entity/id` from either link form, or null.
 *
 * Both surfaces address the same record; they just spell the link differently.
 * route-map already parses both grammars, so the entity reference is recovered
 * rather than string-matched.
 */
function entityRef(link: string | null | undefined): string | null {
  if (!link) return null;
  const ref = link.startsWith("moosewave://")
    ? parseDeepLink(link)
    : parseUniversalLink(link);
  return ref ? `${ref.entity}/${ref.id}` : null;
}

function buildKey(
  eventType: string,
  createdAt: string,
  link: string | null | undefined,
): CorrelationKey | null {
  if (!eventType) return null;
  const ref = entityRef(link);
  if (ref) return { key: `${eventType}${ref}`, strong: true };
  const second = toSecond(createdAt);
  if (!second) return null;
  return { key: `${eventType}@${second}`, strong: false };
}

export const correlationKey = {
  forServer(item: ServerFeedItem): CorrelationKey | null {
    // `event_type` is the canonical type; `kind` is a routing hint and must not
    // be substituted for it. A row without one cannot be correlated at all.
    return item.event_type
      ? buildKey(item.event_type, item.created_at, item.deep_link)
      : null;
  },
  forLocal(entry: NotificationCenterEntry): CorrelationKey | null {
    const eventType =
      SERVER_EVENT_TYPE_FOR_TOPIC[entry.topic] ?? (entry.topic as string);
    return buildKey(eventType, entry.createdAt, entry.deepLink);
  },
};

/**
 * Index one side by correlation key, dropping every key that is weak or that
 * more than one record claims.
 *
 * Refusing an ambiguous key on BOTH sides is what stops one local read from
 * marking N server rows read — the failure mode where a user opens one approval
 * and three others silently vanish from their phone.
 */
function indexUnambiguous<T>(
  records: readonly T[],
  keyOf: (record: T) => CorrelationKey | null,
): Map<string, T> {
  const byKey = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const record of records) {
    const correlation = keyOf(record);
    if (!correlation || !correlation.strong) continue;
    if (byKey.has(correlation.key)) {
      ambiguous.add(correlation.key);
      continue;
    }
    byKey.set(correlation.key, record);
  }
  for (const key of ambiguous) byKey.delete(key);
  return byKey;
}

export function indexLocalEntries(
  local: readonly NotificationCenterEntry[],
): Map<string, NotificationCenterEntry> {
  return indexUnambiguous(local, (entry) => correlationKey.forLocal(entry));
}

export function indexServerItems(
  server: readonly ServerFeedItem[],
): Map<string, ServerFeedItem> {
  return indexUnambiguous(server, (item) => correlationKey.forServer(item));
}

/**
 * Correlation keys the SERVER already considers read — the "pull" input.
 * Ambiguous keys are excluded, so an unresolvable row never marks anything.
 */
export function serverReadKeys(server: readonly ServerFeedItem[]): Set<string> {
  const keys = new Set<string>();
  for (const [key, item] of indexServerItems(server)) {
    if (item.read_at) keys.add(key);
  }
  return keys;
}

/**
 * Server ids to POST `/{id}/read` for, so read state set on THIS machine
 * survives the cutover to the shared feed.
 *
 * Idempotent: a row that already carries `read_at` is skipped, so a second pass
 * after a successful push sends nothing. Every id returned corresponds to
 * exactly one local entry and one server row.
 */
export function readMarkersToPushUp({
  server,
  local,
}: {
  server: readonly ServerFeedItem[];
  local: readonly NotificationCenterEntry[];
}): string[] {
  const localByKey = indexLocalEntries(local);
  const ids: string[] = [];
  for (const [key, item] of indexServerItems(server)) {
    if (item.read_at) continue;
    if (localByKey.get(key)?.readAt) ids.push(item.id);
  }
  return ids;
}

/**
 * One row of the desktop bell.
 *
 * A UNION, not the server list. An earlier version returned only server rows
 * and dropped local-only entries as "pre-cutover history" — correct for a
 * strict server-authority view, and wrong for the panel: applying it would have
 * silently deleted history the user can see today, the moment the feed loaded.
 * A notification the user can still see is not history to be discarded.
 *
 *   both   correlated pair — SERVER owns read, LOCAL owns delivery + archive
 *   server raised on another device; this machine has no delivery ledger for it
 *   local  pre-cutover, or an event the server never issued (a desktop-only
 *          dashboard anomaly)
 */
export interface UnifiedNotificationRow {
  /** Stable render key. Not an id: a row may have one, both, or either. */
  key: string;
  /** Set when a vault entry backs this row — archive and open need it. */
  localId: string | null;
  /** Set when a feed row backs it — the read API only accepts server ids. */
  serverId: string | null;
  source: "both" | "server" | "local";
  /** Canonical event type, from whichever side carries it. */
  eventType: string;
  title: string;
  body: string;
  /** Either grammar; `destinationForNotification` normalizes both. */
  deepLink: string | null;
  createdAt: string;
  /** Server-owned when correlated — the value every device agrees on. */
  readAt: string | null;
  seenAt: string | null;
  /** Local-only: the server models no archive state. */
  archivedAt: string | null;
  /** Local-only. `unknown` for a row this machine never delivered. */
  delivery: NotificationDeliveryState | "unknown";
  topic: DesktopNotificationTopic | null;
}

/** Newest first; unparseable timestamps sort last rather than yielding NaN. */
function byNewest(a: { createdAt: string }, b: { createdAt: string }): number {
  const at = Date.parse(a.createdAt);
  const bt = Date.parse(b.createdAt);
  if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
  if (!Number.isFinite(at)) return 1;
  if (!Number.isFinite(bt)) return -1;
  return bt - at;
}

/**
 * The rows the bell renders: every server row and every local entry, correlated
 * pairs collapsed into one.
 *
 * Weak-correlation rows are NOT merged. Three approvals in the same second are
 * indistinguishable to the correlator, so collapsing them would hide two
 * notifications; they render as three rows instead. Under-merging costs a
 * duplicate; over-merging costs a notification the user never sees.
 */
export function unifiedNotificationRows({
  server,
  local,
}: {
  server: readonly ServerFeedItem[];
  local: readonly NotificationCenterEntry[];
}): UnifiedNotificationRow[] {
  const localByKey = indexLocalEntries(local);
  const serverByKey = indexServerItems(server);
  const consumedLocalIds = new Set<string>();
  const rows: UnifiedNotificationRow[] = [];

  for (const item of server) {
    const correlation = correlationKey.forServer(item);
    const entry =
      correlation?.strong && serverByKey.has(correlation.key)
        ? localByKey.get(correlation.key)
        : undefined;
    if (entry) consumedLocalIds.add(entry.id);
    rows.push({
      key: entry ? entry.id : `srv:${item.id}`,
      localId: entry?.id ?? null,
      serverId: item.id,
      source: entry ? "both" : "server",
      eventType: item.event_type ?? item.kind,
      title: item.title,
      body: item.body ?? "",
      deepLink: item.deep_link ?? null,
      createdAt: item.created_at,
      // EITHER side's marker clears the row. Read is monotonic (see
      // `applyServerReadState`), so taking the local one while the feed catches
      // up cannot un-read anything — and without it, opening a correlated row
      // left it bold until the next sync, because the click marks the VAULT and
      // `lastFeed` still says unread.
      readAt: item.read_at ?? entry?.readAt ?? null,
      seenAt: item.seen_at ?? null,
      archivedAt: entry?.archivedAt ?? null,
      delivery: entry?.delivery ?? "unknown",
      topic: entry?.topic ?? null,
    });
  }

  for (const entry of local) {
    if (consumedLocalIds.has(entry.id)) continue;
    rows.push({
      key: entry.id,
      localId: entry.id,
      serverId: null,
      source: "local",
      eventType:
        SERVER_EVENT_TYPE_FOR_TOPIC[entry.topic] ?? (entry.topic as string),
      title: entry.title,
      body: entry.body,
      deepLink: entry.deepLink,
      createdAt: entry.createdAt,
      readAt: entry.readAt,
      seenAt: null,
      archivedAt: entry.archivedAt,
      delivery: entry.delivery,
      topic: entry.topic,
    });
  }

  return rows.sort(byNewest);
}
