/**
 * lib/notificationRoutes.ts — where a tapped notification LANDS.
 *
 * Carved out of lib/deepLinks.ts, which had grown to hold four unrelated
 * grammars at once (auth links, entity links, device-approve links, and this).
 * The split is not cosmetic: this table is the half that must stay in step with
 * the shared @postwave/notifications manifest, and `src/lib/pushRoutingContract
 * .test.ts` fails the build when a push-eligible event has no arm here. Keeping
 * it in a 450-line file with three other parsers meant every new push event was
 * competing for space with URL parsing it has nothing to do with.
 *
 * A TABLE, NOT A SWITCH. The previous switch had one `case` per event and a
 * `default: return null`; adding the operational events (webhook auto-disable,
 * billing dunning) would have pushed its cyclomatic complexity past the source
 * budget, and — worse — a long switch invites the drift the contract test
 * exists to catch. A lookup keyed by the manifest's own event names makes a
 * missing arm visible as a missing key.
 *
 * `null` STAYS THE ANSWER FOR AN UNKNOWN EVENT. An older build meeting a newer
 * server has no correct destination, and guessing one would drop the user on a
 * screen the notification was not about. The caller
 * (`usePushResponseRouting`) treats null as "do not navigate".
 */
import type { NotificationResponse } from "expo-notifications";
import type { Href } from "expo-router";
import { notificationTopicDestination } from "@postwave/notifications";

import { routeForNavSlug } from "./navDeepLinks";
import { utf8ByteLength } from "./utf8";

// Best-effort shape; we narrow with runtime checks.
export type EnvelopeLike = {
  event_type?: unknown;
  body?: unknown;
  /** Top-level id used by the actionable-push envelope (lib/push.ts). */
  entity_id?: unknown;
};

const MAX_NOTIFICATION_BODY_JSON_BYTES = 32 * 1024;
const MAX_NOTIFICATION_ROUTE_PARAM_CHARS = 256;

/**
 * The detail route for the entity a notification is about, falling back to its
 * list when the envelope carries no id.
 *
 * Every entity arm wants exactly this, and writing it out four times was both
 * repetition and a real hazard: the approvals arm learned to accept the
 * actionable-push envelope's top-level `entity_id` while the others still only
 * read `body.id`, so the same push shape resolved on one surface and silently
 * dropped to a list on another. One helper, one answer.
 */
function detailOrList(envelope: EnvelopeLike, listRoute: string): Href {
  const id =
    pickStringProp(envelope.body, "id") ??
    pickStringProp(envelope, "entity_id");
  if (!id) return listRoute as unknown as Href;
  return {
    pathname: `${listRoute}/[id]`,
    params: { id },
  } as unknown as Href;
}

/** A destination that ignores the envelope — the list IS the target. */
function listOnly(route: string): (envelope: EnvelopeLike) => Href {
  return () => route as unknown as Href;
}

function detail(listRoute: string): (envelope: EnvelopeLike) => Href {
  return (envelope) => detailOrList(envelope, listRoute);
}

/**
 * Form events predate the native Forms surface and carry `form_id`, not the
 * generic `id` used by campaign/subscriber notifications. Keep that wire
 * contract explicit so a submission id can never be mistaken for the form the
 * reader is trying to inspect.
 */
function formDetail(envelope: EnvelopeLike): Href {
  const id =
    pickStringProp(envelope.body, "form_id") ??
    pickStringProp(envelope.body, "formId") ??
    pickStringProp(envelope, "entity_id");
  if (!id) return "/(tabs)/forms" as unknown as Href;
  return {
    pathname: "/(tabs)/forms/[id]",
    params: { id },
  } as unknown as Href;
}

/**
 * event → destination. Keys are the shared manifest's event names verbatim;
 * `pushRoutingContract.test.ts` asserts every push-eligible manifest event has
 * one, so this table cannot quietly fall behind the server.
 */
