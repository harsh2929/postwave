import { notificationTopicDestination } from "@postwave/notifications";

/**
 * Pick a notification-feed destination without trusting a cross-client link
 * for content-light topics. Other notification kinds retain the existing
 * bounded relative-path behaviour.
 */
export function notificationFeedDestination(item: {
  kind: unknown;
  deep_link?: unknown;
}): string | null {
  const topicDestination = notificationTopicDestination(item.kind, "web");
  if (topicDestination) return topicDestination;
  return typeof item.deep_link === "string" && item.deep_link.startsWith("/")
    ? item.deep_link
    : null;
}
