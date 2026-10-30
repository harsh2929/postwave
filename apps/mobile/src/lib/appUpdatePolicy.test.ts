import { describe, expect, it } from "vitest";

import {
  APP_UPDATE_CHECK_INTERVAL_MS,
  appUpdateOriginRows,
  describeAppUpdate,
  shouldAutoCheckForUpdate,
  type AppUpdateOrigin,
  type AppUpdatePhase,
} from "./appUpdatePolicy";

const base = {
  enabled: true,
  online: true,
  phase: "idle" as AppUpdatePhase,
  lastCheckedAt: null as number | null,
  now: 1_000_000,
};

describe("shouldAutoCheckForUpdate", () => {
  it("checks once on a fresh launch", () => {
    expect(shouldAutoCheckForUpdate(base)).toBe(true);
  });

  it("never checks in a build that cannot apply an update", () => {
    expect(shouldAutoCheckForUpdate({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoCheckForUpdate({ ...base, phase: "unsupported" })).toBe(
      false,
    );
  });

  it("never spends cellular data while offline", () => {
    expect(shouldAutoCheckForUpdate({ ...base, online: false })).toBe(false);
  });

  it("does not stack a second check on an in-flight one", () => {
    expect(shouldAutoCheckForUpdate({ ...base, phase: "checking" })).toBe(false);
    expect(shouldAutoCheckForUpdate({ ...base, phase: "downloading" })).toBe(
      false,
    );
  });

  it("stops checking once an update is staged", () => {
    // Nothing more can be learned — the answer is already "restart".
    expect(shouldAutoCheckForUpdate({ ...base, phase: "ready" })).toBe(false);
  });

  it("throttles to the configured interval", () => {
    const lastCheckedAt = 1_000_000;
    expect(
      shouldAutoCheckForUpdate({
        ...base,
        lastCheckedAt,
        now: lastCheckedAt + APP_UPDATE_CHECK_INTERVAL_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldAutoCheckForUpdate({
        ...base,
        lastCheckedAt,
        now: lastCheckedAt + APP_UPDATE_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });

  it("recovers when the device clock moves backwards", () => {
    expect(
      shouldAutoCheckForUpdate({
        ...base,
        lastCheckedAt: 5_000_000,
        now: 1_000,
      }),
    ).toBe(true);
  });

  it("retries after a failed check once the interval has passed", () => {
    expect(
      shouldAutoCheckForUpdate({
        ...base,
        phase: "error",
        lastCheckedAt: 0,
        now: APP_UPDATE_CHECK_INTERVAL_MS,
      }),
    ).toBe(true);
  });
});

describe("describeAppUpdate", () => {
  it("offers a restart — and only a restart — once an update is staged", () => {
    const d = describeAppUpdate({
      phase: "ready",
      lastCheckedAt: 1,
      error: null,
    });
    expect(d.action).toBe("restart");
    expect(d.actionLabel).toBe("Restart now");
    expect(d.headline).toBe("Update ready");
  });

  it("offers no control at all in a build without a channel", () => {
    const d = describeAppUpdate({
      phase: "unsupported",
      lastCheckedAt: null,
      error: null,
    });
    expect(d.action).toBeNull();
    expect(d.actionLabel).toBeNull();
    expect(d.detail).toMatch(/store/);
  });

  it("says 'Not checked yet' rather than inventing a timestamp", () => {
    const d = describeAppUpdate({
      phase: "idle",
      lastCheckedAt: null,
      error: null,
    });
    expect(d.detail).toBe("Not checked yet");
  });

  it("surfaces the real failure detail instead of a generic error", () => {
    const d = describeAppUpdate({
      phase: "error",
      lastCheckedAt: 1,
      error: "Network request failed",
    });
    expect(d.detail).toBe("Network request failed");
    expect(d.tone).toBe("warning");
    expect(d.action).toBe("check");
  });

  it("keeps in-flight phases actionless so a double tap cannot stack", () => {
    for (const phase of ["checking", "downloading"] as const) {
      expect(
        describeAppUpdate({ phase, lastCheckedAt: 1, error: null }).action,
      ).toBeNull();
    }
  });
});

describe("appUpdateOriginRows", () => {
  const origin: AppUpdateOrigin = {
    enabled: true,
    channel: "production",
    runtimeVersion: "0.1.0",
    updateId: "abc-123",
    createdAt: null,
    isEmbedded: false,
    isEmergencyLaunch: false,
    emergencyLaunchReason: null,
  };

  it("states 'none' in words for a build with no channel", () => {
    const rows = appUpdateOriginRows({ ...origin, enabled: false });
    expect(rows).toEqual([
      { label: "Update channel", value: "none (store build only)" },
    ]);
  });

  it("names the embedded bundle rather than showing a blank id", () => {
    const rows = appUpdateOriginRows({ ...origin, isEmbedded: true });
    const running = rows.find((r) => r.label === "Running bundle");
    expect(running?.value).toBe("embedded (shipped with the app)");
  });

  it("says 'unset' rather than an empty value for a missing channel", () => {
    const rows = appUpdateOriginRows({
      ...origin,
      channel: null,
      runtimeVersion: null,
    });
    expect(rows.find((r) => r.label === "Update channel")?.value).toBe("unset");
    expect(rows.find((r) => r.label === "Runtime version")?.value).toBe("unset");
  });

  it("surfaces an emergency launch, which is the reason support asks", () => {
    const rows = appUpdateOriginRows({
      ...origin,
      isEmergencyLaunch: true,
      emergencyLaunchReason: "update crashed on launch",
    });
    expect(rows.find((r) => r.label === "Emergency launch")?.value).toBe(
      "update crashed on launch",
    );
  });

  it("omits the publish row entirely when the date is unknown", () => {
    expect(
      appUpdateOriginRows(origin).some((r) => r.label === "Bundle published"),
    ).toBe(false);
  });
});
