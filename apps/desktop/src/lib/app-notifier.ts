/**
 * app-notifier — route live server events through OS notifications at
 * the APP level, regardless of which page is mounted.
 *
 * Why this exists: before this, only the Dashboard page fired OS
 * notifications — and
 * only for poll-derived milestone / anomaly crossings (see
 * lib/dashboard-notifier.ts). So a backgrounded app sitting on any other
 * route went silent for genuinely actionable realtime events
 * (an approval awaiting you, a campaign finishing its send, a bounce
 * spike). This module subscribes — via the SAME shared SSE event-bus
 * every other live feature uses (lib/event-bus.ts), no new transport —
 * to the notify-worthy topics and fires a single, quiet OS notification
 * per event through the existing tauriApi.showNotification helper.
 *
 * Anti-"OS blizzard" design (mirrors dashboard-notifier):
 *   - Only the explicitly notify-worthy topics are subscribed. Chatty
 *     collaboration topics (cursor.move / presence.update / selection.*)
 *     and high-volume audit rows are deliberately excluded.
 *   - Bounded process-local dedupe plus encrypted Notification Center state,
 *     so reconnect replay cannot double-fire without writing server event or
 *     tenant identifiers into plaintext browser storage.
 */

import {
  channelEligible,
  notificationForEvent as renderNotification,
} from "@postwave/notifications";
import { useEffect } from "react";

import { type EventBusMessage, useEventSubscription } from "./event-bus";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  ingestNotification,
  notificationDeliveryDecision,
  recordNotificationDelivery,
  type DesktopNotificationTopic,
  useNotificationCenter,
} from "./notification-center";
import { synchronizeNativeNotificationActivations } from "./notification-activation";
import { useMe } from "./store";
import { type NotificationOptions, tauriApi } from "./tauri";

/**
 * Topics the app-level listener subscribes to. Intentionally a SUBSET of
 * the event-bus topics — only events a human would want pulled to the
 * foreground.
 *
 * Each entry is a `desktop`-channel event in the SHARED notification
 * manifest (@postwave/notifications) — the single source of truth for
 * which server events are notification-worthy, their copy, and their
 * deep-link target. The desktop curates a small high-signal subset of the
 * manifest's desktop-eligible events for OS pings (chatty collaboration
 * topics and high-volume firehoses are deliberately excluded). Every
 * APP_NOTIFY_TOPICS entry is a known manifest event whose `desktop`
 * channel eligibility is re-checked at fire time via `channelEligible`,
 * so a manifest channel change can't be silently ignored here.
 *
 * `subscriber.bounced` is the exact wire topic the server emits for
 * per-subscriber hard bounces (see apps/api
 * internal/listmonk_events/events.go WireBounced = "subscriber.bounced",
 * and the matching manifest key) — NOT ".bounce"; the Dashboard separately
 * owns the polled bounce-rate anomaly.
 */
export const APP_NOTIFY_TOPICS = [
  "approval.requested",
  "campaign.sent",
  "subscriber.bounced",
] as const;

const MAX_DEDUPE_IDS = 200;
const inFlightNotifications = new Set<string>();
const processedNotifications = new Set<string>();

/**
 * Commit a terminal event decision to the bounded session dedupe set: either
 * confirmed OS delivery or intentional policy suppression after encrypted
 * center admission. Delivery is reserved in memory before the await below;
 * permission/OS failures are never committed and remain retryable.
 */
