/**
 * lib/notificationInboxTap.ts — what a tapped INBOX ROW resolves to.
 *
 * The pure half of `app/(tabs)/notifications.tsx`'s `open` handler, split the
 * way `src/api/eventBus.ts` was split into `eventBusStream.ts` /
 * `eventBusConnection.ts`: the decision (which route, which fallback plan,
 * which telemetry) has no React in it, while the ACT (haptics, navigation,
 * toasts, the read receipt) does. Keeping them in one callback meant the
 * decision could only be exercised by rendering react-native, so the dead-tap
 * bug this resolution exists to fix had no unit test to hold it.
 *
 * WHY THE TWO HALVES OF THE DECISION TRAVEL TOGETHER. `route` and `plan` are
 * not independent: a resolvable route IS an in-app plan, and only when there
 * is none does `planNotificationTap` get to offer the web admin or admit that
 * nothing can be opened. Returning them separately invited a caller to compute
 * one and forget the other — which is exactly how the inbox and push drifted
 * apart in the first place.
 *
 * `resolveEntityLink` is injected for the same reason `routeForFeedNotification`
 * takes it: the router-aware parser lives in lib/deepLinks, which re-exports
 * lib/notificationRoutes, so importing it here would close a cycle.
 *
 * This module must stay free of react-native/expo runtime imports so it keeps
 * running under `vitest --environment node`.
 */
import type { Href } from "expo-router";

import { safeNotificationTopicLabel } from "@postwave/notifications";

import {
  planNotificationTap,
  type NotificationLinkPlan,
} from "./notificationLink";
import {
  routeForFeedNotification,
  type NotificationFeedRow,
} from "./notificationRoutes";

/**
 * The structural facts the tap telemetry reports. Never row content.
 *
 * A type ALIAS, not an interface: `track` takes `Record<string, unknown>`, and
 * only an alias of an object type is granted the implicit index signature that
 * makes it assignable there.
 */
export type NotificationTapTelemetry = {
  kind: string;
  had_deep_link: boolean;
  resolved: NotificationLinkPlan["kind"];
};

export interface NotificationTapResolution {
  /** The in-app destination, or null when nothing in-app matched. */
  route: Href | null;
  /** What the caller should DO — navigate, offer the web admin, or explain. */
  plan: NotificationLinkPlan;
  /** Payload for `EVENTS.MOBILE_NOTIFICATION_OPENED`. */
  telemetry: NotificationTapTelemetry;
}

/**
 * Resolve a tapped feed row.
 *
 * The full four-grammar resolution, shared with push. The inbox used to ask
 * only the content-light TOPIC table and then the entity parser, which left
 * every operational event — a disabled webhook, a tripped audit sink, a failed
 * payment, a throttled sending domain — as a dead tap on a row push routes
 * correctly. `routeForFeedNotification` keeps the topic table first (an inbound
 * SMS carries a phone number and a body in its web path, and that must never
 * reach a URL parser) and adds the NOTIFICATION_ROUTES table and the server's
 * relative `/app/<slug>` links behind it.
 *
 * `resolvesInApp` is passed as `false` on purpose: this function has ALREADY
 * exhausted the in-app grammars above, so the fallback's only remaining job is
 * to judge the raw `deep_link` as a web URL.
 */
export function resolveNotificationTap(
  row: NotificationFeedRow,
  resolveEntityLink: (link: string) => Href | null,
): NotificationTapResolution {
  const route = routeForFeedNotification(row, resolveEntityLink);
  const plan: NotificationLinkPlan = route
    ? { kind: "in-app" }
    : planNotificationTap(row.deep_link, false);
  return {
    route,
    plan,
    telemetry: {
      kind: safeNotificationTopicLabel(row.kind),
      had_deep_link: Boolean(row.deep_link),
      resolved: plan.kind,
    },
  };
}
