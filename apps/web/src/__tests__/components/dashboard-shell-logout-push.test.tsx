// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Signing out must revoke this browser's web-push subscription.
//
// The subscription row is bound to (tenant, user, endpoint) and is
// session-independent: clearing the session cookie does not touch it. So on a
// shared browser the previous operator's campaign/bounce/inbox notifications
// kept arriving — rendered unconditionally by the service worker — in front of
// whoever signed in next, with deep links into the old workspace. Mobile has
// always revoked on sign-out (apps/mobile/src/lib/push.ts); web did not.
//
// Two properties are pinned:
//   1. The revoke runs BEFORE logout(), because the server half of the revoke
//      needs the session cookie that logout() destroys.
//   2. A failing revoke never blocks the sign-out. Being unable to reach the
//      unsubscribe endpoint must not trap someone in a session.
//
// Harness (happy-dom + createRoot + act + the shell's module stubs) mirrors
// dashboard-shell-keyboard.test.tsx, the neighbouring test that mounts this
// component.
import { act, createElement, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardShell } from "@/app/(dashboard)/dashboard-shell";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

const IDENTITY = {
  email: "owner@example.com",
  role: "owner" as const,
  tenant_id: "tenant_123",
  user_id: "user_123",
  workspace_name: "Acme News",
  workspace_slug: "acme",
};

const INITIAL_ME = {
  ...IDENTITY,
  auth_provider: "password",
  email_verified: true,
};

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    order,
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    setTheme: vi.fn(),
    whoami: vi.fn(async () => IDENTITY_PLACEHOLDER),
    logout: vi.fn(async () => {
      order.push("logout");
    }),
    listWorkspaces: vi.fn(async () => []),
    listApprovals: vi.fn(async () => []),
    unsubscribeFromWebPush: vi.fn(async () => {
      order.push("unsubscribe");
    }),
    clearQueryState: vi.fn(async () => {
      order.push("clear-query-state");
    }),
    clearOfflineStorage: vi.fn(() => {
      order.push("clear-offline");
    }),
  };
});

// `vi.hoisted` runs before the const above, so the identity is referenced
// lazily through this indirection.
const IDENTITY_PLACEHOLDER = {
  email: "owner@example.com",
  role: "owner" as const,
  tenant_id: "tenant_123",
  user_id: "user_123",
  workspace_name: "Acme News",
  workspace_slug: "acme",
};

vi.mock("next/dynamic", () => ({
  default: () =>
    function DynamicStub({ onReady }: { onReady?: () => void }) {
      useEffect(() => onReady?.(), [onReady]);
      return null;
    },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...props }, children),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: mocks.setTheme }),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  logout: mocks.logout,
  listWorkspaces: mocks.listWorkspaces,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

vi.mock("@/lib/approvals-api", () => ({
  listApprovals: mocks.listApprovals,
}));

vi.mock("@/lib/web-push", () => ({
  unsubscribeFromWebPush: mocks.unsubscribeFromWebPush,
}));

// Spread the originals: other shell modules (the offline outbox, the query
// client) import real helpers from these files, and replacing the whole module
// would break them in ways unrelated to what is under test.
vi.mock("@/lib/query-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/query-client")>()),
  clearQueryState: mocks.clearQueryState,
}));

vi.mock("@/lib/offline-storage-identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline-storage-identity")>()),
  clearOfflineStorage: mocks.clearOfflineStorage,
}));

vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/query-provider", () => ({
  QueryProvider: ({
    children,
    onIdentityChange,
  }: {
    children: ReactNode;
    onIdentityChange?: (me: typeof IDENTITY) => void;
  }) => {
    useEffect(() => {
      onIdentityChange?.(IDENTITY);
    }, [onIdentityChange]);
    return createElement(
      QueryClientProvider,
      { client: testQueryClient },
      createElement("div", null, children),
    );
  },
}));

vi.mock("@/components/tour/TourProvider", () => ({
  TourProvider: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/tour/TourLauncher", () => ({ TourLauncher: () => null }));
vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/components/motion/page-transition", () => ({
  PageTransition: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function mountShell(): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(DashboardShell, { initialMe: INITIAL_ME }));
    await flush();
  });
  await vi.dynamicImportSettled();
  await act(flush);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      container.querySelector(
        'button[aria-label="Account menu for owner@example.com"]',
      )
    ) {
      break;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  return { root, container };
}

function signOutButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Sign out"),
  );
  if (!button) throw new Error("no Sign out control in the dashboard shell");
  return button as HTMLButtonElement;
}

async function clickSignOut(container: HTMLElement): Promise<void> {
  // Sign out lives in the account menu, which has to be opened first.
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Account menu for owner@example.com"]',
  );
  if (!trigger) throw new Error("no account menu trigger in the shell");
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
  });
  await act(async () => {
    signOutButton(container).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await flush();
  });
}

describe("dashboard sign-out revokes web push", () => {
  it("unsubscribes before destroying the session, then tears down local state", async () => {
    const { root, container } = await mountShell();
    try {
      await clickSignOut(container);

      expect(mocks.unsubscribeFromWebPush).toHaveBeenCalledTimes(1);
      // Order is the load-bearing part: the unsubscribe POST is authenticated,
      // so running it after logout() would 401 and leave the row behind.
      expect(mocks.order.indexOf("unsubscribe")).toBeGreaterThanOrEqual(0);
      expect(mocks.order.indexOf("unsubscribe")).toBeLessThan(
        mocks.order.indexOf("logout"),
      );
      expect(mocks.clearQueryState).toHaveBeenCalled();
      expect(mocks.clearOfflineStorage).toHaveBeenCalled();
      expect(mocks.push).toHaveBeenCalledWith("/login");
    } finally {
      act(() => root.unmount());
    }
  });

  it("still signs out when the revocation fails", async () => {
    mocks.unsubscribeFromWebPush.mockRejectedValueOnce(
      new Error("push service unreachable"),
    );
    const { root, container } = await mountShell();
    try {
      await clickSignOut(container);

      expect(mocks.logout).toHaveBeenCalledTimes(1);
      expect(mocks.push).toHaveBeenCalledWith("/login");
    } finally {
      act(() => root.unmount());
    }
  });
});
