// Auto-update IPC wrappers (gaps doc B5).
//
// Pins the contract the AccountMenu toast flow relies on:
//   - outside Tauri every wrapper degrades to a typed `not_configured`
//     result without touching invoke();
//   - inside Tauri the wrappers call the matching Rust commands and pass
//     payloads through untouched;
//   - real IPC failures surface as TauriCommandError (so the UI can show
//     "Update check failed" instead of a silent no-op).

import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args) as Promise<unknown>,
  Channel: class<T> {
    onmessage: (message: T) => void;
    constructor(onmessage: (message: T) => void) {
      this.onmessage = onmessage;
    }
  },
}));

import { tauriApi, type UpdateCheckResult } from "../../lib/tauri";

function enterTauri(): void {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
}

afterEach(() => {
  invokeMock.mockReset();
  delete (globalThis as { window?: unknown }).window;
});

describe("update wrappers outside Tauri", () => {
  it("checkForUpdates degrades to a typed not_configured result", async () => {
    const res = await tauriApi.checkForUpdates();
    expect(res).toEqual({
      status: "not_configured",
      available: false,
      current_version: "",
      latest_version: null,
      notes: null,
      severity: "recommended",
      published_at: null,
      checked_at_ms: 0,
      source: "manual",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("installUpdate and restartApp no-op safely", async () => {
    await expect(tauriApi.installUpdate()).resolves.toEqual({
      status: "not_configured",
      version: null,
    });
    await expect(tauriApi.restartApp()).resolves.toBeUndefined();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("update wrappers inside Tauri", () => {
  it("checkForUpdates passes the Rust payload through untouched", async () => {
    enterTauri();
    const payload: UpdateCheckResult = {
      status: "available",
      available: true,
      current_version: "0.1.0",
      latest_version: "0.2.0",
      notes: "Fixes the suppression console.",
      severity: "important",
      published_at: "2026-07-16T08:00:00Z",
      checked_at_ms: 1_752_652_800_000,
      source: "manual",
    };
    invokeMock.mockResolvedValueOnce(payload);

    const res = await tauriApi.checkForUpdates();
    expect(invokeMock).toHaveBeenCalledWith("check_for_updates", undefined);
    expect(res).toEqual(payload);
  });

  it("installUpdate invokes install_update", async () => {
    enterTauri();
    invokeMock.mockResolvedValueOnce({ status: "installed", version: "0.2.0" });
    const res = await tauriApi.installUpdate();
    expect(invokeMock).toHaveBeenCalledWith("install_update", undefined);
    expect(res.status).toBe("installed");
  });

  it("retrieves the retained native scheduler state after listeners mount", async () => {
    enterTauri();
    const snapshot = {
      result: null,
      error: "manifest fetch failed",
      checked_at_ms: 1_752_652_800_000,
      source: "scheduled" as const,
    };
    invokeMock.mockResolvedValueOnce(snapshot);
    await expect(tauriApi.getUpdateState()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("get_update_state", undefined);
  });

  it("restartApp invokes restart_app", async () => {
    enterTauri();
    invokeMock.mockResolvedValueOnce(undefined);
    await tauriApi.restartApp();
    expect(invokeMock).toHaveBeenCalledWith("restart_app", undefined);
  });

  it("wraps real IPC failures in TauriCommandError", async () => {
    enterTauri();
    invokeMock.mockRejectedValueOnce("manifest fetch failed");
    await expect(tauriApi.checkForUpdates()).rejects.toMatchObject({
      name: "TauriCommandError",
      command: "check_for_updates",
    });
  });
});
