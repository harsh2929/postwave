// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  NativeUpdateStateSnapshot,
  UpdateCheckResult,
} from "../../lib/tauri";

const mocks = vi.hoisted(() => ({
  callOrder: [] as string[],
  callbacks: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn(),
  getUpdateState: vi.fn(),
  getAppVersion: vi.fn(),
  checkForUpdates: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    getUpdateState: mocks.getUpdateState,
    getAppVersion: mocks.getAppVersion,
    checkForUpdates: mocks.checkForUpdates,
    installUpdate: mocks.installUpdate,
    restartApp: mocks.restartApp,
  },
}));

import {
  checkForDesktopUpdate,
  confirmDesktopUpdateRestart,
  deferDesktopUpdate,
  getDesktopUpdateState,
  initializeDesktopUpdateService,
  installDesktopUpdate,
  isDesktopUpdateAttentionDue,
  registerUpdateRestartGuard,
  requestDesktopUpdateRestart,
  resetDesktopUpdateServiceForTests,
} from "../../lib/desktop-update-service";

beforeEach(() => {
  resetDesktopUpdateServiceForTests();
  window.localStorage.clear();
  mocks.callOrder.length = 0;
  mocks.callbacks.clear();
  for (const mock of [
    mocks.listen,
    mocks.getUpdateState,
    mocks.getAppVersion,
    mocks.checkForUpdates,
    mocks.installUpdate,
    mocks.restartApp,
  ]) {
    mock.mockReset();
  }
  mocks.listen.mockImplementation(
    async (event: string, callback: (event: { payload: unknown }) => void) => {
      mocks.callOrder.push(`listen:${event}`);
      mocks.callbacks.set(event, callback);
      return vi.fn();
    },
  );
  mocks.getUpdateState.mockImplementation(async () => {
    mocks.callOrder.push("snapshot");
    return null;
  });
  mocks.getAppVersion.mockResolvedValue({ version: "1.0.0", commit: null });
  mocks.restartApp.mockResolvedValue(undefined);
});

