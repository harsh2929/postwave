// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setCommandOpen: vi.fn(),
  notificationState: { unreadCount: 0 },
}));

vi.mock("../../lib/store", () => ({
  useSection: () => "dashboard",
  useViewerModeActive: () => false,
  setCommandOpen: mocks.setCommandOpen,
}));
vi.mock("../../lib/api-client", () => ({
  api: { listAudit: vi.fn().mockResolvedValue({ data: { rows: [] } }) },
}));
vi.mock("../../lib/notification-center", () => ({
  useNotificationCenter: () => mocks.notificationState,
}));
vi.mock("../../lib/desktop-update-service", () => ({
  useDesktopUpdateState: () => ({ phase: "idle" }),
  isDesktopUpdateAttentionDue: () => false,
}));
vi.mock("../../components/dashboard/LiveSubsChip", () => ({
  LiveSubsChip: () => null,
}));
vi.mock("../../components/TransferCenter", () => ({
  TransferCenter: () => null,
}));
vi.mock("../../components/NotificationsPanel", () => ({
  NotificationsPanel: () => null,
  isUserFacingActivity: () => false,
}));

import { TopBar } from "../../components/TopBar";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  mocks.setCommandOpen.mockReset();
  mocks.notificationState.unreadCount = 0;
});

describe("TopBar search launcher", () => {
  it("keeps an optional help accessory in the flowing topbar", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TopBar
          trailingAccessory={
            <button type="button" className="tour-launcher">
              Help
            </button>
          }
        />,
      );
      await Promise.resolve();
    });

    const topbar = document.querySelector(".topbar");
    const help = document.querySelector(".tour-launcher");
    expect(help?.parentElement).toBe(topbar);
    expect(topbar?.lastElementChild).toBe(help);
  });

  it("uses an honest dialog-launching button instead of a read-only input", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<TopBar />);
      await Promise.resolve();
    });

    const launcher = document.querySelector<HTMLButtonElement>(
      "button.topbar-search",
    );
    expect(launcher?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(launcher?.textContent).toContain("Search commands and records");
    expect(document.querySelector(".topbar-search input")).toBeNull();
    act(() => launcher?.click());
    expect(mocks.setCommandOpen).toHaveBeenCalledWith(true);
  });

  it("uses the Notification Center unread count for both name and badge", async () => {
    mocks.notificationState.unreadCount = 3;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<TopBar />);
      await Promise.resolve();
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      "[data-pw-notif-trigger]",
    );
    expect(trigger?.getAttribute("aria-label")).toBe("Notifications, 3 unread");
    expect(trigger?.querySelector(".topbar-bell-count")?.textContent).toBe("3");
    expect(trigger?.hasAttribute("aria-controls")).toBe(false);
    act(() => trigger?.click());
    expect(trigger?.getAttribute("aria-controls")).toBe(
      "desktop-notification-center",
    );
  });
});
