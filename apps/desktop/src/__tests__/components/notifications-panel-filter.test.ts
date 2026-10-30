// Locks the contract that the bell-dropdown "Recent activity" feed and
// the topbar red-dot indicator both filter out the generic
// http.<method>.<path> rows written by the server's AuditMiddleware.
// Without this filter the panel surfaces noise like
// "Http post api v1 streams token" — the SSE-token refresh that fires
// every 2 minutes per session.

import { describe, expect, it } from "vitest";

import type { AuditRow } from "../../lib/api-client";
import {
  destinationForNotification,
  hasRecentActivity,
  isUserFacingActivity,
} from "../../components/notifications-panel-helpers";

function row(action: string, at = new Date().toISOString()): AuditRow {
  return { id: action, action, at } as AuditRow;
}

describe("isUserFacingActivity", () => {
  it("drops generic http.* forensics rows", () => {
    expect(isUserFacingActivity(row("http.post.api.v1.streams.token"))).toBe(
      false,
    );
    expect(isUserFacingActivity(row("http.delete.api.v1.subscribers.42"))).toBe(
      false,
    );
  });

  it("keeps real product actions", () => {
    expect(isUserFacingActivity(row("campaign.created"))).toBe(true);
    expect(isUserFacingActivity(row("subscriber.import.started"))).toBe(true);
    expect(isUserFacingActivity(row("approval.granted"))).toBe(true);
  });

  it("treats a missing action as user-facing (better to over-show than hide a real row)", () => {
    expect(isUserFacingActivity({ id: "x", at: "" } as AuditRow)).toBe(true);
  });
});

describe("hasRecentActivity after filtering", () => {
  it("does not light the red dot when only http.* noise is present", () => {
    const rows = [
      row("http.post.api.v1.streams.token"),
      row("http.post.api.v1.streams.token"),
    ].filter(isUserFacingActivity);
    expect(hasRecentActivity(rows)).toBe(false);
  });

  it("does light the red dot when a real action is present", () => {
    const rows = [
      row("http.post.api.v1.streams.token"),
      row("campaign.created"),
    ].filter(isUserFacingActivity);
    expect(hasRecentActivity(rows)).toBe(true);
  });
});

describe("notification center destinations", () => {
  it("preserves a validated resource target for exact entity routing", () => {
    expect(
      destinationForNotification({
        category: "campaigns",
        deepLink: "moosewave://campaign/campaign_42",
      }),
    ).toEqual({ section: "campaigns", resourceId: "campaign_42" });
  });

  it("fails closed to the category when a link is unsafe or mismatched", () => {
    expect(
      destinationForNotification({
        category: "campaigns",
        deepLink: "moosewave://subscriber/subscriber_1",
      }),
    ).toEqual({ section: "campaigns" });
    expect(
      destinationForNotification({
        category: "approvals",
        deepLink: "moosewave://approval/../../secrets",
      }),
    ).toEqual({ section: "approvals" });
  });

  it("routes security notifications to account settings", () => {
    expect(
      destinationForNotification({
        category: "security",
        deepLink: "/app/settings/security",
      }),
    ).toEqual({ section: "settings" });
  });

  it("routes inbound SMS by topic and ignores the server's web path", () => {
    expect(
      destinationForNotification({
        category: "analytics",
        eventType: "sms.received",
        deepLink: "/app/sms?tab=inbox&phone=%2B14155550123&body=private",
      }),
    ).toEqual({ section: "smsInbox" });
  });
});
