// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TourLauncher } from "../../components/tour/TourLauncher";
import {
  getHelpLauncherState,
  requestHelpLauncherToggle,
  resetHelpLauncherForTests,
} from "../../lib/help-launcher";
import { topDialog } from "../../lib/dialogStack";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  blocked: false,
  tourOpen: false,
  start: vi.fn(),
  replay: vi.fn(),
  restartSetup: vi.fn(),
  blockerOwnerIds: [] as Array<string | undefined>,
}));

vi.mock("../../hooks/useDesktopShortcut", () => ({
  useDesktopShortcut: () => ({
    binding: { key: "/", modifiers: ["primary"] },
    label: "Ctrl+/",
    ariaKeyShortcuts: "Control+/",
    isCustom: false,
  }),
}));

vi.mock("../../hooks/useOnboardingState", () => ({
  requestOnboardingWizardRestart: mocks.restartSetup,
  useOnboardingState: () => ({ stepsFor: () => ["welcome"] }),
  useOnboardingUiBlockers: (ownerDialogId?: string) => {
    mocks.blockerOwnerIds.push(ownerDialogId);
    return { blocked: mocks.blocked };
  },
}));

vi.mock("../../components/tour/TourProvider", () => ({
  useTour: () => ({
    isOpen: mocks.tourOpen,
    start: mocks.start,
    replay: mocks.replay,
  }),
}));

vi.mock("../../lib/desktop-router", () => ({
  getDesktopRoute: () => ({ section: "dashboard" }),
  useDesktopRoute: () => ({ section: "dashboard" }),
}));

vi.mock("../../lib/online-manager", () => ({
  useConnectivity: () => ({
    status: "online",
    reason: "online",
    checkedAt: 1,
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.blocked = false;
  mocks.tourOpen = false;
  mocks.blockerOwnerIds.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  act(() => root.render(<TourLauncher />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHelpLauncherForTests();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function launcherButton(): HTMLButtonElement {
  const value = container.querySelector<HTMLButtonElement>(".tour-launcher");
  if (!value) throw new Error("Missing launcher button");
  return value;
}

describe("TourLauncher contextual shell", () => {
  it("opens a controlled dialog, focuses primary help, ignores IME Escape, and returns focus on dismissal", async () => {
    act(() => requestHelpLauncherToggle());

    expect(launcherButton().getAttribute("aria-expanded")).toBe("true");
    const blockerOwnerId = mocks.blockerOwnerIds.at(-1);
    expect(blockerOwnerId).toBeTruthy();
    expect(topDialog()).toBe(blockerOwnerId);
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(launcherButton().getAttribute("aria-controls")).toBe(dialog?.id);
    expect(document.activeElement).toBe(dialog);

    const composing = new KeyboardEvent("keydown", { key: "Escape" });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composing);
    });
    expect(getHelpLauncherState().open).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(getHelpLauncherState().open).toBe(false);
    expect(document.activeElement).toBe(launcherButton());
  });

  it("closes before starting the tour or restarting role-eligible setup", () => {
    act(() => requestHelpLauncherToggle());
    const buttons = [...container.querySelectorAll("button")];
    const takeTour = buttons.find((item) =>
      item.textContent?.includes("Take the tour"),
    );
    act(() => takeTour?.click());
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(getHelpLauncherState().open).toBe(false);

    act(() => requestHelpLauncherToggle());
    const restart = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Restart setup",
    );
    act(() => restart?.click());
    expect(mocks.restartSetup).toHaveBeenCalledTimes(1);
    expect(getHelpLauncherState().open).toBe(false);
  });

  it("hides and closes while modal, lifecycle, critical, or hidden-window blockers are active", () => {
    act(() => requestHelpLauncherToggle());
    expect(getHelpLauncherState().open).toBe(true);

    mocks.blocked = true;
    act(() => root.render(<TourLauncher />));

    expect(getHelpLauncherState().open).toBe(false);
    expect(container.querySelector(".tour-launcher")).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
