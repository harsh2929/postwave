import {
  buildDeepLink,
  buildUniversalLink,
  type EntityKey,
} from "@postwave/route-map";

import {
  DEFAULT_NOTIFICATION,
  NOTIFICATIONS,
  type Channel,
  type NotificationDef,
} from "./manifest.js";

/**
 * Look up the notification definition for a server event type.
 *
 * `Object.hasOwn` rather than a bare index, because NOTIFICATIONS is a plain
 * object literal and therefore inherits from Object.prototype. `NOTIFICATIONS
 * ["constructor"]` returned the Object CONSTRUCTOR — truthy — so every caller's
 * `if (!def)` unknown-event fallback was skipped and the next line threw
 * `TypeError: Cannot read properties of undefined (reading 'replace')` on
 * `def.titleTemplate`. Same for "__proto__", "toString", "valueOf" and
 * "hasOwnProperty".
 *
 * The event string arrives on a server notification payload, and the whole
 * purpose of the `!def` branch is to degrade gracefully on one this build does
 * not know. It did that for every unknown name except the handful that happen
 * to be inherited members — where it crashed the render instead.
 *
 * @postwave/route-map — which this very file imports — already guards its
 * registry lookup this way. The idiom existed one import away.
 */
export function getNotification(event: string): NotificationDef | undefined {
  if (!Object.hasOwn(NOTIFICATIONS, event)) return undefined;
  return NOTIFICATIONS[event];
}

/**
 * Context the server/client supplies when rendering a notification for a
 * concrete event instance. `entityId` is the id of the deep-link target (a
 * campaign id, subscriber id, …); `fields` fills the `{placeholder}` slots in
 * the title/body templates. Everything is optional — an empty context still
 * renders a sensible (placeholder-free) notification.
 */
export interface NotificationContext {
  /** Resource id for the deep-link target (route-map entity id). */
  entityId?: string;
  /** Values for `{field}` placeholders in the title/body templates. */
  fields?: Record<string, string>;
}

export interface RenderedNotification {
  event: string;
  category: NotificationDef["category"];
  title: string;
  body: string;
  defaultEnabled: boolean;
  channels: readonly Channel[];
  /** The entity kind this notification targets, or null. */
  deepLinkEntity: EntityKey | null;
  /**
   * Server-authored deep target. `moosewave://<entity>/<id>` when both the
   * entity and a valid id are known, else null. The audit's recommendation:
   * the server emits this ONCE so clients navigate from a shared target
   * instead of each re-deriving it.
   */
  deepLink: string | null;
  /** The shareable https universal link form of the same target, or null. */
  universalLink: string | null;
}

/**
 * Fill `{placeholder}` slots in a template from `fields`. A placeholder with
 * no matching field is dropped (along with a single trailing/leading space it
 * leaves behind) so a missing field never renders a literal "{campaignName}".
 */
function fillTemplate(template: string, fields: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = fields[key];
    return typeof v === "string" ? v : "\u0000"; // sentinel for "missing"
  });
  // Collapse the sentinel (and any doubled whitespace it leaves) cleanly.
  return filled
    .replace(/\s*\u0000\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Render a notification for a server event + context. Unknown events fall
 * back to the generic title/body (mirroring the server's default switch arm)
 * with every channel eligible and no deep link.
 *
 * The deep link is built through @postwave/route-map so the entity→target
 * mapping is shared with web/desktop/mobile — this function does NOT invent
 * its own routing.
 */
export function notificationForEvent(
  event: string,
  ctx: NotificationContext = {},
): RenderedNotification {
  const def = getNotification(event);
  const fields = ctx.fields ?? {};

  if (!def) {
    return {
      event,
      category: "campaigns", // unused for unknown events; keep the type honest
      title: DEFAULT_NOTIFICATION.title,
      body: DEFAULT_NOTIFICATION.body,
      defaultEnabled: false,
      channels: ["push", "desktop", "web"],
      deepLinkEntity: null,
      deepLink: null,
      universalLink: null,
    };
  }

  let deepLink: string | null = null;
  let universalLink: string | null = null;
  if (def.deepLinkEntity && ctx.entityId) {
    // buildDeepLink/buildUniversalLink return null for unsafe ids — we
    // propagate that null rather than emitting a malformed link.
    deepLink = buildDeepLink(def.deepLinkEntity, ctx.entityId);
    universalLink = buildUniversalLink(def.deepLinkEntity, ctx.entityId);
  }

  return {
    event: def.event,
    category: def.category,
    title: fillTemplate(def.titleTemplate, fields),
    body: fillTemplate(def.bodyTemplate, fields),
    defaultEnabled: def.defaultEnabled,
    channels: def.channels,
    deepLinkEntity: def.deepLinkEntity,
    deepLink,
    universalLink,
  };
}

/** Whether an event is eligible for delivery on a given channel. */
export function channelEligible(event: string, channel: Channel): boolean {
  const def = getNotification(event);
  if (!def) return true; // unknown events fall back to all-channels
  return def.channels.includes(channel);
}

/** Every event whose category is ON by default for a new user. */
export function defaultEnabledEvents(): string[] {
  return Object.values(NOTIFICATIONS)
    .filter((d) => d.defaultEnabled)
    .map((d) => d.event);
}

/** All events belonging to a notification category. */
export function eventsInCategory(
  category: NotificationDef["category"],
): string[] {
  return Object.values(NOTIFICATIONS)
    .filter((d) => d.category === category)
    .map((d) => d.event);
}
