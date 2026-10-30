// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  showNotification: vi.fn(),
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { showNotification: mocks.showNotification },
}));
vi.mock("../../lib/secure-vault", () => ({
  vaultGetJSON: mocks.vaultGet,
  vaultSetJSON: mocks.vaultSet,
}));

import {
  notifyMilestoneCrossings,
  notifyNewAnomalies,
} from "../../lib/dashboard-notifier";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  resetNotificationCenterForTests,
  updateDesktopNotificationPreferences,
} from "../../lib/notification-center";

beforeEach(async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetNotificationCenterForTests();
  mocks.vaultGet.mockReset().mockResolvedValue(null);
  mocks.vaultSet.mockReset().mockResolvedValue(undefined);
  mocks.showNotification.mockResolvedValue(undefined);
  await configureNotificationCenterIdentity("user-1", "tenant-1");
  updateDesktopNotificationPreferences({
    osEnabled: true,
    foregroundPolicy: "os-and-center",
    topics: {
      ...getNotificationCenterSnapshot().preferences.topics,
      "dashboard.anomaly": true,
      "dashboard.milestone": true,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dashboard notification privacy", () => {
  it("does not place metric names or values in lock-screen copy", async () => {
    window.sessionStorage.setItem(
      "pw.dashboard.notified.anomalies",
      JSON.stringify(["legacy-plaintext-anomaly-id"]),
    );
    await notifyNewAnomalies([
      {
        id: "anomaly-1",
        tenantId: "tenant-private",
        metric: "private_revenue_metric",
        dayBucket: "2026-07-16",
        value: 98_765,
        mean: 123.4,
        zScore: 9.1,
        rangeUsed: "30d",
        detectedAt: "2026-07-16T10:00:00Z",
      },
    ]);

    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
    const copy = JSON.stringify(mocks.showNotification.mock.calls[0]);
    expect(copy).toContain("Open Moosewave");
    expect(copy).not.toContain("private_revenue_metric");
    expect(copy).not.toContain("98765");
    expect(copy).not.toContain("123.4");
    const dedupe = window.sessionStorage.getItem(
      "pw.dashboard.notified.anomalies",
    );
    expect(dedupe).not.toBeNull();
    expect(dedupe).not.toContain("anomaly-1");
    expect(dedupe).not.toContain("tenant-private");
    expect(dedupe).not.toContain("legacy-plaintext-anomaly-id");
  });

  it("does not place subscriber totals in milestone copy", async () => {
    await notifyMilestoneCrossings(99, "workspace-a");
    await notifyMilestoneCrossings(101, "workspace-a");

    expect(mocks.showNotification).toHaveBeenCalledTimes(1);
    const copy = JSON.stringify(mocks.showNotification.mock.calls[0]);
    expect(copy).toContain("Audience milestone reached");
    expect(copy).not.toContain("100");
    expect(copy).not.toContain("101");
    expect(
      Array.from({ length: window.localStorage.length }, (_, index) =>
        window.localStorage.key(index),
      ).join(" "),
    ).not.toContain("workspace-a");
  });

  it("purges an ownership-ambiguous raw high-water key without adoption", async () => {
    const legacy = "pw.dashboard.milestone.highwater.private-workspace";
    window.localStorage.setItem(legacy, "99");

    expect(await notifyMilestoneCrossings(101, "opaque-identity-scope")).toBe(
      0,
    );
    expect(window.localStorage.getItem(legacy)).toBeNull();
    const keys = Array.from(
      { length: window.localStorage.length },
      (_, index) => window.localStorage.key(index),
    );
    expect(keys.some((key) => key?.includes(".v3."))).toBe(true);
    expect(keys.join(" ")).not.toContain("private-workspace");
    expect(keys.join(" ")).not.toContain("opaque-identity-scope");
  });

  it("retries anomaly delivery after failure instead of committing false dedupe", async () => {
    mocks.showNotification.mockRejectedValueOnce(new Error("OS unavailable"));
    const anomaly = {
      id: "anomaly-retry",
      tenantId: "tenant-1",
      metric: "sensitive_metric",
      dayBucket: "2026-07-16",
      value: 12,
      mean: 3,
      zScore: 4,
      rangeUsed: "30d",
      detectedAt: new Date().toISOString(),
    };

    expect(await notifyNewAnomalies([anomaly])).toBe(0);
    expect(await notifyNewAnomalies([anomaly])).toBe(1);
    expect(mocks.showNotification).toHaveBeenCalledTimes(2);
    expect(getNotificationCenterSnapshot().entries).toHaveLength(1);
    expect(getNotificationCenterSnapshot().entries[0]?.delivery).toBe(
      "delivered",
    );
  });

  it("does not advance a milestone high-water mark past failed delivery", async () => {
    await notifyMilestoneCrossings(99, "workspace-retry");
    mocks.showNotification.mockRejectedValueOnce(new Error("OS unavailable"));

    expect(await notifyMilestoneCrossings(101, "workspace-retry")).toBe(0);
    expect(await notifyMilestoneCrossings(101, "workspace-retry")).toBe(1);
    expect(mocks.showNotification).toHaveBeenCalledTimes(2);
  });
});
