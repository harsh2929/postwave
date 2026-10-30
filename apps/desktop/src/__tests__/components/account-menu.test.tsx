// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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

import type { AuthMeResponse } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  getAuthMe: vi.fn(),
  getAppVersion: vi.fn(),
  openUrl: vi.fn(),
  fullSignOut: vi.fn(),
  setSection: vi.fn(),
  navigateDesktopRoute: vi.fn(),
  setTheme: vi.fn(),
  toggleViewerMode: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  listen: vi.fn(),
  checkForDesktopUpdate: vi.fn(),
  installDesktopUpdate: vi.fn(),
  requestDesktopUpdateRestart: vi.fn(),
  retryDesktopUpdate: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

vi.mock("../../lib/api-client", () => ({
  apiAuth: { getAuthMe: mocks.getAuthMe },
}));

vi.mock("../../hooks/useDialogStack", () => ({
  useDialogStack: () => ({ isTop: true }),
}));

vi.mock("../../lib/dialogStack", () => ({
  pushDialog: vi.fn(),
  popDialog: vi.fn(),
}));

vi.mock("../../lib/auth", () => ({
  requestFullSignOut: mocks.fullSignOut,
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigateDesktopRoute,
}));

vi.mock("../../lib/store", () => ({
  setSection: mocks.setSection,
  setTheme: mocks.setTheme,
  toggleViewerMode: mocks.toggleViewerMode,
  useCanUseViewerMode: () => true,
  useMe: () => ({ role: "admin", tenant: "fallback-tenant" }),
  useTheme: () => "dark",
  useThemePreference: () => "system",
  useViewerModeActive: () => false,
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => false,
  tauriApi: {
    getAppVersion: mocks.getAppVersion,
    openUrl: mocks.openUrl,
    checkForUpdates: vi.fn(),
    installUpdate: vi.fn(),
    restartApp: vi.fn(),
  },
}));

vi.mock("../../lib/desktop-update-service", () => ({
  checkForDesktopUpdate: mocks.checkForDesktopUpdate,
  installDesktopUpdate: mocks.installDesktopUpdate,
  requestDesktopUpdateRestart: mocks.requestDesktopUpdateRestart,
  retryDesktopUpdate: mocks.retryDesktopUpdate,
  useDesktopUpdateState: () => ({
    initialized: true,
    phase: "up_to_date",
    currentVersion: "2.4.0",
    latestVersion: null,
    severity: "recommended",
    releaseNotes: null,
    publishedAt: null,
    lastCheckedAt: Date.now(),
    checkSource: "manual",
    error: null,
    lastFailedOperation: null,
    downloadedBytes: 0,
    totalBytes: null,
    snoozedUntil: null,
    lastPromptedVersion: null,
    lastPromptedAt: null,
    restartDecision: null,
    restarting: false,
  }),
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
    progress: vi.fn(),
  },
}));

import { AccountMenu, computeInitials } from "../../components/AccountMenu";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let accountTrigger: HTMLButtonElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getAuthMe.mockResolvedValue({ data: identity() });
  mocks.getAppVersion.mockResolvedValue({ version: "2.4.0" });
  mocks.openUrl.mockResolvedValue(undefined);
  mocks.fullSignOut.mockResolvedValue("proceeded");
  mocks.toggleViewerMode.mockResolvedValue(true);
  mocks.listen.mockResolvedValue(vi.fn());
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  accountTrigger = document.createElement("button");
  accountTrigger.textContent = "Account trigger";
  document.body.appendChild(accountTrigger);
});

afterEach(() => {
  vi.useRealTimers();
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  accountTrigger = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function identity(overrides: Partial<AuthMeResponse> = {}): AuthMeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "jane.doe@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme Publishing",
    workspace_slug: "acme",
    totp_enabled: true,
    ...overrides,
  };
}

