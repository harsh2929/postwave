/**
 * THE RATCHET FOR "THE BELL AND THE PUSH DISAGREE".
 *
 * `NOTIFICATION_ROUTES` carries ~25 arms — a disabled outbound webhook, a
 * tripped audit sink, a failed payment, a throttled sending domain, a finished
 * migration — and exactly ONE caller ever reached it: the push path, through
 * `usePushResponseRouting`. The in-app inbox called `routeForNotificationTopic`
 * alone, which covers only the content-light topic table, so the SAME
 * notification routed correctly when tapped from the lock screen and did
 * nothing when tapped from the bell. Worse than nothing, in fact: the inbox
 * deliberately withholds the read receipt on an unresolved tap, so the backlog
 * never cleared either.
 *
 * The assertions below are about that disagreement, not about which route each
 * event picks — the destinations are a product decision and pinning all of them
 * here would make every future routing improvement look like a broken test.
 * What IS pinned is the invariant: an event the push path can route, the inbox
 * can route.
 */
import type { Href } from "expo-router";
import { NOTIFICATIONS, channelEligible } from "@postwave/notifications";
import { describe, expect, it } from "vitest";

import { routeForEntityLink } from "./deepLinks";
import {
  routeForFeedNotification,
  routeForRelativeAppPath,
  type NotificationFeedRow,
} from "./notificationRoutes";

function feedRow(overrides: Partial<NotificationFeedRow>): NotificationFeedRow {
  return { kind: "", ...overrides };
}

/** What the inbox actually does: resolve with the router-aware entity parser. */
function inboxRoute(row: NotificationFeedRow): Href | null {
  return routeForFeedNotification(row, routeForEntityLink);
}

function pushEligibleEvents(): string[] {
  return Object.keys(NOTIFICATIONS)
    .filter((event) => channelEligible(event, "push"))
    .sort();
}

describe("in-app inbox routing", () => {
  it("has push-eligible events to check", () => {
    expect(pushEligibleEvents().length).toBeGreaterThan(0);
  });

  it("routes from the bell everything the push path routes", () => {
    // The whole finding in one assertion. Each row is the shape the FEED
    // delivers — `event_type` and no push envelope — not the shape the push
    // path sees.
    const dead = pushEligibleEvents().filter(
      (event) => inboxRoute(feedRow({ kind: event, event_type: event })) === null,
    );
    expect(
      dead,
      `These events route from a push tap but are dead taps in the in-app ` +
        `inbox:\n${dead.join("\n")}`,
    ).toEqual([]);
  });

  it("reaches the operational arms the topic table never covered", () => {
    // These are the rows the finding is about: no entity, no topic, a relative
    // server-written deep link that no mobile grammar accepted.
    expect(
      inboxRoute(
        feedRow({
          kind: "webhook.auto_disabled",
          event_type: "webhook.auto_disabled",
          deep_link: "/app/settings/webhooks",
        }),
      ),
    ).toBe("/(tabs)/webhooks");
    expect(
      inboxRoute(
        feedRow({
          kind: "auditsink.circuit_opened",
          event_type: "auditsink.circuit_opened",
        }),
      ),
    ).toBe("/(tabs)/audit-sinks");
    expect(
      inboxRoute(
        feedRow({ kind: "billing.payment_failed", event_type: "billing.payment_failed" }),
      ),
    ).toBe("/(tabs)/billing");
  });

  it("routes by event_type when `kind` is a different word", () => {
    // `kind` falls back to `ev.Type` only when the producer left `Kind` empty
    // (notifyfanout/fanout.go:212-214), so the two coincide for some rows and
    // not others — which is exactly why the inbox routed some rows and not
    // others. A row whose `kind` is a human label must still route.
    expect(
      inboxRoute(
        feedRow({ kind: "billing", event_type: "billing.payment_failed" }),
      ),
    ).toBe("/(tabs)/billing");
  });

  it("prefers the entity link over the event table's list fallback", () => {
    // The entity link is the only arm that can land on a specific record.
    const route = inboxRoute(
      feedRow({
        kind: "campaign.sent",
        event_type: "campaign.sent",
        deep_link: "/app/campaigns/11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(route).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("uses the payload's entity id when the row carries no link", () => {
    const route = inboxRoute(
      feedRow({
        kind: "campaign.sent",
        event_type: "campaign.sent",
        payload: { id: "22222222-2222-4222-8222-222222222222" },
      }),
    );
    expect(route).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("keeps the topic table FIRST, so SMS content never reaches a URL parser", () => {
    const route = inboxRoute(
      feedRow({
        kind: "sms.received",
        event_type: "sms.received",
        deep_link: "/app/sms?tab=inbox&phone=%2B14155550123&body=Hostile",
      }),
    );
    expect(route).toBe("/(tabs)/sms");
    expect(JSON.stringify(route)).not.toContain("14155550123");
  });

  it("falls back to the server's relative link when no table knows the event", () => {
    // Not a guess: the link NAMES a screen the app ships, written by the
    // server. `dashboardnotify.go` writes exactly this shape, and every
    // grammar in front of this one needs an absolute URL, so it resolved to
    // nothing — and the row kept its unread dot on top of going nowhere.
    expect(
      inboxRoute(
        feedRow({
          kind: "dashboard.anomaly",
          event_type: "dashboard.anomaly",
          deep_link: "/app/analytics",
        }),
      ),
    ).toBe("/(tabs)/analytics");
  });

  it("still resolves nothing for an event this build has never heard of", () => {
    // The fix must not have been made by routing unknown events somewhere.
    expect(
      inboxRoute(feedRow({ kind: "nonsense.invented", event_type: "nonsense.invented" })),
    ).toBeNull();
  });
});

describe("relative /app/<slug> links", () => {
  it("resolves the two-segment paths the server actually writes", () => {
    // dashboardnotify.go:252 / :316, and the grammar in front of this one does
    // `new URL(rawUrl)` in a try/catch, so these matched nothing.
    expect(routeForRelativeAppPath("/app/analytics")).toBe("/(tabs)/analytics");
    expect(routeForRelativeAppPath("/app/subscribers")).toBe(
      "/(tabs)/subscribers",
    );
  });

  it("never becomes a second, laxer universal-link parser", () => {
    // A scheme, a protocol-relative host, an extra segment and an unknown slug
    // must all decline — an unrecognised link stays unrecognised rather than
    // being truncated onto a screen it does not name.
    expect(routeForRelativeAppPath("https://evil.example/app/analytics")).toBeNull();
    expect(routeForRelativeAppPath("//evil.example/app/analytics")).toBeNull();
    expect(routeForRelativeAppPath("/app/analytics/42")).toBeNull();
    expect(routeForRelativeAppPath("/app/not-a-screen")).toBeNull();
    expect(routeForRelativeAppPath("/analytics")).toBeNull();
    expect(routeForRelativeAppPath(undefined)).toBeNull();
    expect(routeForRelativeAppPath(`/app/${"a".repeat(600)}`)).toBeNull();
  });

  it("ignores a query string rather than choking on it", () => {
    expect(routeForRelativeAppPath("/app/analytics?range=7d")).toBe(
      "/(tabs)/analytics",
    );
  });
});