function commitProcessed(key: string): void {
  processedNotifications.delete(key);
  processedNotifications.add(key);
  while (processedNotifications.size > MAX_DEDUPE_IDS) {
    const oldest = processedNotifications.values().next().value;
    if (typeof oldest !== "string") break;
    processedNotifications.delete(oldest);
  }
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const value = v.trim();
  return value && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

/** The notify-worthy topic set as a Set for O(1) membership checks. */
const NOTIFY_TOPICS: ReadonlySet<string> = new Set(APP_NOTIFY_TOPICS);

interface AppNotificationPlan {
  options: NotificationOptions;
  topic: DesktopNotificationTopic;
  eventIdentity: string;
  deepLink: string | null;
}

function eventEntityId(evt: EventBusMessage): string | undefined {
  const p = (evt.payload ?? {}) as Record<string, unknown>;
  return (
    str(p.id) ??
    str(p.campaign_id) ??
    str(p.approval_id) ??
    str(p.subscriber_id)
  );
}

/**
 * Pure mapping: server event → notification (or null when the event isn't
 * one of the desktop's notify-worthy topics). Kept pure so it's trivially
 * unit-testable and has no React / Tauri dependency.
 *
 * The notify-worthy SET, the canonical title, and the deep-link target are
 * derived from the SHARED notification manifest (@postwave/notifications):
 *   - membership is gated on APP_NOTIFY_TOPICS (a curated subset of the
 *     manifest's desktop-eligible events) AND on the manifest still listing
 *     the event as `desktop`-eligible, so a manifest channel change can't be
 *     silently ignored here;
 *   - `renderNotification(topic, { fields })` produces the shared title +
 *     (template) body + deep link.
 *
 * Lock-screen privacy: titles stay canonical, while body copy deliberately
 * excludes names, email addresses, recipient counts, tenant identifiers and
 * campaign subjects. A desktop notification can appear on a locked or shared
 * screen, so richer context belongs only inside the authenticated app.
 */
export function notificationForEvent(
  evt: EventBusMessage,
): NotificationOptions | null {
  return notificationPlanForEvent(evt)?.options ?? null;
}

/** Shared rendering plan for encrypted center history and optional OS copy. */
function notificationPlanForEvent(
  evt: EventBusMessage,
): AppNotificationPlan | null {
  const topic = evt.topic;
  // Only the curated subset fires, and only while the manifest still marks
  // the event desktop-eligible. (channelEligible returns true for unknown
  // events, but every APP_NOTIFY_TOPICS entry is a known manifest event.)
  if (!NOTIFY_TOPICS.has(topic)) return null;
  if (!channelEligible(topic, "desktop")) return null;

  const entityId = eventEntityId(evt);

  if (topic === "approval.requested") {
    const rendered = renderNotification(topic, {
      entityId,
    });
    return {
      topic,
      eventIdentity: `${entityId ?? "event"}:${evt.at}`,
      deepLink: rendered.deepLink,
      options: {
        title: rendered.title,
        body: "A campaign is waiting for review. Open Moosewave for details.",
      },
    };
  }

  if (topic === "campaign.sent") {
    const rendered = renderNotification(topic, {
      entityId,
    });
    return {
      topic,
      eventIdentity: `${entityId ?? "event"}:${evt.at}`,
      deepLink: rendered.deepLink,
      options: {
        title: rendered.title,
        body: "A campaign finished sending. Open Moosewave for delivery details.",
      },
    };
  }

  // Per-subscriber hard bounce. The server emits exactly "subscriber.bounced"
  // (events.go WireBounced); there is no ".bounce" topic — membership above
  // matches it exactly via the manifest key.
  const rendered = renderNotification(topic, {
    entityId,
  });
  return {
    topic: topic as DesktopNotificationTopic,
    eventIdentity: `${entityId ?? "event"}:${evt.at}`,
    deepLink: rendered.deepLink,
    options: {
      title: rendered.title,
      body: "A subscriber bounced. Open Moosewave to review deliverability.",
    },
  };
}

/** Stable id for dedupe. Prefers a server-supplied id; else topic+at. */
function eventDedupeKey(evt: EventBusMessage): string {
  const id = eventEntityId(evt);
  const tenant = str(evt.tenant_id) ?? "workspace";
  const occurredAt = str(evt.at) ?? "event";
  return `${tenant}:${evt.topic}:${id ?? occurredAt}`;
}

/** Fire a notification for one event, deduping per session. */
async function fireForEvent(
  evt: EventBusMessage,
  forceOsDelivery = false,
): Promise<void> {
  const plan = notificationPlanForEvent(evt);
  if (!plan) return;
  const key = eventDedupeKey(evt);
  let centerId: string | null = null;
  try {
    const centerResult = await ingestNotification({
      topic: plan.topic,
      title: plan.options.title,
      body: plan.options.body ?? "Open Moosewave for details.",
      occurredAt: evt.at,
      eventIdentity: plan.eventIdentity,
      deepLink: plan.deepLink,
    });
    centerId = centerResult.id;
    if (!centerResult.stored && centerId) {
      const existing = getNotificationCenterSnapshot().entries.find(
        (entry) => entry.id === centerId,
      );
      if (
        existing &&
        existing.delivery !== "pending" &&
        existing.delivery !== "failed"
      ) {
        commitProcessed(key);
        return;
      }
    }
  } catch {
    // OS delivery is independent from encrypted-center persistence.
  }

  if (!forceOsDelivery) {
    const decision = notificationDeliveryDecision({
      topic: plan.topic,
      appVisible:
        typeof document !== "undefined" &&
        document.visibilityState === "visible",
      appFocused:
        typeof document !== "undefined" &&
        typeof document.hasFocus === "function" &&
        document.hasFocus(),
    });
    if (!decision.deliver) {
      recordNotificationDelivery(centerId, decision.reason);
      // Policy suppression is an intentional terminal decision for this event,
      // not a reason to surprise the user with an old alert after a later SSE
      // replay. Only commit once encrypted center admission succeeded.
      if (centerId) commitProcessed(key);
      return;
    }
  }

  if (processedNotifications.has(key) || inFlightNotifications.has(key)) {
    recordNotificationDelivery(centerId, "delivered");
    return;
  }
  inFlightNotifications.add(key);
  try {
    await tauriApi.showNotification(
      centerId ? { ...plan.options, activationId: centerId } : plan.options,
    );
    commitProcessed(key);
    recordNotificationDelivery(centerId, "delivered");
  } catch {
    // Keep the event eligible for retry or durable-center delivery.
    recordNotificationDelivery(centerId, "failed");
  } finally {
    inFlightNotifications.delete(key);
  }
}

/** @internal Focused delivery contract used by renderer tests. */
export async function deliverAppNotificationForTests(
  evt: EventBusMessage,
  options: { respectPolicy?: boolean } = {},
): Promise<void> {
  await fireForEvent(evt, options.respectPolicy !== true);
}

/** @internal Clear only process-local reservations between tests. */
export function resetAppNotifierForTests(): void {
  inFlightNotifications.clear();
  processedNotifications.clear();
}

/**
 * AppEventNotifier — invisible component. Mounts once, near the app root
 * (inside <EventBusProvider>), and routes notify-worthy server events to
 * OS notifications for the whole app's lifetime. Renders nothing.
 */
export function useAppEventNotifications(): void {
  // One subscription per notify-worthy topic. useEventSubscription keeps
  // the latest handler live without re-subscribing on every render.
  useEventSubscription("approval.requested", (evt) => {
    void fireForEvent(evt as EventBusMessage);
  });
  useEventSubscription("campaign.sent", (evt) => {
    void fireForEvent(evt as EventBusMessage);
  });
  useEventSubscription("subscriber.bounced", (evt) => {
    void fireForEvent(evt as EventBusMessage);
  });
}

/**
 * Invisible mount point for the app-level notifier. Render once inside
 * <EventBusProvider> (App.tsx). Returns null — its only job is to keep
 * the event subscriptions alive for the app's lifetime so OS
 * notifications fire no matter which page is currently mounted.
 */
export function AppEventNotifier(): null {
  const me = useMe();
  const center = useNotificationCenter();
  useEffect(() => {
    void configureNotificationCenterIdentity(
      me?.user ?? null,
      me?.tenant ?? null,
    );
  }, [me?.tenant, me?.user]);
  useEffect(() => {
    void tauriApi
      .setTrayBadge(center.unreadCount > 0 ? center.unreadCount : null)
      .catch(() => {
        // An OS badge failure must not affect encrypted in-app history.
      });
  }, [center.unreadCount]);
  useEffect(() => {
    if (center.identity !== "ready") return;
    void synchronizeNativeNotificationActivations().catch(() => {
      // Center history remains authoritative if this OS integration is not
      // available on the current installed platform.
    });
  }, [center.identity]);
  useAppEventNotifications();
  return null;
}
