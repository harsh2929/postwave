// @vitest-environment happy-dom

// Tests for the app-level server-event → OS-notification router.
//
// Issue: the desktop app previously fired OS notifications only from the
// Dashboard page (milestone / anomaly
// crossings derived from polled stats). A backgrounded app sitting on
// any OTHER page therefore went silent for genuinely actionable server
// events (approval.requested, campaign.sent, bounce spikes). This pins
// the pure event→notification mapping that the app-level listener
// (App.tsx → AppEventNotifier) routes through tauriApi.showNotification.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showNotification: vi.fn(),
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  tauriApi: { showNotification: mocks.showNotification },
}));
vi.mock("../lib/secure-vault", () => ({
  vaultGetJSON: mocks.vaultGet,
  vaultSetJSON: mocks.vaultSet,
}));

import {
  APP_NOTIFY_TOPICS,
  deliverAppNotificationForTests,
  notificationForEvent,
  resetAppNotifierForTests,
} from "../lib/app-notifier";
import type { EventBusMessage } from "../lib/event-bus";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  resetNotificationCenterForTests,
  updateDesktopNotificationPreferences,
} from "../lib/notification-center";

beforeEach(() => {
  window.sessionStorage.clear();
  resetNotificationCenterForTests();
  resetAppNotifierForTests();
  mocks.vaultGet.mockReset().mockResolvedValue(null);
  mocks.vaultSet.mockReset().mockResolvedValue(undefined);
  mocks.showNotification.mockReset();
  mocks.showNotification.mockResolvedValue(undefined);
});

afterEach(() => {
  resetAppNotifierForTests();
  vi.clearAllMocks();
});

function msg(
  topic: string,
  payload?: Record<string, unknown>,
): EventBusMessage {
  return { topic, tenant_id: "t1", at: "2026-06-21T00:00:00Z", payload };
}