const NOTIFICATION_ROUTES: Record<string, (envelope: EnvelopeLike) => Href> = {
  // Account-security events are not route-map entities. The opaque entity_id
  // is an exact session-revocation target for the authenticated action handler;
  // a normal tap opens Settings, where Active devices shows current truth.
  "auth.new_device_sign_in": listOnly("/(tabs)/settings"),

  // `subscriber.updated` is not in the manifest but has historically arrived
  // from the raw webhook envelope; keeping it costs nothing and losing it
  // would be a silent regression.
  "subscriber.created": detail("/(tabs)/subscribers"),
  "subscriber.updated": detail("/(tabs)/subscribers"),
  "subscriber.unsubscribed": detail("/(tabs)/subscribers"),
  "subscriber.bounced": detail("/(tabs)/subscribers"),
  "subscriber.complained": detail("/(tabs)/subscribers"),
  "subscriber.confirmed": detail("/(tabs)/subscribers"),

  // A "your campaign finished sending" push should land on THAT campaign's
  // report, not on the list where the user has to find the row the
  // notification was already about.
  "campaign.sent": detail("/(tabs)/campaigns"),
  "campaign.opened": detail("/(tabs)/campaigns"),
  "campaign.clicked": detail("/(tabs)/campaigns"),

  // "Approve on your phone": land the approver on the REQUEST they were
  // notified about, not on a queue they then have to search.
  "approval.requested": detail("/(tabs)/approvals"),
  // Same destination as the request. Approvals have no detail screen, and the
  // escalation is about the same pending decision — landing somewhere else
  // would make chasing an overdue approval harder than answering a fresh one.
  "approval.escalated": detail("/(tabs)/approvals"),

  // "An automation failed" is precisely the push whose whole value is arriving
  // AT the thing that failed.
  "automation.completed": detail("/(tabs)/sequences"),
  "automation.failed": detail("/(tabs)/sequences"),
  "sequence.generated": detail("/(tabs)/sequences"),

  // AUTOMATION#41. The alert is ABOUT one journey and carries its id, and
  // `/(tabs)/sequences/[id]` is the screen that lists who is sitting where —
  // so this is one of the few pushes that can put the operator on the exact
  // rows the notification counted. `detail` falls back to the list if the
  // envelope ever arrives without an id.
  "sequence.participants.stuck": detail("/(tabs)/sequences"),

  // A LIST, NOT A DETAIL ROUTE: the manifest sets `deepLinkEntity: null` for
  // both ("an auth/credential hand-off, not a list entity") and mobile ships no
  // `/(tabs)/migrations/[id]`, so detailOrList would build a route that does
  // not exist the moment a payload carried an id.
  "migration.completed": listOnly("/(tabs)/migrations"),
  "migration.failed": listOnly("/(tabs)/migrations"),

  // Forms now have a native monitoring surface. The event payload's
  // `form_id` lands on that form's conversion/submission view; older or
  // content-light envelopes fall back to the Forms list rather than losing
  // the notification's context on Dashboard.
  "form.submitted": formDetail,
  "form.confirmed": formDetail,

  // COMMERCE#3. `/(tabs)/webhooks` renders the endpoints with their health, so
  // the paused one is visible on arrival. There is no `/(tabs)/webhooks/[id]`,
  // and the manifest carries no entity for it — the list is the destination.
  "webhook.auto_disabled": listOnly("/(tabs)/webhooks"),

  // GOVERNANCE#48. `/(tabs)/audit-sinks` shows circuit_state and
  // consecutive_failures per sink, so the tripped one is visible on arrival —
  // and it is the screen the reset action lives on.
  "auditsink.circuit_opened": listOnly("/(tabs)/audit-sinks"),

  // COMMERCE#4. The billing tab is where the plan state and the payment method
  // live; landing anywhere else would make the notification a dead end.
  "billing.payment_failed": listOnly("/(tabs)/billing"),

  // DELIVERABILITY#15. `/(tabs)/deliverability` renders the score, the breach
  // list with its fix CTAs, and — the reason this notification exists — the
  // auto-throttle banner. Account health is not an entity, so the manifest
  // carries no `deepLinkEntity` and the screen IS the destination.
  "deliverability.degraded": listOnly("/(tabs)/deliverability"),
  "deliverability.auto_throttled": listOnly("/(tabs)/deliverability"),

  // Campaign assurance. Both carry the campaign id, and the campaign detail
  // screen is where CampaignAssuranceCard renders the run and its refusal
  // codes — so a blocked send lands the operator on the reason it was blocked,
  // not on a list they then have to search. `detail` falls back to the
  // campaigns list when the envelope carries no usable id.
  "assurance.run.blocked": detail("/(tabs)/campaigns"),
  "assurance.run.completed": detail("/(tabs)/campaigns"),
};

