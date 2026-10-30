// Tests for the store the bell renders from.
//
// The prior revision of this feature shipped a `status` field with zero
// consumers and an `unreadCount` that only the panel computed — so the bell
// badge and the panel it opened could disagree. Both are covered here.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UnifiedNotificationRow } from "../../lib/notification-feed-reconcile";
import {
  clearNotificationInbox,
  getNotificationInbox,
  setNotificationInbox,
  subscribeNotificationInbox,
} from "../../lib/notification-inbox-store";

const row = (
  over: Partial<UnifiedNotificationRow> = {},
): UnifiedNotificationRow => ({
  key: "k1",
  localId: "loc_1",
  serverId: "srv_1",
  source: "both",
  eventType: "campaign.sent",
  title: "Campaign sent",
  body: "",
  deepLink: null,
  createdAt: "2026-08-04T09:00:00Z",
  readAt: null,
  seenAt: null,
  archivedAt: null,
  delivery: "delivered",
  topic: "campaign.sent",
  ...over,
});

beforeEach(() => clearNotificationInbox());

describe("unreadCount is derived once, for every surface", () => {
  it("counts unread, unarchived rows", () => {
    setNotificationInbox({
      status: "synced",
      rows: [row(), row({ key: "k2", readAt: "2026-08-04T09:01:00Z" })],
    });
    expect(getNotificationInbox().unreadCount).toBe(1);
  });

  it("does not count an ARCHIVED row as pending work", () => {
    setNotificationInbox({
      status: "synced",
      rows: [row({ archivedAt: "2026-08-04T09:30:00Z" })],
    });
    expect(getNotificationInbox().unreadCount).toBe(0);
  });

  it("counts a server-only row the vault never saw", () => {
    // The reason the count moved here: the vault's own count sees only
    // notifications THIS machine received, so a cross-device row made the bell
    // badge read 0 above a panel listing it.
    setNotificationInbox({
      status: "synced",
      rows: [row({ localId: null, source: "server", delivery: "unknown" })],
    });
    expect(getNotificationInbox().unreadCount).toBe(1);
  });
});

describe("identity hygiene", () => {
  it("clearing drops every row and resets the count", () => {
    setNotificationInbox({ status: "synced", rows: [row()] });
    clearNotificationInbox();
    const state = getNotificationInbox();
    expect(state.rows).toEqual([]);
    expect(state.unreadCount).toBe(0);
    expect(state.status).toBe("local");
  });

  it("notifies subscribers on set and on clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationInbox(listener);
    setNotificationInbox({ status: "synced", rows: [row()] });
    expect(listener).toHaveBeenCalledTimes(1);
    clearNotificationInbox();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setNotificationInbox({ status: "synced", rows: [] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("clearing an already-empty store does not churn subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNotificationInbox(listener);
    clearNotificationInbox();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("status", () => {
  it("distinguishes a failed refresh from an empty inbox", () => {
    // These render identically without the flag, and they are not the same
    // thing: one means "nothing to show", the other means "we could not look".
    setNotificationInbox({ status: "error", rows: [] });
    expect(getNotificationInbox().status).toBe("error");
    setNotificationInbox({ status: "synced", rows: [] });
    expect(getNotificationInbox().status).toBe("synced");
  });
});