describe("app-notifier notificationForEvent", () => {
  it("notifies on approval.requested without lock-screen campaign details", () => {
    const n = notificationForEvent(
      msg("approval.requested", { campaign_name: "June Promo" }),
    );
    expect(n).not.toBeNull();
    expect(n?.title).toMatch(/approval/i);
    expect(n?.body).toMatch(/open postwave/i);
    expect(n?.body).not.toMatch(/June Promo/);
  });

  it("notifies on campaign.sent", () => {
    const n = notificationForEvent(
      msg("campaign.sent", { name: "Welcome Series" }),
    );
    expect(n).not.toBeNull();
    expect(n?.title).toMatch(/sent/i);
    expect(n?.body).toMatch(/open postwave/i);
    expect(n?.body).not.toMatch(/Welcome Series/);
  });

  it("notifies on the server's bounce event (subscriber.bounced)", () => {
    // The server emits exactly "subscriber.bounced" (apps/api
    // internal/listmonk_events/events.go WireBounced). This is the wire
    // topic name — NOT "subscriber.bounce". A regression to the wrong name
    // would make this notification dead, so pin the exact server name here.
    const n = notificationForEvent(
      msg("subscriber.bounced", { email: "x@example.com" }),
    );
    expect(n).not.toBeNull();
    expect(n?.title).toMatch(/bounce/i);
    expect(n?.body).toMatch(/open postwave/i);
    expect(n?.body).not.toMatch(/x@example\.com/);
  });

  it("does NOT match the (never-emitted) 'subscriber.bounce' topic", () => {
    // Guards against re-introducing the dead ".bounce" / endsWith fallback:
    // the server never emits this, so it must not produce a notification.
    expect(
      notificationForEvent(
        msg("subscriber.bounce", { email: "x@example.com" }),
      ),
    ).toBeNull();
  });

  it("returns null for chatty / non-actionable topics (no OS blizzard)", () => {
    expect(notificationForEvent(msg("cursor.move"))).toBeNull();
    expect(notificationForEvent(msg("presence.update"))).toBeNull();
    expect(notificationForEvent(msg("selection.move"))).toBeNull();
    expect(notificationForEvent(msg("audit.created"))).toBeNull();
  });

  it("subscribes only to the notify-worthy topic set", () => {
    expect(APP_NOTIFY_TOPICS).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "campaign.sent",
        // Must be the exact server wire topic, not "subscriber.bounce";
        // the event-bus subscribe path requires an exact (or "*.") match,
        // so a typo'd topic silently never fires.
        "subscriber.bounced",
      ]),
    );
    // Chatty collaboration topics must NOT be in the subscription set.
    expect(APP_NOTIFY_TOPICS).not.toContain("cursor.move");
    expect(APP_NOTIFY_TOPICS).not.toContain("presence.update");
    // The dead/misspelled topic must not be subscribed.
    expect(APP_NOTIFY_TOPICS).not.toContain("subscriber.bounce");
  });

  it("degrades gracefully when the payload is missing fields", () => {
    const n = notificationForEvent(msg("campaign.sent"));
    expect(n).not.toBeNull();
    expect(typeof n?.title).toBe("string");
    expect(typeof n?.body).toBe("string");
  });

  it("commits dedupe only after delivery succeeds so failures remain retryable", async () => {
    const event = msg("campaign.sent", { campaign_id: "campaign-42" });
    mocks.showNotification.mockRejectedValueOnce(
      new Error("notification permission denied"),
    );

    await deliverAppNotificationForTests(event);
    await deliverAppNotificationForTests(event);
    await deliverAppNotificationForTests(event);

    expect(mocks.showNotification).toHaveBeenCalledTimes(2);
  });

  it("reserves concurrent delivery so the same event cannot double-fire", async () => {
    let releaseDelivery: (() => void) | undefined;
    mocks.showNotification.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseDelivery = resolve;
        }),
    );
    const event = msg("approval.requested", { approval_id: "approval-7" });

    const first = deliverAppNotificationForTests(event);
    const duplicate = deliverAppNotificationForTests(event);

    await vi.waitFor(() =>
      expect(mocks.showNotification).toHaveBeenCalledTimes(1),
    );
    releaseDelivery?.();
    await Promise.all([first, duplicate]);
    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
  });

  it("crosses the native activation boundary with only an opaque center id", async () => {
    await configureNotificationCenterIdentity("user-1", "tenant-1");
    const event = msg("campaign.sent", { campaign_id: "campaign-private-42" });

    await deliverAppNotificationForTests(event);

    const options = mocks.showNotification.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(options?.activationId).toMatch(/^[0-9a-f]{16}$/u);
    expect(options).not.toHaveProperty("target");
    expect(options).not.toHaveProperty("deepLink");
    expect(JSON.stringify(options)).not.toContain("campaign-private-42");
  });

  it("uses encrypted center delivery state after process-local dedupe resets", async () => {
    await configureNotificationCenterIdentity("user-1", "tenant-1");
    updateDesktopNotificationPreferences({
      osEnabled: true,
      foregroundPolicy: "os-and-center",
    });
    const event = msg("campaign.sent", { campaign_id: "campaign-replayed" });

    await deliverAppNotificationForTests(event, { respectPolicy: true });
    resetAppNotifierForTests();
    await deliverAppNotificationForTests(event, { respectPolicy: true });

    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(getNotificationCenterSnapshot().entries[0]?.delivery).toBe(
      "delivered",
    );
  });

  it("does not surface an old policy-suppressed event after preferences change", async () => {
    await configureNotificationCenterIdentity("user-1", "tenant-1");
    const event = msg("campaign.sent", { campaign_id: "campaign-quiet" });

    await deliverAppNotificationForTests(event, { respectPolicy: true });
    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(getNotificationCenterSnapshot().entries).toHaveLength(1);
    expect(getNotificationCenterSnapshot().entries[0]?.delivery).toBe(
      "suppressed-disabled",
    );

    updateDesktopNotificationPreferences({
      osEnabled: true,
      foregroundPolicy: "os-and-center",
    });
    await deliverAppNotificationForTests(event, { respectPolicy: true });
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });
});
