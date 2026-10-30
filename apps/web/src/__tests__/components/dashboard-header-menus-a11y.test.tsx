// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DashboardShell } from "@/app/(dashboard)/dashboard-shell";
import type { UserWorkspace } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The workspace switcher (SHELL-018) reads its list via useQuery, so the
// stubbed QueryProvider below wraps children in a real client.
const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  setTheme: vi.fn(),
  whoami: vi.fn(async () => ({
    email: "owner@example.com",
    role: "owner",
    tenant_id: "tenant_123",
    user_id: "user_123",
    workspace_name: "Acme News",
    workspace_slug: "acme",
  })),
  logout: vi.fn(async () => undefined),
  listWorkspaces: vi.fn(async (): Promise<UserWorkspace[]> => []),
  listApprovals: vi.fn(async () => []),
}));

// DashboardShell deliberately puts these controls behind one shared lazy
// boundary. Await the real module once before the first render so this focused
// happy-dom harness does not race Vitest's cold transform; the shell still
// exercises its production Suspense/lazy path below.
beforeAll(async () => {
  await import("@/app/(dashboard)/dashboard-header-controls");
});

const INITIAL_ME = {
  email: "owner@example.com",
  role: "owner" as const,
  tenant_id: "tenant_123",
  user_id: "user_123",
  workspace_name: "Acme News",
  workspace_slug: "acme",
  auth_provider: "password",
  email_verified: true,
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
    refresh: mocks.refresh,
  }),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  logout: mocks.logout,
  listWorkspaces: mocks.listWorkspaces,
  effectiveAuthRole: (identity: { role: string; effective_role?: string }) =>
    identity.effective_role ?? identity.role,
}));

