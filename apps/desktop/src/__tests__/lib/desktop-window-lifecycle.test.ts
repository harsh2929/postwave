// @vitest-environment happy-dom

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
  callbacks: new Map<string, () => void>(),
  hide: vi.fn<() => Promise<void>>(),
  quit: vi.fn<() => Promise<void>>(),
  cancel: vi.fn<() => Promise<void>>(),
  reload: vi.fn(),
  retained: {
    closeRequested: false,
    quitRequested: false,
    osShutdownRequested: false,
    recoveredInterruptedShutdown: false,
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    mocks.callbacks.set(event, callback);
    return () => mocks.callbacks.delete(event);
  }),
}));

vi.mock("../../lib/auth", () => ({
  requestFullSignOut: vi.fn(async () => "cancelled"),
}));

vi.mock("../../lib/offline-store", () => ({
  clearOfflineStores: vi.fn(async () => undefined),
  getOfflinePersistenceError: vi.fn(() => null),
  offlineQueueIdle: vi.fn(async () => undefined),
  readOfflineQueue: vi.fn(() => []),
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    getPlatform: vi.fn(async () => "windows"),
    desktopWindowLifecycleReady: vi.fn(async () => mocks.retained),
    hideDesktopWindow: mocks.hide,
    quitApp: mocks.quit,
    cancelDesktopWindowIntent: mocks.cancel,
  },
}));

import {
  cancelDesktopCloseEducation,
  chooseDesktopCloseBehavior,
  getDesktopWindowLifecycleState,
  initializeDesktopWindowLifecycle,
  recommendedDesktopCloseBehavior,
  resetDesktopWindowLifecycleForTests,
  setDesktopCloseBehavior,
} from "../../lib/desktop-window-lifecycle";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

beforeAll(async () => {
  await initializeDesktopWindowLifecycle();
});

beforeEach(() => {
  window.localStorage.clear();
  mocks.retained.closeRequested = false;
  mocks.retained.quitRequested = false;
  mocks.retained.osShutdownRequested = false;
  mocks.retained.recoveredInterruptedShutdown = false;
  mocks.hide.mockResolvedValue();
  mocks.quit.mockResolvedValue();
  mocks.cancel.mockResolvedValue();
  resetDesktopWindowLifecycleForTests();
});

afterEach(() => {
  resetLifecycleCoordinatorForTests();
  vi.clearAllMocks();
});

describe("desktop window lifecycle", () => {
  it("educates on the first close and persists the selected hide behavior", async () => {
    mocks.callbacks.get("lifecycle:close-requested")?.();
    expect(getDesktopWindowLifecycleState().closeEducationOpen).toBe(true);

    await chooseDesktopCloseBehavior("hide");

    expect(mocks.hide).toHaveBeenCalledTimes(1);
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(getDesktopWindowLifecycleState()).toMatchObject({
      closeBehavior: "hide",
      closeEducationOpen: false,
    });
    expect(
      window.localStorage.getItem("postwave.desktop.close-behavior.v1"),
    ).toBe("hide");
  });

  it("routes a remembered quit preference through the central transition", async () => {
    setDesktopCloseBehavior("quit");
    mocks.callbacks.get("lifecycle:close-requested")?.();
    await settle();

    expect(mocks.quit).toHaveBeenCalledTimes(1);
    expect(mocks.hide).not.toHaveBeenCalled();
  });

  it("cancels a retained close without changing the preference", () => {
    mocks.callbacks.get("lifecycle:close-requested")?.();
    cancelDesktopCloseEducation();

    expect(getDesktopWindowLifecycleState()).toMatchObject({
      closeBehavior: "ask",
      closeEducationOpen: false,
    });
    expect(mocks.cancel).toHaveBeenCalledWith("close-window");
  });

  it("uses platform conventions only as a recommendation", () => {
    expect(recommendedDesktopCloseBehavior("macos")).toBe("hide");
    expect(recommendedDesktopCloseBehavior("windows")).toBe("quit");
    expect(recommendedDesktopCloseBehavior("linux")).toBe("quit");
  });
});

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
