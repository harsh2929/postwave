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
  navigateDesktopRoute: vi.fn(),
  refreshKeyFlags: vi.fn().mockResolvedValue(undefined),
  removeWorkspace: vi.fn(),
  requestFullSignOut: vi.fn(),
  setTheme: vi.fn(),
  switchWorkspace: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  setTheme: mocks.setTheme,
  useTheme: () => "dark",
  useThemePreference: () => "system",
}));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigateDesktopRoute,
}));
vi.mock("../../lib/auth", () => ({
  requestFullSignOut: mocks.requestFullSignOut,
}));
vi.mock("../../lib/workspaces", () => ({
  addWorkspace: vi.fn(),
  refreshWorkspaceKeyFlags: mocks.refreshKeyFlags,
  removeWorkspace: mocks.removeWorkspace,
  switchWorkspace: mocks.switchWorkspace,
  useWorkspaces: () => ({
    activeId: "workspace-1",
    profiles: [
      {
        id: "workspace-1",
        name: "Acme",
        apiUrl: "https://api.example.test",
        hasKey: true,
      },
    ],
  }),
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { WorkspaceMenu } from "../../components/WorkspaceMenu";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let anchor: HTMLButtonElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 880,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 560,
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  anchor = document.createElement("button");
  anchor.textContent = "Workspace trigger";
  anchor.getBoundingClientRect = () =>
    ({
      bottom: 76,
      height: 48,
      left: 0,
      right: 64,
      top: 28,
      width: 64,
      x: 0,
      y: 28,
      toJSON: () => ({}),
    }) as DOMRect;
  document.body.appendChild(anchor);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  anchor?.remove();
  anchor = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorkspaceMenu accessibility", () => {
  it("portals beside the compact sidebar and supports APG menu focus keys", () => {
    const onClose = vi.fn();
    render(onClose);
    const menu = document.getElementById("workspace-menu");
    const items = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#workspace-menu [role="menuitem"], #workspace-menu [role="menuitemradio"]',
      ),
    );
    expect(menu?.parentElement).toBe(document.body);
    expect(container?.contains(menu)).toBe(false);
    expect(menu?.style.left).toBe("72px");
    expect(menu?.style.width).toBe("300px");
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => {
      items[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items.at(-1));
  });

  it("ignores composing Escape, then closes and restores the trigger", async () => {
    const onClose = vi.fn();
    render(onClose);
    const composingEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    Object.defineProperty(composingEscape, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composingEscape);
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () => Promise.resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(anchor);
  });

  it("keeps hosted confirmation outside menu ownership and suspends dismissal", () => {
    const onClose = vi.fn();
    render(onClose);
    const menu = document.getElementById("workspace-menu");
    const signOut = Array.from(
      menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    ).find((item) => item.textContent?.trim() === "Sign out");
    act(() => signOut?.click());
    const dialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"], [role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(menu?.contains(dialog)).toBe(false);
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

function render(onClose: () => void): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <WorkspaceMenu
        open
        anchor={anchor}
        onClose={onClose}
        workspaceName="Acme"
        workspaceSlug="owner@example.test"
      />,
    ),
  );
}