/**
 * routeForNotification inspects an Expo notification response and returns the
 * in-app route to navigate to, or null when we can't make sense of the payload
 * (so the current screen is left alone).
 *
 * The router shape (Href) ensures TypeScript catches typos against the
 * typed-routes manifest Expo Router generates.
 */
export function routeForNotification(
  response: NotificationResponse | null | undefined,
): Href | null {
  if (!response) return null;
  const data = response.notification?.request?.content?.data;
  if (!data || typeof data !== "object") return null;

  // Expo's APNs/FCM bridge sometimes wraps the payload under "body" as a
  // string when the original JSON exceeded the alert size. Try both.
  const envelope: EnvelopeLike = unwrapEnvelope(data);
  const eventType =
    typeof envelope.event_type === "string" ? envelope.event_type : "";
  const topicDestination = routeForNotificationTopic(eventType);
  if (topicDestination) return topicDestination;
  return routeForNotificationEvent(eventType, envelope);
}

/**
 * The NOTIFICATION_ROUTES lookup on its own, with no topic table in front of it.
 *
 * Extracted because PUSH was not the only caller that needed it. The in-app
 * inbox resolves the same events off feed rows rather than off an Expo
 * response, and it could not reach this table at all — it called
 * `routeForNotificationTopic` alone, which covers only the content-light topic
 * table. Every operational arm below (`webhook.auto_disabled`,
 * `auditsink.circuit_opened`, `billing.payment_failed`, `migration.*`,
 * `deliverability.*`) was therefore reachable by a push and a dead tap in the
 * bell — the same notification, routed on one surface and not the other.
 */
export function routeForNotificationEvent(
  eventType: unknown,
  envelope: EnvelopeLike,
): Href | null {
  if (typeof eventType !== "string" || !eventType) return null;
  if (!Object.hasOwn(NOTIFICATION_ROUTES, eventType)) return null;
  const resolve = NOTIFICATION_ROUTES[eventType];
  return resolve ? resolve(envelope) : null;
}

/** One row of the in-app notification feed — the fields routing may read. */
export interface NotificationFeedRow {
  kind: string;
  /** The dispatched event name. `notification_feed.Item.EventType`, omitempty. */
  event_type?: string | undefined;
  deep_link?: string | undefined;
  /** `Item.Payload` — entity ids and counts. Never customer PII. */
  payload?: Record<string, unknown> | undefined;
}

/**
 * Longest server-authored relative link this will look at. A `deep_link` is
 * server-written today; the bound keeps a future write path from handing the
 * parser something pathological.
 */
const MAX_RELATIVE_APP_PATH_CHARS = 512;

/**
 * Resolve a RELATIVE, server-authored `/app/<slug>` link to a mobile route.
 *
 * The server writes relative paths — `"/app/analytics"` (dashboardnotify.go),
 * `"/app/inbox-reality"` (reputationalerts/worker.go) — and every mobile
 * grammar in front of this one needs an absolute URL: `routeForNavLink` does
 * `new URL(rawUrl)` inside a try/catch and returns null, and route-map's
 * `parseUniversalLink` accepts a bare path but demands exactly three segments
 * (`[app, slug, id]`), so a two-segment list path matched neither. Those taps
 * resolved to nothing, and the inbox deliberately withholds the read receipt on
 * an unresolved tap — so the backlog never cleared either.
 *
 * Deliberately NARROW: a leading slash only (never a scheme, so this can not
 * become a second, laxer universal-link parser), exactly `/app/<slug>`, and the
 * slug must name a screen the app actually ships. `//host/app/x` splits to
 * three segments and is rejected, not silently read as a host-relative path.
 */
