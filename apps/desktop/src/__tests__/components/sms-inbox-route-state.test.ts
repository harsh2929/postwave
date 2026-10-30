import { describe, expect, it } from "vitest";

import {
  SMS_BROADCAST_PROGRESS_OVERLAY,
  routeWithSMSInboxView,
  safeSMSInboxBoundaryRoute,
  smsInboxRouteView,
} from "../../components/sms/sms-inbox-route";
import {
  serializeDesktopRoute,
  type DesktopRoute,
} from "../../lib/desktop-router";

describe("SMS Inbox route state", () => {
  it("restores only non-sensitive inbox controls", () => {
    const route: DesktopRoute = {
      section: "smsInbox",
      sort: { field: "unread", direction: "asc" },
      filters: [
        { key: "conversation-filter", value: "unread" },
        { key: "conversation-lifecycle", value: "snoozed" },
      ],
    };

    expect(smsInboxRouteView(route)).toEqual({
      mode: "inbox",
      status: "snoozed",
      filter: "unread",
      sort: "oldest_unread",
      broadcastProgressId: null,
      needsNormalization: false,
    });
  });

  it("fails closed on malformed phones, unknown state, and foreign filters", () => {
    const route: DesktopRoute = {
      section: "smsInbox",
      resourceId: "not-a-phone",
      tab: "future-mode",
      sort: { field: "secret", direction: "desc" },
      filters: [
        { key: "conversation-filter", value: "everything" },
        { key: "foreign", value: "private" },
      ],
      overlay: { name: SMS_BROADCAST_PROGRESS_OVERLAY, resourceId: "x" },
    };

    expect(smsInboxRouteView(route)).toMatchObject({
      mode: "inbox",
      status: "active",
      filter: "all",
      sort: "recent",
      broadcastProgressId: null,
      needsNormalization: true,
    });
    expect(routeWithSMSInboxView(route, smsInboxRouteView(route))).toEqual({
      section: "smsInbox",
    });
  });

  it("keeps only a verified progress row in Broadcasts mode", () => {
    const id = "20000000-0000-4000-8000-000000000001";
    const route = routeWithSMSInboxView(
      {
        section: "smsInbox",
        resourceId: "+12025550118",
        query: "private search",
      },
      { mode: "broadcasts", broadcastProgressId: id },
    );
    expect(route).toEqual({
      section: "smsInbox",
      tab: "broadcasts",
      overlay: { name: SMS_BROADCAST_PROGRESS_OVERLAY, resourceId: id },
    });
    expect(smsInboxRouteView(route).broadcastProgressId).toBe(id);
  });

  it("strips phone and free-text search from every canonical route", () => {
    const privateRoute: DesktopRoute = {
      section: "smsInbox",
      resourceId: "+12025550118",
      query: "private message body",
    };
    expect(smsInboxRouteView(privateRoute).needsNormalization).toBe(true);
    expect(
      JSON.stringify(
        routeWithSMSInboxView(privateRoute, smsInboxRouteView(privateRoute)),
      ),
    ).not.toMatch(/12025550118|private message body/u);
    const safeRoute = routeWithSMSInboxView(
      privateRoute,
      smsInboxRouteView(privateRoute),
    );
    const canonicalUrl = serializeDesktopRoute(safeRoute);
    const browserHistoryState = JSON.stringify({
      canonicalUrl,
      route: safeRoute,
    });
    expect(canonicalUrl).toBe("/app/sms-inbox");
    expect(browserHistoryState).not.toMatch(
      /12025550118|private message body/u,
    );
    expect(safeSMSInboxBoundaryRoute()).toEqual({ section: "smsInbox" });
  });
});
