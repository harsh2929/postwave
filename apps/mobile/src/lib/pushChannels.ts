/**
 * lib/pushChannels.ts — Android notification channels, one per notification
 * category (NATIVE#13).
 *
 * On Android a *channel* is the only notification control the OS gives a
 * person: importance, sound, vibration, badge and "silence this" all hang off
 * it, and none of it is changeable by the app after creation. Mobile created
 * exactly one channel — `default` — and the server hardcoded
 * `ChannelID: "default"` on every delivery, so muting bounce pings in Android
 * Settings also muted approval requests, and approvals could never be given
 * HIGH importance or their own sound.
 *
 * The channel set is DERIVED from the shared @postwave/notifications manifest
 * rather than hand-listed, so it cannot drift from the categories the rest of
 * the product already groups by (the same categories the per-event push
 * preferences UI renders). `pushChannelIdForEvent` is the mapping the server
 * must agree with; `src/lib/pushChannelContract.test.ts` asserts the Go sender
 * derives the same ids from the same events.
 *
 * Deliberately free of react-native / expo imports so the policy is unit
 * testable in the node vitest environment — `lib/push.ts` translates
 * `importance` into `Notifications.AndroidImportance` at the call site.
 */
import {
  NOTIFICATIONS,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from "@postwave/notifications";

/**
 * The legacy channel. Kept registered forever: notifications already sitting
 * in a user's shade were posted against it, and `app.json` names it as
 * expo-notifications' `defaultChannel`, so removing it would strand them.
 */
export const LEGACY_PUSH_CHANNEL_ID = "default";

/** Mirrors Notifications.AndroidImportance without importing expo-notifications. */
export type PushChannelImportance = "high" | "default" | "low";

export interface AndroidPushChannel {
  /** Channel id — must match the `channelId` the server puts on the push. */
  id: string;
  /** Shown as the row title in Android's per-app notification settings. */
  name: string;
  /** Shown under the row; explains what the user is silencing. */
  description: string;
  importance: PushChannelImportance;
}

/**
 * Category → channel presentation. HIGH is reserved for low-volume events
 * whose cost rises quickly when missed: account security, approvals, billing,
 * and deliverability incidents. Everything else starts at DEFAULT (or LOW for
 * the highest-volume, lowest-decision category), and the user can move any of
 * them from Android Settings — which is the point of splitting the channels.
 *
 * IMPORTANCE IS WRITE-ONCE. Android ignores importance on a channel that already
 * exists, so these values are the *initial* posture for a fresh install; a user's
 * later change always wins. Never "fix" a channel by re-creating it under the
 * same id — create a new id instead.
 */
const CATEGORY_CHANNELS: Record<
  NotificationCategory,
  Omit<AndroidPushChannel, "id">
> = {
  security: {
    name: "Account security",
    description: "New sign-ins and urgent account-security activity.",
    importance: "high",
  },
  approvals: {
    name: "Approvals",
    description: "Requests waiting on your decision.",
    importance: "high",
  },
  // COMMERCE#4 — HIGH alongside approvals. A failed charge is the one alert
  // whose cost of being missed is the workspace itself, and it is inherently
  // low-volume (one per failed invoice), so it cannot become the noise that
  // teaches someone to silence the app.
  billing: {
    name: "Billing",
    description: "Payment failures and anything that puts the plan at risk.",
    importance: "high",
  },
  // DELIVERABILITY#15 — HIGH, and the third and last channel that earns it.
  // Both events on it are edge-triggered account-level incidents (a downward
  // threshold crossing; a throttle actually applied), so the volume ceiling is
  // roughly one notification per incident and it cannot become the noise that
  // teaches someone to silence the app. The cost of a late read is measured in
  // mail that did not go out, or reputation that kept eroding while nobody
  // knew — which is the same class of loss as a failed payment.
  deliverability: {
    name: "Deliverability",
    description: "Sender-health breaches and automatic send-rate throttling.",
    importance: "high",
  },
  // COMMERCE#3 / GOVERNANCE#48 — an outbound destination stopped accepting our
  // data: a webhook auto-disabled, or an audit sink's breaker open. Either way
  // the tenant's own systems have stopped receiving something they asked for.
  // DEFAULT rather than HIGH: it needs attention today, not this minute.
  integrations: {
    name: "Integrations",
    description:
      "Webhooks and audit sinks paused after repeated delivery failures.",
    importance: "default",
  },
  campaigns: {
    name: "Campaigns",
    description: "Sends finishing, and engagement on what you sent.",
    importance: "default",
  },
  subscribers: {
    name: "Subscribers",
    description: "Signups, unsubscribes, bounces and spam complaints.",
    importance: "default",
  },
  automations: {
    name: "Automations",
    description: "Flows and sequences completing or failing.",
    importance: "default",
  },
  migrations: {
    name: "Imports & migrations",
    description: "Long-running imports finishing or failing.",
    importance: "default",
  },
  forms: {
    name: "Forms",
    description: "Form submissions and confirmations.",
    importance: "low",
  },
};

/** Channel id for a manifest category. Stable — it is a wire value. */
export function pushChannelIdForCategory(category: NotificationCategory): string {
  return category;
}

/**
 * The channel a given server event should be posted to. Unknown events (an
 * older client meeting a newer server) fall back to the legacy channel rather
 * than being dropped or silently re-categorised.
 */
export function pushChannelIdForEvent(eventType: string): string {
  const def = NOTIFICATIONS[eventType];
  if (!def) return LEGACY_PUSH_CHANNEL_ID;
  return pushChannelIdForCategory(def.category);
}

/**
 * Every channel this build registers, in the order Android should list them.
 * The legacy channel comes last and is described honestly — it only ever
 * receives traffic from a server older than this build.
 */
export function androidPushChannels(): AndroidPushChannel[] {
  const seen = new Set<NotificationCategory>();
  for (const def of Object.values(NOTIFICATIONS)) seen.add(def.category);
  // Order comes from the shared manifest, not from this file's key order: the
  // list a person scrolls in Android Settings should match the one a
  // preferences screen renders, and two hand-kept orders drift.
  const ordered = NOTIFICATION_CATEGORIES.filter((category) =>
    seen.has(category),
  )
    .map((category) => ({
      id: pushChannelIdForCategory(category),
      ...CATEGORY_CHANNELS[category],
    }));
  return [
    ...ordered,
    {
      id: LEGACY_PUSH_CHANNEL_ID,
      name: "Other",
      description: "Alerts that do not belong to a category yet.",
      importance: "default",
    },
  ];
}