export function routeForRelativeAppPath(
  link: string | null | undefined,
): Href | null {
  if (!link || link.length > MAX_RELATIVE_APP_PATH_CHARS) return null;
  if (!link.startsWith("/")) return null;
  const pathOnly = link.split(/[?#]/u, 1)[0] ?? "";
  const segments = pathOnly.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "app") return null;
  const route = routeForNavSlug(segments[1] ?? "");
  return route ? (route as unknown as Href) : null;
}

/**
 * Where a tapped IN-APP INBOX row lands.
 *
 * The four grammars, most specific first:
 *
 *   1. The content-light TOPIC table. It owns a fixed surface per topic and
 *      must never have the row's own link fed into a URL parser (an inbound SMS
 *      carries a phone number and a body in its web path).
 *   2. The ENTITY link, when the row carries one that resolves. This is the
 *      only arm that can land on a specific record, so it outranks the event
 *      table, which falls back to a list.
 *   3. The EVENT table (`NOTIFICATION_ROUTES`) — the ~25 operational arms push
 *      already had and the inbox could not reach.
 *   4. The relative `/app/<slug>` path the server writes.
 *
 * `resolveEntityLink` is injected for the same reason `planNotificationTap`
 * takes `resolvesInApp`: it needs the router-aware `routeForEntityLink` from
 * lib/deepLinks, and lib/deepLinks re-exports this module — importing it here
 * would close a cycle.
 */
export function routeForFeedNotification(
  row: NotificationFeedRow,
  resolveEntityLink: (link: string) => Href | null,
): Href | null {
  const topic =
    routeForNotificationTopic(row.event_type) ??
    routeForNotificationTopic(row.kind);
  if (topic) return topic;
  const entity = row.deep_link ? resolveEntityLink(row.deep_link) : null;
  if (entity) return entity;
  // `kind` falls back to `ev.Type` server-side (notifyfanout/fanout.go:212-214)
  // but only when the producer left `Kind` empty, so the two coincide for SOME
  // rows and not others — which is precisely why the inbox routed some rows and
  // not others. Prefer the explicit event name and keep `kind` as the fallback.
  const eventType = row.event_type || row.kind;
  const event = routeForNotificationEvent(eventType, feedEnvelope(row));
  if (event) return event;
  return routeForRelativeAppPath(row.deep_link);
}

/**
 * A feed row seen as a push envelope, so the SAME arms serve both surfaces.
 * `Item.Payload` is what the fanout wrote from `ev.Payload`, which is where the
 * entity ids live.
 */
function feedEnvelope(row: NotificationFeedRow): EnvelopeLike {
  const payload =
    row.payload && typeof row.payload === "object" ? row.payload : undefined;
  return { body: payload, entity_id: payload?.["entity_id"] };
}

/**
 * Resolve a content-light feed/push topic without inspecting its deep link or
 * payload. Inbound SMS deliberately lands on the list: phone and body are not
 * navigation state and the backend link is a web route, not a mobile route.
 */
export function routeForNotificationTopic(eventType: unknown): Href | null {
  return notificationTopicDestination(eventType, "mobile") as Href | null;
}

function unwrapEnvelope(data: unknown): EnvelopeLike {
  if (!data || typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  // Path 1: payload was small enough that Expo passed it through intact.
  if (typeof obj.event_type === "string") return obj as EnvelopeLike;
  // Path 2: Expo stuffed the JSON into a "body" string field.
  if (typeof obj.body === "string") {
    if (utf8ByteLength(obj.body) > MAX_NOTIFICATION_BODY_JSON_BYTES) {
      return {};
    }
    try {
      const parsed = JSON.parse(obj.body) as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as EnvelopeLike;
      }
    } catch {
      // Fallthrough — return empty so the caller treats it as an unknown event.
    }
  }
  return {};
}

function pickStringProp(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const v = (value as Record<string, unknown>)[key];
  if (typeof v !== "string" || !v) return null;
  return v.length <= MAX_NOTIFICATION_ROUTE_PARAM_CHARS ? v : null;
}
