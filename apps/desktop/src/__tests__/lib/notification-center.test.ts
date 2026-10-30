// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../../lib/secure-vault", () => ({
  vaultGetJSON: vault.get,
  vaultSetJSON: vault.set,
}));

import {
  clearArchivedNotifications,
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  ingestNotification,
  markAllNotificationsRead,
  markNotificationRead,
  notificationDeliveryDecision,
  resetNotificationCenterForTests,
  setNotificationArchived,
  updateDesktopNotificationPreferences,
  applyServerReadState,
} from "../../lib/notification-center";

beforeEach(() => {
  resetNotificationCenterForTests();
  vault.get.mockReset().mockResolvedValue(null);
  vault.set.mockReset().mockResolvedValue(undefined);
});

async function ready(): Promise<void> {
  await configureNotificationCenterIdentity("user-1", "tenant-1");
  expect(getNotificationCenterSnapshot().identity).toBe("ready");
}

async function addCampaign(id = "campaign-1"): Promise<string> {
  const result = await ingestNotification({
    topic: "campaign.sent",
    title: "Campaign sent",
    body: "A campaign finished sending. Open Moosewave for delivery details.",
    occurredAt: new Date().toISOString(),
    eventIdentity: id,
    deepLink: `moosewave://campaign/${id}`,
  });
  expect(result.stored).toBe(true);
  expect(result.id).not.toBeNull();
  return result.id!;
}

describe("notification center", () => {
  it("starts consent-first and isolates encrypted history by a hashed identity key", async () => {
    await ready();

    const snapshot = getNotificationCenterSnapshot();
    expect(snapshot.preferences.osEnabled).toBe(false);
    expect(snapshot.preferences.foregroundPolicy).toBe("center-only");
    expect(vault.get).toHaveBeenCalledWith(
      expect.stringMatching(/^notifications\.center\.v1\.[0-9a-f]{16}$/),
    );
    expect(vault.get.mock.calls[0]?.[0]).not.toContain("user-1");
    expect(vault.get.mock.calls[0]?.[0]).not.toContain("tenant-1");
  });

  it("validates persisted state and enforces the 90-day / 200-entry retention bounds", async () => {
    const now = Date.now();
    const recent = Array.from({ length: 205 }, (_, index) => ({
      id: index.toString(16).padStart(16, "0"),
      topic: "campaign.sent",
      title: "Campaign sent",
      body: "Open Moosewave for delivery details.",
      createdAt: new Date(now - index * 1_000).toISOString(),
      deepLink: null,
      readAt: null,
      archivedAt: null,
      delivery: "delivered",
    }));
    vault.get.mockResolvedValueOnce({
      version: 1,
      entries: [
        ...recent,
        {
          ...recent[0]!,
          id: "ffffffffffffffff",
          createdAt: new Date(now - 91 * 24 * 60 * 60 * 1_000).toISOString(),
        },
        { ...recent[0]!, id: "resource-shaped-id" },
      ],
      preferences: { osEnabled: "yes", quietHours: { startMinute: 9999 } },
    });

    await ready();
    const snapshot = getNotificationCenterSnapshot();
    expect(snapshot.entries).toHaveLength(200);
    expect(
      snapshot.entries.some((entry) => entry.id === "ffffffffffffffff"),
    ).toBe(false);
    expect(
      snapshot.entries.some((entry) => entry.id === "resource-shaped-id"),
    ).toBe(false);
    expect(snapshot.preferences.osEnabled).toBe(false);
    expect(snapshot.preferences.quietHours.startMinute).toBe(22 * 60);
  });

  it("stores bounded generic copy, deduplicates replays, and persists through the vault", async () => {
    await ready();
    const first = await addCampaign();
    const replay = await ingestNotification({
      topic: "campaign.sent",
      title: "Campaign sent",
      body: "A campaign finished sending. Open Moosewave for delivery details.",
      occurredAt: new Date().toISOString(),
      eventIdentity: "campaign-1",
      deepLink: "moosewave://campaign/campaign-1",
    });

    expect(replay).toEqual({ stored: false, id: first });
    expect(getNotificationCenterSnapshot()).toMatchObject({
      unreadCount: 1,
      entries: [
        {
          title: "Campaign sent",
          deepLink: "moosewave://campaign/campaign-1",
          delivery: "pending",
        },
      ],
    });
    await vi.waitFor(() => expect(vault.set).toHaveBeenCalled());
  });

  it("rejects unsafe content and discards an entity-mismatched deep link", async () => {
    await ready();
    expect(
      await ingestNotification({
        topic: "campaign.sent",
        title: "Campaign sent\nsecret",
        body: "Open Moosewave.",
        occurredAt: new Date().toISOString(),
        eventIdentity: "campaign-1",
      }),
    ).toEqual({ stored: false, id: null });

    await ingestNotification({
      topic: "campaign.sent",
      title: "Campaign sent",
      body: "Open Moosewave for details.",
      occurredAt: new Date().toISOString(),
      eventIdentity: "campaign-2",
      deepLink: "moosewave://subscriber/subscriber-1",
    });
    expect(getNotificationCenterSnapshot().entries[0]?.deepLink).toBeNull();
  });

  it("supports durable read, mark-all, archive, restore, and archive clearing", async () => {
    await ready();
    const first = await addCampaign("campaign-1");
    const second = await addCampaign("campaign-2");
    markNotificationRead(first);
    expect(getNotificationCenterSnapshot().unreadCount).toBe(1);
    markAllNotificationsRead();
    expect(getNotificationCenterSnapshot().unreadCount).toBe(0);

    setNotificationArchived(second, true);
    expect(
      getNotificationCenterSnapshot().entries[0]?.archivedAt,
    ).not.toBeNull();
    setNotificationArchived(second, false);
    expect(getNotificationCenterSnapshot().entries[0]?.archivedAt).toBeNull();
    setNotificationArchived(second, true);
    clearArchivedNotifications();
    expect(getNotificationCenterSnapshot().entries).toHaveLength(1);
  });

  it("applies channel, topic, foreground, and overnight quiet-hour policy", async () => {
    await ready();
    const base = {
      topic: "campaign.sent" as const,
      appVisible: false,
      appFocused: false,
    };
    expect(notificationDeliveryDecision(base)).toEqual({
      deliver: false,
      reason: "suppressed-disabled",
    });

    updateDesktopNotificationPreferences({ osEnabled: true });
    expect(
      notificationDeliveryDecision({
        ...base,
        appVisible: true,
        appFocused: true,
      }),
    ).toEqual({ deliver: false, reason: "suppressed-foreground" });
    updateDesktopNotificationPreferences({
      foregroundPolicy: "os-and-center",
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 8 * 60 },
    });
    expect(
      notificationDeliveryDecision({
        ...base,
        now: new Date(2026, 6, 16, 23, 0),
      }),
    ).toEqual({ deliver: false, reason: "suppressed-quiet-hours" });
    expect(
      notificationDeliveryDecision({
        ...base,
        now: new Date(2026, 6, 16, 12, 0),
      }),
    ).toEqual({ deliver: true });

    updateDesktopNotificationPreferences({
      topics: {
        ...getNotificationCenterSnapshot().preferences.topics,
        "campaign.sent": false,
      },
      quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
    });
    expect(notificationDeliveryDecision(base)).toEqual({
      deliver: false,
      reason: "suppressed-topic",
    });
  });

  it("ignores a stale decrypt when identity changes during load", async () => {
    let releaseFirst: ((value: unknown) => void) | undefined;
    vault.get
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(null);

    const first = configureNotificationCenterIdentity("user-a", "tenant-a");
    const second = configureNotificationCenterIdentity("user-b", "tenant-b");
    await second;
    releaseFirst?.({ version: 1, entries: [], preferences: {} });
    await first;

    expect(getNotificationCenterSnapshot().identity).toBe("ready");
    expect(vault.get).toHaveBeenCalledTimes(2);
  });

  it("surfaces a persistence failure without losing the in-memory notification", async () => {
    vault.set.mockRejectedValueOnce(new Error("vault locked"));
    await ready();
    await addCampaign();

    await vi.waitFor(() =>
      expect(getNotificationCenterSnapshot().persistError).toBe(true),
    );
    expect(getNotificationCenterSnapshot().entries).toHaveLength(1);
  });
});