vi.mock("@/lib/approvals-api", () => ({
  listApprovals: mocks.listApprovals,
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
    onIdentityChange?: (me: {
      email: string;
      role: "owner";
      tenant_id: string;
      user_id: string;
      workspace_name: string;
      workspace_slug: string;
    }) => void;
  }) => {
    useEffect(() => {
      onIdentityChange?.({
        email: "owner@example.com",
        role: "owner",
        tenant_id: "tenant_123",
        user_id: "user_123",
        workspace_name: "Acme News",
        workspace_slug: "acme",
      });
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

vi.mock("@/components/tour/TourLauncher", () => ({
  TourLauncher: () => null,
}));

vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => null,
}));

vi.mock("@/components/motion/page-transition", () => ({
  PageTransition: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

beforeEach(() => {
  mocks.listWorkspaces.mockReset();
  mocks.listWorkspaces.mockResolvedValue([]);
});

afterEach(() => {
  testQueryClient.clear();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

function sendKey(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function clickOutside(): void {
  document.body.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("dashboard header menu accessibility", () => {
  it("uses disclosure navigation semantics for the workspace menu", async () => {
    const root = render(
      createElement(
        DashboardShell,
        { initialMe: INITIAL_ME },
        createElement("main", null, "Dash"),
      ),
    );

    try {
      await act(async () => {
        await flush();
      });

      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Current workspace: Acme News"]',
          ),
        ).not.toBeNull(),
      );
      const trigger = document.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      ) as HTMLButtonElement | null;
      expect(trigger).toBeTruthy();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        trigger?.click();
        await flush();
      });

      const workspaceNav = document.querySelector(
        'nav[aria-label="Workspace actions"]',
      );
      expect(trigger?.getAttribute("aria-expanded")).toBe("true");
      expect(workspaceNav).toBeTruthy();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.querySelector('[role="menuitem"]')).toBeNull();

      trigger?.focus();
      await act(async () => {
        sendKey("Escape");
        await flush();
      });

      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(
        document.querySelector('nav[aria-label="Workspace actions"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("closes the account menu on outside click and link selection", async () => {
    const root = render(
      createElement(
        DashboardShell,
        { initialMe: INITIAL_ME },
        createElement("main", null, "Dash"),
      ),
    );

    try {
      await act(async () => {
        await flush();
      });

      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Account menu for owner@example.com"]',
          ),
        ).not.toBeNull(),
      );
      const trigger = document.querySelector(
        'button[aria-label="Account menu for owner@example.com"]',
      ) as HTMLButtonElement | null;
      expect(trigger).toBeTruthy();

      await act(async () => {
        trigger?.click();
        await flush();
      });
      expect(
        document.querySelector('nav[aria-label="Account actions"]'),
      ).toBeTruthy();
      expect(document.querySelector('[role="menu"]')).toBeNull();

      await act(async () => {
        clickOutside();
        await flush();
      });
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(
        document.querySelector('nav[aria-label="Account actions"]'),
      ).toBeNull();

      await act(async () => {
        trigger?.click();
        await flush();
      });
      const profile = Array.from(document.querySelectorAll("a")).find((link) =>
        link.textContent?.includes("Profile"),
      );
      expect(profile).toBeTruthy();

      await act(async () => {
        profile?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        await flush();
      });

      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(
        document.querySelector('nav[aria-label="Account actions"]'),
      ).toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("distinguishes pending workspace discovery from a resolved single workspace", async () => {
    let resolveWorkspaces!: (value: []) => void;
    mocks.listWorkspaces.mockReturnValue(
      new Promise((resolve) => {
        resolveWorkspaces = resolve;
      }),
    );
    const root = render(
      createElement(DashboardShell, { initialMe: INITIAL_ME }, "Dash"),
    );
    try {
      await act(flush);
      await waitFor(() =>
        expect(
          document.querySelector(
            'button[aria-label="Current workspace: Acme News"]',
          ),
        ).not.toBeNull(),
      );
      const trigger = document.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      ) as HTMLButtonElement;
      await act(async () => {
        trigger.click();
        await flush();
      });
      expect(document.querySelector('[role="status"]')?.textContent).toContain(
        "Loading workspaces",
      );
      expect(document.body.textContent).not.toContain(
        "This is your only workspace.",
      );

      await act(async () => {
        resolveWorkspaces([]);
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "This is your only workspace.",
        ),
      );
      expect(document.body.textContent).not.toContain("Loading workspaces");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps workspace errors actionable and retries in place", async () => {
    let resolveRetry!: (value: []) => void;
    mocks.listWorkspaces
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
      );
    const root = render(
      createElement(DashboardShell, { initialMe: INITIAL_ME }, "Dash"),
    );
    try {
      await waitFor(() =>
        expect(mocks.listWorkspaces).toHaveBeenCalledTimes(1),
      );
      const trigger = document.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      ) as HTMLButtonElement;
      await act(async () => {
        trigger.click();
        await flush();
      });
      await waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "could not be loaded",
        ),
      );
      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Retry",
      )!;
      await act(async () => {
        retry.click();
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toMatch(
          /Loading workspaces|Retrying…/,
        ),
      );
      expect(
        document.querySelector('nav[aria-label="Workspace actions"]'),
      ).not.toBeNull();

      await act(async () => {
        resolveRetry([]);
        await flush();
      });
      await waitFor(() =>
        expect(document.body.textContent).toContain(
          "This is your only workspace.",
        ),
      );
      expect(document.activeElement?.textContent).toContain(
        "Workspace settings",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("accepts a workspace switch only once per interaction turn", async () => {
    mocks.listWorkspaces.mockResolvedValue([
      {
        id: "tenant_other",
        name: "Other workspace",
        slug: "other",
        role: "owner",
        current: false,
      },
    ]);
    const root = render(
      createElement(DashboardShell, { initialMe: INITIAL_ME }, "Dash"),
    );

    try {
      await waitFor(() =>
        expect(mocks.listWorkspaces).toHaveBeenCalledTimes(1),
      );
      const trigger = document.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      ) as HTMLButtonElement;
      await act(async () => {
        trigger.click();
        await flush();
      });
      const target = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Other workspace"),
      );
      expect(target).toBeTruthy();

      await act(async () => {
        target?.click();
        target?.click();
        await flush();
      });

      // Identity cleanup includes an async legacy-cache purge before the
      // redirect. Assert the completed interaction instead of assuming one
      // event-loop turn is enough for that security boundary.
      await waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
      expect(mocks.push).toHaveBeenCalledWith(
        "/login?workspace=tenant_other&next=/app",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
