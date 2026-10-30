/**
 * THE RATCHET FOR "A PUSH THAT LANDS NOWHERE" (AUDIENCE#60).
 *
 * `routeForNotification` is a switch over `event_type`, and its `default` arm
 * returns null — which `usePushResponseRouting` correctly treats as "no
 * navigation", leaving the user on whatever screen the app happened to be on.
 * That is the right behaviour for an event this build has never heard of, and
 * exactly the WRONG behaviour for an event the server is actively pushing at
 * this device.
 *
 * The gap was real and it was silent. `migration.completed` /
 * `migration.failed` are push-eligible AND default-on in the shared manifest,
 * the Go sender posts them against a dedicated Android channel this app
 * registers (`lib/pushChannels.ts`), the user could switch them on in Settings
 * (`lib/pushTopics.ts`, which derives its list from the SAME manifest) — and
 * tapping one did nothing, because the switch simply had no arm. Nothing
 * failed; there was no error to see. That is the class of defect a test has to
 * catch, because a human never will.
 *
 * So: every event the shared manifest says the PUSH channel may carry must
 * resolve to a route. The set is READ FROM THE MANIFEST, never restated here —
 * a hand-copied list is how the two drift, and the drift is the bug.
 *
 * What this deliberately does NOT assert is WHICH route. That is a product
 * decision per event (a campaign push lands on its report, a form push lands
 * on the dashboard because mobile ships no forms tab); pinning it here would
 * make every future routing improvement look like a broken test.
 */
import type { NotificationResponse } from "expo-notifications";
import { NOTIFICATIONS, channelEligible } from "@postwave/notifications";
import { describe, expect, it } from "vitest";

import { routeForNotification } from "./deepLinks";

/** Every manifest event the push channel is allowed to deliver. */
function pushEligibleEvents(): string[] {
  return Object.keys(NOTIFICATIONS)
    .filter((event) => channelEligible(event, "push"))
    .sort();
}

function pushResponse(eventType: string): NotificationResponse {
  return {
    notification: {
      request: {
        content: { data: { event_type: eventType, body: {} } },
      },
    },
  } as unknown as NotificationResponse;
}

describe("push routing contract", () => {
  it("has at least one push-eligible event to check", () => {
    // A manifest that stopped exporting, or an import that resolved to an
    // empty object, would make every assertion below vacuously pass.
    expect(pushEligibleEvents().length).toBeGreaterThan(0);
  });

  it("routes every push-eligible manifest event somewhere", () => {
    const dead = pushEligibleEvents().filter(
      (event) => routeForNotification(pushResponse(event)) === null,
    );
    expect(
      dead,
      `These events are push-eligible in @postwave/notifications but have no arm in ` +
        `routeForNotification, so tapping one leaves the user wherever they were:\n` +
        dead.join("\n"),
    ).toEqual([]);
  });

  it("still returns null for an event this build has never heard of", () => {
    // The guard must not have been satisfied by making the default arm route
    // somewhere — an unknown event has no correct destination, and guessing
    // one would send the user to a screen the notification was not about.
    expect(routeForNotification(pushResponse("nonsense.invented"))).toBeNull();
  });

  it("lands a finished import on the migrations screen", () => {
    // The specific gap this file was written for. `migration.*` carries no
    // entity id (manifest `deepLinkEntity: null`) and mobile ships no
    // `/(tabs)/migrations/[id]`, so the list IS the destination.
    expect(routeForNotification(pushResponse("migration.completed"))).toBe(
      "/(tabs)/migrations",
    );
    expect(routeForNotification(pushResponse("migration.failed"))).toBe(
      "/(tabs)/migrations",
    );
  });

  it("lands a new sign-in alert on the active-session review surface", () => {
    expect(routeForNotification(pushResponse("auth.new_device_sign_in"))).toBe(
      "/(tabs)/settings",
    );
  });

  it("lands a generic inbound-SMS push on the content-light inbox list", () => {
    expect(routeForNotification(pushResponse("sms.received"))).toBe(
      "/(tabs)/sms",
    );
  });
});
