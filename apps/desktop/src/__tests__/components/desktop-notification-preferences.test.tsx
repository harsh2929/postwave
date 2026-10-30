// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
  requestPermission: vi.fn(),
  showNotification: vi.fn(),
}));

vi.mock("../../lib/secure-vault", () => ({
  vaultGetJSON: mocks.vaultGet,
  vaultSetJSON: mocks.vaultSet,
}));
vi.mock("../../lib/tauri", () => ({
  tauriApi: {
    requestNotificationPermission: mocks.requestPermission,
    showNotification: mocks.showNotification,
  },
}));

import { DesktopNotificationPreferencesPanel } from "../../components/settings/DesktopNotificationPreferencesPanel";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  resetNotificationCenterForTests,
} from "../../lib/notification-center";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(async () => {
  resetNotificationCenterForTests();
  mocks.vaultGet.mockReset().mockResolvedValue(null);
  mocks.vaultSet.mockReset().mockResolvedValue(undefined);
  mocks.requestPermission.mockReset().mockResolvedValue("granted");
  mocks.showNotification.mockReset().mockResolvedValue(undefined);
  await configureNotificationCenterIdentity("user-1", "tenant-1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DesktopNotificationPreferencesPanel />));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("DesktopNotificationPreferencesPanel", () => {
  it("uses an explicit user gesture for a privacy-safe permission test", async () => {
    expect(mocks.showNotification).not.toHaveBeenCalled();

    await act(async () => {
      button("Enable desktop alerts").click();
      await Promise.resolve();
    });

    expect(getNotificationCenterSnapshot().preferences.osEnabled).toBe(true);
    expect(mocks.requestPermission).toHaveBeenCalledTimes(1);
    expect(mocks.showNotification).toHaveBeenCalledWith({
      title: "Moosewave notifications enabled",
      body: expect.stringMatching(/privacy-safe copy/i),
    });
    expect(document.body.textContent).toContain("Test alert requested");
    expect(button("Disable desktop alerts")).toBeTruthy();
  });

  it("keeps the desired preference and provides recovery when the OS denies permission", async () => {
    mocks.requestPermission.mockResolvedValueOnce("denied");

    await act(async () => {
      button("Enable desktop alerts").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getNotificationCenterSnapshot().preferences.osEnabled).toBe(true);
    expect(mocks.showNotification).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Allow Moosewave in system notification settings",
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("persists per-topic, foreground, and quiet-hour policy immediately", () => {
    const campaign = document.querySelector<HTMLInputElement>(
      "#desktop-notif-campaign",
    );
    act(() => {
      if (!campaign) throw new Error("Missing campaign topic switch");
      campaign.click();
    });
    expect(
      getNotificationCenterSnapshot().preferences.topics["campaign.sent"],
    ).toBe(false);

    const foreground = document.querySelector<HTMLSelectElement>(
      "#desktop-notif-foreground",
    );
    act(() => {
      if (!foreground) throw new Error("Missing foreground policy");
      foreground.value = "os-and-center";
      foreground.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(getNotificationCenterSnapshot().preferences.foregroundPolicy).toBe(
      "os-and-center",
    );

    const quiet = document.querySelector<HTMLInputElement>(
      "#desktop-notif-quiet",
    );
    act(() => {
      if (!quiet) throw new Error("Missing quiet-hours switch");
      quiet.click();
    });
    expect(getNotificationCenterSnapshot().preferences.quietHours.enabled).toBe(
      true,
    );
  });
});