function menu(open: boolean, onClose = vi.fn()): ReactElement {
  return (
    <AccountMenu trigger={accountTrigger} open={open} onClose={onClose} />
  );
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim().includes(label));
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AccountMenu", () => {
  it("derives stable initials from identity fallbacks", () => {
    expect(computeInitials("jane.doe@example.com", "Acme Publishing")).toBe(
      "JD",
    );
    expect(computeInitials("", "Acme Publishing")).toBe("AP");
    expect(computeInitials("", "")).toBe("P");
  });

  it("loads and renders server identity and app version", async () => {
    render(menu(true));
    await flush();

    expect(mocks.getAuthMe).toHaveBeenCalledTimes(1);
    expect(mocks.getAppVersion).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("jane.doe@example.com");
    expect(document.body.textContent).toContain("Acme Publishing");
    expect(document.body.textContent).toContain("2FA on");
    expect(document.body.textContent).toContain("v2.4.0");
  });

  it("clears the prior identity before a reopened menu finishes loading", async () => {
    const replacement = deferred<{ data: AuthMeResponse }>();
    mocks.getAuthMe
      .mockResolvedValueOnce({ data: identity() })
      .mockReturnValueOnce(replacement.promise);
    const view = render(menu(true));
    await flush();
    expect(document.body.textContent).toContain("jane.doe@example.com");

    view.rerender(menu(false));
    view.rerender(menu(true));
    expect(document.body.textContent).not.toContain("jane.doe@example.com");
    expect(document.body.textContent).toContain("Loading…");

    replacement.resolve({
      data: identity({ email: "next@example.com", workspace_name: "Next Co" }),
    });
    await flush();
    expect(document.body.textContent).toContain("next@example.com");
  });

  it("routes quick actions and closes only navigational actions", async () => {
    const onClose = vi.fn();
    render(menu(true, onClose));
    await flush();

    act(() => button("Switch to light theme").click());
    expect(mocks.setTheme).toHaveBeenCalledWith("light");
    expect(onClose).not.toHaveBeenCalled();

    act(() => button("API keys & playground").click());
    expect(mocks.setSection).toHaveBeenCalledWith("apiPlayground");
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => button("Account security").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "settings",
      settingsAnchor: "security",
    });
    act(() => button("Workspace settings").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "settings",
      settingsAnchor: "workspace-profile",
    });
    expect(onClose).toHaveBeenCalledTimes(3);

    act(() => button("Keyboard shortcuts").click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "settings",
      settingsAnchor: "keyboard-shortcuts",
    });
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it("closes on an outside pointer or topmost Escape", async () => {
    const onClose = vi.fn();
    render(menu(true, onClose));
    await flush();

    act(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    await flush();
    expect(document.activeElement).toBe(accountTrigger);
  });

  it("enters one menu focus model and supports arrows, Home, End, and typeahead", async () => {
    render(menu(true));
    await flush();
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]',
      ),
    ).filter((item) => !item.disabled);
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((item) => item.tabIndex === -1)).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    act(() => {
      items[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items[1]);
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(items.at(-1));
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toContain("Account security");
  });

  it("delegates update checks to the persistent root service", async () => {
    const onClose = vi.fn();
    render(menu(true, onClose));
    await flush();
    act(() => button("Check for updates").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.checkForDesktopUpdate).toHaveBeenCalledTimes(1);
  });

  it("signs out only after in-app confirmation", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(menu(true, onClose));
    await flush();

    act(() => button("Sign out").click());
    expect(mocks.fullSignOut).not.toHaveBeenCalled();
    const menuRoot = document.getElementById("account-menu");
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="dialog"] button, [role="alertdialog"] button',
      ),
    ).find((candidate) => candidate.textContent?.trim() === "Sign out");
    if (!confirm) throw new Error("Missing sign-out confirmation");
    expect(menuRoot?.contains(confirm.closest('[role="dialog"]'))).toBe(false);
    act(() => confirm.click());
    await flush();

    expect(mocks.fullSignOut).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Signed out");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