afterEach(() => {
  resetDesktopUpdateServiceForTests();
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("desktop update service", () => {
  it("installs both listeners before requesting the retained native snapshot", async () => {
    await initializeDesktopUpdateService();
    expect(mocks.callOrder).toEqual([
      "listen:updater:state",
      "listen:updater:download-progress",
      "snapshot",
    ]);
    expect(getDesktopUpdateState()).toMatchObject({
      initialized: true,
      currentVersion: "1.0.0",
    });
  });

  it("can retry initialization after a transient native listener failure", async () => {
    mocks.listen.mockRejectedValueOnce(new Error("webview not ready"));
    await initializeDesktopUpdateService();
    expect(getDesktopUpdateState()).toMatchObject({
      initialized: true,
      phase: "error",
      error: "webview not ready",
    });

    await initializeDesktopUpdateService();
    expect(mocks.getUpdateState).toHaveBeenCalledTimes(1);
    expect(getDesktopUpdateState()).toMatchObject({
      initialized: true,
      currentVersion: "1.0.0",
    });
  });

  it("recovers an available scheduled update emitted before renderer startup", async () => {
    const available = result({ source: "scheduled", checked_at_ms: 200 });
    mocks.getUpdateState.mockResolvedValueOnce(snapshot(available));
    await initializeDesktopUpdateService();

    expect(getDesktopUpdateState()).toMatchObject({
      phase: "available",
      latestVersion: "1.1.0",
      severity: "important",
      releaseNotes: "Reliability and security fixes.",
      checkSource: "scheduled",
      lastCheckedAt: 200,
    });
    expect(
      window.localStorage.getItem("postwave.desktop.update-state.v1"),
    ).toContain('"phase":"available"');
  });

  it("clears a persisted restart reminder after the installed or newer version boots", async () => {
    window.localStorage.setItem(
      "postwave.desktop.update-state.v1",
      JSON.stringify({
        version: 1,
        phase: "ready_to_restart",
        currentVersion: "1.0.0",
        latestVersion: "1.1.0",
        severity: "important",
        releaseNotes: "Fixes",
        publishedAt: null,
        lastCheckedAt: 100,
        checkSource: "manual",
        error: null,
        lastFailedOperation: null,
        snoozedUntil: null,
        lastPromptedVersion: "1.1.0",
        lastPromptedAt: 100,
      }),
    );
    mocks.getAppVersion.mockResolvedValueOnce({
      version: "1.2.0",
      commit: null,
    });
    await initializeDesktopUpdateService();
    expect(getDesktopUpdateState()).toMatchObject({
      phase: "up_to_date",
      currentVersion: "1.2.0",
      latestVersion: null,
      releaseNotes: null,
    });
  });

  it("retains verified availability when a later scheduled check fails", async () => {
    mocks.getUpdateState.mockResolvedValueOnce(
      snapshot(result({ checked_at_ms: 100 })),
    );
    await initializeDesktopUpdateService();
    emit("updater:state", {
      result: null,
      error: "release host unavailable",
      checked_at_ms: 300,
      source: "scheduled",
    } satisfies NativeUpdateStateSnapshot);

    expect(getDesktopUpdateState()).toMatchObject({
      phase: "available",
      latestVersion: "1.1.0",
      error: "release host unavailable",
      lastFailedOperation: "check",
      lastCheckedAt: 300,
    });
  });

  it("tracks determinate download progress and persists restart-required state", async () => {
    mocks.getUpdateState.mockResolvedValueOnce(snapshot(result()));
    mocks.installUpdate.mockImplementation(async () => {
      emit("updater:download-progress", { downloaded: 512, total: 1024 });
      expect(getDesktopUpdateState()).toMatchObject({
        phase: "downloading",
        downloadedBytes: 512,
        totalBytes: 1024,
      });
      emit("updater:download-progress", { downloaded: 1024, total: 1024 });
      expect(getDesktopUpdateState().phase).toBe("installing");
      return { status: "installed", version: "1.1.0" };
    });

    await initializeDesktopUpdateService();
    await installDesktopUpdate();
    expect(getDesktopUpdateState()).toMatchObject({
      phase: "ready_to_restart",
      latestVersion: "1.1.0",
      downloadedBytes: 1024,
    });
    expect(
      window.localStorage.getItem("postwave.desktop.update-state.v1"),
    ).toContain('"phase":"ready_to_restart"');
  });

  it("keeps failed checks retryable without fabricating up-to-date state", async () => {
    mocks.checkForUpdates.mockRejectedValueOnce(new Error("manifest timeout"));
    await initializeDesktopUpdateService();
    await checkForDesktopUpdate();
    expect(getDesktopUpdateState()).toMatchObject({
      phase: "error",
      error: "manifest timeout",
      lastFailedOperation: "check",
      checkSource: "manual",
    });
  });

  it("does not erase a verified update when a manual recheck times out", async () => {
    mocks.getUpdateState.mockResolvedValueOnce(snapshot(result()));
    mocks.checkForUpdates.mockRejectedValueOnce(new Error("manifest timeout"));
    await initializeDesktopUpdateService();
    await checkForDesktopUpdate();
    expect(getDesktopUpdateState()).toMatchObject({
      phase: "available",
      latestVersion: "1.1.0",
      error: "manifest timeout",
      lastFailedOperation: "check",
    });
  });

  it("suppresses the attention badge until a reminder is due", async () => {
    mocks.getUpdateState.mockResolvedValueOnce(snapshot(result()));
    await initializeDesktopUpdateService();
    expect(isDesktopUpdateAttentionDue()).toBe(true);
    deferDesktopUpdate(4 * 60 * 60 * 1000);
    expect(isDesktopUpdateAttentionDue()).toBe(false);
  });

  it("reactivates attention and prompting when the requested reminder expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T10:00:00Z"));
    mocks.getUpdateState.mockResolvedValueOnce(snapshot(result()));
    await initializeDesktopUpdateService();
    deferDesktopUpdate(60_000);
    expect(isDesktopUpdateAttentionDue()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getDesktopUpdateState().snoozedUntil).toBeNull();
    expect(isDesktopUpdateAttentionDue()).toBe(true);
  });

  it("requires an explicit restart decision and runs registered preparation", async () => {
    const prepare = vi.fn();
    registerUpdateRestartGuard({
      id: "draft",
      label: "Campaign draft",
      inspect: () => ({
        level: "warning",
        detail: "The draft is saved locally but its editor will close.",
      }),
      prepare,
    });

    await requestDesktopUpdateRestart();
    expect(getDesktopUpdateState().restartDecision).toEqual({
      status: "ready",
      concerns: [
        {
          guardId: "draft",
          label: "Campaign draft",
          level: "warning",
          detail: "The draft is saved locally but its editor will close.",
        },
      ],
    });
    expect(mocks.restartApp).not.toHaveBeenCalled();
    await confirmDesktopUpdateRestart();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mocks.restartApp).toHaveBeenCalledTimes(1);
  });

  it("fails restart closed when a guard is blocking or cannot be inspected", async () => {
    registerUpdateRestartGuard({
      id: "upload",
      label: "Subscriber import",
      inspect: () => ({ level: "blocking", detail: "Upload is still active." }),
    });
    registerUpdateRestartGuard({
      id: "unknown",
      label: "Draft registry",
      inspect: () => {
        throw new Error("registry unavailable");
      },
    });

    await requestDesktopUpdateRestart();
    expect(getDesktopUpdateState().restartDecision?.concerns).toHaveLength(2);
    await confirmDesktopUpdateRestart();
    expect(mocks.restartApp).not.toHaveBeenCalled();
  });

  it("requires another decision when restart safety changes after review", async () => {
    let blocking = false;
    registerUpdateRestartGuard({
      id: "editor",
      label: "Editor",
      inspect: () =>
        blocking
          ? { level: "blocking", detail: "A save started after review." }
          : null,
    });
    await requestDesktopUpdateRestart();
    blocking = true;
    await confirmDesktopUpdateRestart();
    expect(mocks.restartApp).not.toHaveBeenCalled();
    expect(getDesktopUpdateState().restartDecision?.concerns).toEqual([
      {
        guardId: "editor",
        label: "Editor",
        level: "blocking",
        detail: "A save started after review.",
      },
    ]);
  });
});

function result(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    status: "available",
    available: true,
    current_version: "1.0.0",
    latest_version: "1.1.0",
    notes: "Reliability and security fixes.",
    severity: "important",
    published_at: "2026-07-16T08:00:00Z",
    checked_at_ms: 100,
    source: "scheduled",
    ...overrides,
  };
}

function snapshot(update: UpdateCheckResult): NativeUpdateStateSnapshot {
  return {
    result: update,
    error: null,
    checked_at_ms: update.checked_at_ms,
    source: update.source,
  };
}

function emit(event: string, payload: unknown): void {
  const callback = mocks.callbacks.get(event);
  if (!callback) throw new Error(`Missing listener for ${event}`);
  callback({ payload });
}
