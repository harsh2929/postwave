// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Keyboard affordances of the dashboard shell — the one chrome every
// authenticated route renders inside, so a regression here is a regression on
// every page at once. Nothing referenced these three behaviours before this
// file, which meant they could be deleted in a refactor and no gate would move.
//
// Why each assertion exists:
//
//   1. Skip link is the FIRST tabbable node and targets the main region.
//      WCAG 2.4.1 (Bypass Blocks): a keyboard user landing on a dashboard route
//      would otherwise tab through the whole sidebar rail on every navigation.
//      "First" is the load-bearing half — a skip link that sits behind the
//      sidebar links is decorative. It is asserted through the app's own
//      focusableElements() (src/lib/focus-trap.ts), the same tabbability rule
//      the shell's drawer trap uses, rather than a hand-rolled selector that
//      could disagree with the runtime.
//
//   2. <main> is programmatically focusable but NOT tabbable (tabIndex -1).
//      This is the pairing that makes both the skip link and the route-change
//      focus move land somewhere. Flipping it to 0 would silently insert the
//      page container into the tab sequence; removing it entirely would make
//      main.focus() a no-op and break (1) and (3) without touching their code.
//
//   3. On a client-side route change focus MOVES to <main> (SHELL-026).
//      Next.js does not reset focus on soft navigation, so without this effect
//      a keyboard/AT user stays parked on the nav link they just activated and
//      the new page is never announced. The first-mount skip is asserted too:
//      stealing focus on initial paint is its own bug.
//
//   4. A route that has already placed focus INSIDE main keeps it. The effect
//      deliberately yields to a more specific target (a detail heading, the
//      originating card); a naive "always focus main" would regress that, and
//      only an assertion distinguishes the two implementations.
//
// The render harness (happy-dom + createRoot + act) is the repo template from
// analytics-page-query.test.tsx; the shell-specific module stubs mirror
// dashboard-header-menus-a11y.test.tsx, the neighbouring test that already
// mounts this component.
import { act, createElement, useEffect } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardShell } from "@/app/(dashboard)/dashboard-shell";
import { focusableElements } from "@/lib/focus-trap";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

// The workspace switcher (SHELL-018) reads its list via useQuery, so the
// stubbed QueryProvider below wraps children in a real client.
const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});

const mocks = vi.hoisted(() => ({
  // Mutable so a test can drive a client-side navigation: the shell reads the
  // path through usePathname(), so changing this and re-rendering is exactly
  // what a soft navigation looks like from the component's side.
  pathname: "/app",
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  setTheme: vi.fn(),
  whoami: vi.fn(async () => IDENTITY),
  logout: vi.fn(async () => undefined),
  listWorkspaces: vi.fn(async () => []),
  listApprovals: vi.fn(async () => []),
  themeProviderProps: [] as Array<Record<string, unknown>>,
}));

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
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
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
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));

// Sidebar count badges poll this (SHELL-023). Resolve it so the test triggers
// no real fetch, which would abort at teardown and spew noise.
vi.mock("@/lib/approvals-api", () => ({
  listApprovals: mocks.listApprovals,
}));

vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => {
    mocks.themeProviderProps.push(props);
    return createElement("div", null, children);
  },
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

afterEach(() => {
  vi.clearAllMocks();
  mocks.pathname = "/app";
  mocks.themeProviderProps.length = 0;
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

interface Mounted {
  root: Root;
  container: HTMLElement;
  /** Point usePathname() at `to` and re-render — i.e. a soft navigation. */
  navigate: (to: string) => Promise<void>;
}

async function mountShell(children?: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // A fresh element per render: re-rendering the identical element object makes
  // React bail out of the subtree, so the shell would never re-read
  // usePathname() and the navigation under test would not happen at all.
  const element = (): ReactNode =>
    createElement(DashboardShell, { initialMe: INITIAL_ME }, children);
  await act(async () => {
    root.render(element());
    await flush();
  });
  // The header controls are React.lazy() imports. Under a parallel focused
  // run their transform can outlive a handful of zero-delay timers, so wait
  // for the import itself before polling the committed control.
  await vi.dynamicImportSettled();
  await act(flush);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (
      container.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      )
    ) {
      break;
    }
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  }
  return {
    root,
    container,
    navigate: async (to: string) => {
      mocks.pathname = to;
      await act(async () => {
        root.render(element());
        await flush();
      });
    },
  };
}

function mainRegion(container: HTMLElement): HTMLElement {
  const main = container.querySelector("main#main-content");
  expect(main).toBeInstanceOf(HTMLElement);
  return main as HTMLElement;
}

