import { NOTIFICATIONS } from "./manifest.js";

/**
 * Content-light notification destinations that cannot be reconstructed from
 * an entity id. The topic is the whole routing contract: callers must not
 * trust a server-authored cross-client path, or add message content to one.
 */
export const NOTIFICATION_TOPIC_DESTINATIONS = {
  "sms.received": {
    mobile: "/(tabs)/sms",
    desktop: "smsInbox",
    web: "/app/sms?tab=inbox",
  },
} as const;

export type NotificationDestinationSurface =
  keyof (typeof NOTIFICATION_TOPIC_DESTINATIONS)["sms.received"];

type TopicDestination<S extends NotificationDestinationSurface> =
  (typeof NOTIFICATION_TOPIC_DESTINATIONS)[keyof typeof NOTIFICATION_TOPIC_DESTINATIONS][S];

/** Resolve an exact topic to its fixed per-client destination. */
export function notificationTopicDestination<
  S extends NotificationDestinationSurface,
>(eventType: unknown, surface: S): TopicDestination<S> | null {
  if (
    typeof eventType !== "string" ||
    !Object.hasOwn(NOTIFICATION_TOPIC_DESTINATIONS, eventType)
  ) {
    return null;
  }
  const destinations = NOTIFICATION_TOPIC_DESTINATIONS[
    eventType as keyof typeof NOTIFICATION_TOPIC_DESTINATIONS
  ] as (typeof NOTIFICATION_TOPIC_DESTINATIONS)[keyof typeof NOTIFICATION_TOPIC_DESTINATIONS];
  return destinations[surface] as TopicDestination<S>;
}

/**
 * Bound a server-supplied event label before it reaches analytics. Unknown
 * values may contain user content, so they collapse to one constant label.
 */
export function safeNotificationTopicLabel(eventType: unknown): string {
  if (typeof eventType !== "string") return "unknown";
  if (
    Object.hasOwn(NOTIFICATIONS, eventType) ||
    Object.hasOwn(NOTIFICATION_TOPIC_DESTINATIONS, eventType)
  ) {
    return eventType;
  }
  return "unknown";
}
