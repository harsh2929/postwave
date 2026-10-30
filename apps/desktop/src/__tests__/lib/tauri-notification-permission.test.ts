// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { tauriApi } from "../../lib/tauri";

let permission: NotificationPermission;
const requestPermission = vi.fn<() => Promise<NotificationPermission>>();
const constructNotification = vi.fn();

class FakeNotification {
  static get permission(): NotificationPermission {
    return permission;
  }

  static requestPermission(): Promise<NotificationPermission> {
    return requestPermission();
  }

  constructor(title: string, options?: NotificationOptions) {
    constructNotification(title, options);
  }
}

beforeEach(() => {
  permission = "default";
  requestPermission.mockReset().mockImplementation(async () => {
    permission = "granted";
    return "granted";
  });
  constructNotification.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: FakeNotification,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: FakeNotification,
  });
});

describe("desktop notification permission boundary", () => {
  it("never prompts from background showNotification delivery", async () => {
    await expect(
      tauriApi.showNotification({ title: "Update", body: "Open Moosewave." }),
    ).rejects.toThrow("notifications_permission_required");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it("requests permission only through the explicit primer method", async () => {
    await expect(tauriApi.requestNotificationPermission()).resolves.toBe(
      "granted",
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);

    await tauriApi.showNotification({
      title: "Moosewave notifications enabled",
      body: "Privacy-safe test copy.",
    });
    expect(constructNotification).toHaveBeenCalledWith(
      "Moosewave notifications enabled",
      { body: "Privacy-safe test copy." },
    );
  });

  it("reports denied permission without attempting delivery", async () => {
    permission = "denied";
    await expect(tauriApi.requestNotificationPermission()).resolves.toBe(
      "denied",
    );
    expect(requestPermission).not.toHaveBeenCalled();
    await expect(
      tauriApi.showNotification({ title: "Update", body: "Open Moosewave." }),
    ).rejects.toThrow("notifications_permission_denied");
    expect(constructNotification).not.toHaveBeenCalled();
  });

  it("rejects oversized or control-bearing copy before it reaches the OS", async () => {
    permission = "granted";
    await expect(
      tauriApi.showNotification({
        title: "Private\nheader",
        body: "Open Moosewave.",
      }),
    ).rejects.toThrow("notifications_invalid_copy");
    await expect(
      tauriApi.showNotification({
        title: "Moosewave update",
        body: "x".repeat(281),
      }),
    ).rejects.toThrow("notifications_invalid_copy");
    expect(constructNotification).not.toHaveBeenCalled();
  });
});