describe("dashboard shell keyboard affordances", () => {
  it("owns viewport scrolling and gives the mobile header explicit priorities", async () => {
    const { root, container } = await mountShell();

    try {
      const shell = container.querySelector(".h-dvh");
      const header = container.querySelector('header[role="banner"]');
      const main = mainRegion(container);
      const actions = container.querySelector(
        '[data-slot="dashboard-header-actions"]',
      );
      const workspace = container.querySelector(
        'button[aria-label="Current workspace: Acme News"]',
      );
      const workspaceName = Array.from(
        workspace?.querySelectorAll("span") ?? [],
      ).find((span) => span.textContent === "Acme News");
      const theme = container.querySelector('button[title^="Theme:"]');

      expect(shell?.classList.contains("min-h-0")).toBe(true);
      expect(shell?.classList.contains("overflow-hidden")).toBe(true);
      expect(header?.classList.contains("shrink-0")).toBe(true);
      expect(actions?.classList.contains("shrink-0")).toBe(true);
      expect(main.classList.contains("min-h-0")).toBe(true);
      expect(main.classList.contains("overflow-auto")).toBe(true);
      expect(main.classList.contains("overscroll-contain")).toBe(true);

      // Workspace identity collapses to its avatar while the mobile nav is
      // present; the full label returns once the desktop rail takes over.
      expect(workspace?.classList.contains("w-11")).toBe(true);
      expect(workspace?.classList.contains("shrink-0")).toBe(true);
      expect(workspaceName?.classList.contains("hidden")).toBe(true);
      expect(workspaceName?.classList.contains("md:inline")).toBe(true);

      // Theme remains in Account at all widths, so this duplicate shortcut is
      // intentionally lower-priority than search/create/alerts/account.
      expect(theme?.parentElement?.classList.contains("hidden")).toBe(true);
      expect(theme?.parentElement?.classList.contains("md:block")).toBe(true);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("puts a skip link first in the tab order, pointing at the main region", async () => {
    const { root, container } = await mountShell();

    try {
      const tabbable = focusableElements(container);
      expect(tabbable.length).toBeGreaterThan(1);

      const skip = tabbable[0]!;
      expect(skip.tagName).toBe("A");
      expect(skip.getAttribute("href")).toBe("#main-content");
      expect(skip.textContent?.trim()).toBe("Skip to main content");

      // The target must be the real main region, not a dangling fragment.
      expect(document.getElementById("main-content")).toBe(
        mainRegion(container),
      );

      // It is a genuine keyboard-only affordance: hidden until focused.
      expect(skip.className).toContain("sr-only");
      expect(skip.className).toContain("focus:not-sr-only");

      skip.focus();
      expect(document.activeElement).toBe(skip);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("makes the main region programmatically focusable but not tabbable", async () => {
    const { root, container } = await mountShell();

    try {
      const main = mainRegion(container);
      expect(main.tabIndex).toBe(-1);
      expect(main.getAttribute("tabindex")).toBe("-1");

      // tabIndex -1 keeps it out of the Tab sequence...
      expect(focusableElements(container)).not.toContain(main);

      // ...while still accepting focus() from the skip link and SHELL-026.
      main.focus();
      expect(document.activeElement).toBe(main);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("moves focus to main on a route change, but not on first mount", async () => {
    const { root, container, navigate } = await mountShell();

    try {
      const main = mainRegion(container);

      // First paint must not steal focus from wherever the user was.
      expect(document.activeElement).not.toBe(main);

      // Park focus on the skip link (outside main), the way a keyboard user
      // sits on a nav control before activating it.
      const skip = focusableElements(container)[0]!;
      skip.focus();
      expect(document.activeElement).toBe(skip);

      await navigate("/app/campaigns");

      expect(document.activeElement).toBe(mainRegion(container));
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("leaves focus alone when the route already placed it inside main", async () => {
    const { root, container, navigate } = await mountShell(
      createElement(
        "button",
        { type: "button", "data-testid": "page-target" },
        "Page heading action",
      ),
    );

    try {
      const target = container.querySelector(
        '[data-testid="page-target"]',
      ) as HTMLButtonElement | null;
      expect(target).toBeTruthy();
      expect(mainRegion(container).contains(target)).toBe(true);

      target!.focus();
      await navigate("/app/campaigns");

      // The deliberate in-page handoff survives the navigation.
      expect(document.activeElement).toBe(target);
      expect(document.activeElement).not.toBe(mainRegion(container));
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("traps the mobile navigation, closes on Escape, and restores its opener", async () => {
    const { root, container } = await mountShell();

    try {
      const opener = container.querySelector(
        'button[aria-label="Open navigation"]',
      ) as HTMLButtonElement;
      opener.focus();
      await act(async () => {
        opener.click();
        await flush();
      });

      const drawer = container.querySelector(
        '[role="dialog"][aria-label="Dashboard mobile navigation"]',
      );
      const close = container.querySelector(
        'button[aria-label="Close navigation"]',
      );
      const home = drawer?.querySelector('a[href="/app"]');
      expect(drawer).not.toBeNull();
      expect(close).toBe(document.activeElement);
      expect(home?.classList.contains("min-h-11")).toBe(true);
      expect(document.body.style.overflow).toBe("hidden");
      expect(
        container.querySelectorAll('button[aria-label="Close navigation"]'),
      ).toHaveLength(1);

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
        await flush();
      });

      expect(
        container.querySelector(
          '[role="dialog"][aria-label="Dashboard mobile navigation"]',
        ),
      ).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(document.body.style.overflow).toBe("");
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("dashboard shell under the strict CSP", () => {
  it("hands the request's script nonce to the theme provider", async () => {
    // next-themes renders an inline pre-paint script; the dashboard's
    // nonce + 'strict-dynamic' policy runs it only if it carries the nonce.
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          createElement(DashboardShell, {
            initialMe: INITIAL_ME,
            nonce: "0b9e4c1a-7f32-4d5e-8a6b-3c2d1e0f9a87",
          }),
        );
        await flush();
      });
      expect(mocks.themeProviderProps.length).toBeGreaterThan(0);
      for (const props of mocks.themeProviderProps) {
        expect(props.nonce).toBe("0b9e4c1a-7f32-4d5e-8a6b-3c2d1e0f9a87");
      }
    } finally {
      act(() => root.unmount());
    }
  });
});
