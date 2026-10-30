/**
 * @postwave/notifications — the single source of truth for Moosewave
 * notification categories.
 *
 * One manifest (NOTIFICATIONS) maps each server event (approval.requested,
 * campaign.sent, subscriber.bounced, …) to its category, title/body
 * templates, deep-link entity, default-enabled flag, and per-channel
 * (push/desktop/web) eligibility. `notificationForEvent(event, ctx)` renders
 * the user-facing notification — title, body, and a server-authored deep link
 * built through @postwave/route-map — so push copy + routing stop being
 * duplicated mobile-only-by-convention.
 */

export {
  type Channel,
  type NotificationCategory,
  type NotificationDef,
  type NotificationEvent,
  CHANNELS,
  NOTIFICATIONS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION,
} from "./manifest.js";

export {
  type NotificationContext,
  type RenderedNotification,
  getNotification,
  notificationForEvent,
  channelEligible,
  defaultEnabledEvents,
  eventsInCategory,
} from "./helpers.js";

export { type PresenceUserV2, type PresencePayload } from "./presence.js";

export {
  type NotificationDestinationSurface,
  NOTIFICATION_TOPIC_DESTINATIONS,
  notificationTopicDestination,
  safeNotificationTopicLabel,
} from "./topic-destinations.js";