describe("applyServerReadState — the vault side of the cross-device sync", () => {
  it("only ever moves read state toward READ", async () => {
    // The safety property of the whole sync. If a server row MISSING `read_at`
    // could un-read a local entry, one device would silently undo another's
    // decision and the notification would "come back" — the failure that makes
    // people stop trusting a synced inbox. Read is user intent, and user intent
    // does not un-happen.
    await ready();
    await addCampaign("ev-monotonic");
    expect(getNotificationCenterSnapshot().entries[0]?.readAt).toBeNull();

    // Server says read → local becomes read.
    expect(applyServerReadState(() => true)).toBe(1);
    const readAt = getNotificationCenterSnapshot().entries[0]?.readAt;
    expect(readAt).not.toBeNull();

    // Server says NOT read → local stays read, and nothing is rewritten.
    expect(applyServerReadState(() => false)).toBe(0);
    expect(getNotificationCenterSnapshot().entries[0]?.readAt).toBe(readAt);
  });

  it("applies only to the entries the predicate selects", async () => {
    await ready();
    await addCampaign("ev-a");
    await addCampaign("ev-b");
    const target = getNotificationCenterSnapshot().entries[0]!.id;
    expect(applyServerReadState((e) => e.id === target)).toBe(1);
    const after = getNotificationCenterSnapshot().entries;
    expect(after.find((e) => e.id === target)?.readAt).not.toBeNull();
    expect(after.find((e) => e.id !== target)?.readAt).toBeNull();
  });

  it("is a no-op before the vault opens, rather than mutating a closed store", async () => {
    // Identity is "none" here: acting would write read markers into whatever
    // vault opens next, which could belong to a different user.
    expect(getNotificationCenterSnapshot().identity).not.toBe("ready");
    expect(applyServerReadState(() => true)).toBe(0);
  });
});
