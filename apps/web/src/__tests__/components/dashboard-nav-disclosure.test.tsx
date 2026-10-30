// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_NAV_ITEMS,
  DashboardNav,
} from "@/app/(dashboard)/dashboard-nav-shell";
import type { RoleKey } from "@/lib/query-keys";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

interface MountedNav {
  container: HTMLElement;
  root: Root;
  navigate: (pathname: string) => Promise<void>;
}

async function mountNav(
  pathname = "/app",
  collapsed = false,
  badges?: Record<string, number>,
  canAccessRetention = true,
  role: RoleKey = "owner",
  viewerMode = false,
): Promise<MountedNav> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderPath = (nextPathname: string) =>
    root.render(
      <DashboardNav
        pathname={nextPathname}
        collapsed={collapsed}
        railId="test-rail"
        badges={badges}
        canAccessRetention={canAccessRetention}
        role={role}
        viewerMode={viewerMode}
      />,
    );
  await act(async () => {
    renderPath(pathname);
  });
  return {
    container,
    root,
    navigate: async (nextPathname: string) => {
      await act(async () => {
        renderPath(nextPathname);
      });
    },
  };
}

function buttonContaining(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button, `button containing ${label}`).toBeInstanceOf(
    HTMLButtonElement,
  );
  return button as HTMLButtonElement;
}

function visibleControls(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>("[data-dashboard-nav-control]"),
  ).filter((control) => control.closest("[hidden]") === null);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

async function press(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }),
    );
  });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("dashboard navigation disclosure", () => {
  it("omits the admin-only retention destination for a denied identity", async () => {
    const { container, root } = await mountNav("/app", false, undefined, false);
    try {
      expect(container.querySelector('a[href="/app/retention"]')).toBeNull();
      expect(container.querySelectorAll("a[href]")).toHaveLength(
        DASHBOARD_NAV_ITEMS.length - 1,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("omits every manifest-admin destination for viewers and viewer mode", async () => {
    for (const [role, viewerMode] of [
      ["viewer", false],
      ["owner", true],
    ] as const) {
      const { container, root } = await mountNav(
        "/app",
        false,
        undefined,
        false,
        role,
        viewerMode,
      );
      try {
        expect(container.querySelector('a[href="/app/commerce"]')).toBeNull();
        expect(container.querySelector('a[href="/app/billing"]')).toBeNull();
        expect(
          container.querySelector('a[href="/app/inbound-webhooks"]'),
        ).toBeNull();
        expect(
          container.querySelector('a[href="/app/campaigns"]'),
        ).toBeInstanceOf(HTMLAnchorElement);
        expect(container.querySelectorAll("a[href]")).toHaveLength(
          DASHBOARD_NAV_ITEMS.filter(
            (item) => item.scope === "member" && item.href !== "/app/retention",
          ).length,
        );
      } finally {
        act(() => root.unmount());
      }
    }
  });

  it("reduces the default scan while keeping every route uniquely reachable", async () => {
    const { container, root } = await mountNav();
    try {
      const anchors = Array.from(container.querySelectorAll("a[href]"));
      const hrefs = anchors.map((anchor) => anchor.getAttribute("href"));

      expect(anchors).toHaveLength(DASHBOARD_NAV_ITEMS.length);
      expect(new Set(hrefs).size).toBe(DASHBOARD_NAV_ITEMS.length);
      // Four group disclosures, the workspace collection disclosures, the
      // expanded Core workspace routes, and the pinned settings utility are
      // all real keyboard stops. Two newly wired workspace controls bring the
      // truthful default total to 16 while retaining the density budget below.
      expect(visibleControls(container)).toHaveLength(16);
      expect(visibleControls(container).length).toBeLessThan(
        DASHBOARD_NAV_ITEMS.length / 3,
      );
      expect(
        buttonContaining(container, "Workspace").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        buttonContaining(container, "Growth").getAttribute("aria-expanded"),
      ).toBe("false");
      expect(
        buttonContaining(container, "Core workspace").getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(
        1,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("forces a nested active route's hierarchy open without false-current siblings", async () => {
    const { container, root } = await mountNav("/app/custom-objects/object_1");
    try {
      expect(
        buttonContaining(container, "Workspace").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        buttonContaining(container, "Data & automation").getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
      expect(
        buttonContaining(container, "Core workspace").getAttribute(
          "aria-expanded",
        ),
      ).toBe("false");
      const current = container.querySelectorAll<HTMLAnchorElement>(
        '[aria-current="page"]',
      );
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute("href")).toBe("/app/custom-objects");

      // The current hierarchy cannot accidentally hide the current page.
      await click(buttonContaining(container, "Workspace"));
      await click(buttonContaining(container, "Data & automation"));
      expect(
        buttonContaining(container, "Workspace").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        buttonContaining(container, "Data & automation").getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens optional groups and collections with truthful disclosure state", async () => {
    const { container, root } = await mountNav();
    try {
      const growth = buttonContaining(container, "Growth");
      const panelId = growth.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      expect(panel).toBeInstanceOf(HTMLElement);
      expect(panel?.hidden).toBe(true);

      await click(growth);
      expect(growth.getAttribute("aria-expanded")).toBe("true");
      expect(panel?.hidden).toBe(false);

      const create = buttonContaining(container, "Create");
      await click(create);
      expect(create.getAttribute("aria-expanded")).toBe("true");
      const forms = container.querySelector<HTMLAnchorElement>(
        'a[href="/app/forms"]',
      );
      expect(forms?.closest("[hidden]")).toBeNull();

      await click(growth);
      expect(growth.getAttribute("aria-expanded")).toBe("false");
      expect(forms?.closest("[hidden]")).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("resets disclosure to the new active hierarchy after soft navigation", async () => {
    const { container, root, navigate } = await mountNav();
    try {
      await click(buttonContaining(container, "Growth"));
      await click(buttonContaining(container, "Create"));
      await navigate("/app/privacy-portal");

      expect(
        buttonContaining(container, "Account").getAttribute("aria-expanded"),
      ).toBe("true");
      expect(
        buttonContaining(container, "Governance & privacy").getAttribute(
          "aria-expanded",
        ),
      ).toBe("true");
      expect(
        buttonContaining(container, "Growth").getAttribute("aria-expanded"),
      ).toBe("false");
      const current = container.querySelector<HTMLAnchorElement>(
        'a[aria-current="page"]',
      );
      expect(current?.getAttribute("href")).toBe("/app/privacy-portal");
      expect(current?.closest("[hidden]")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("traverses only visible controls and supports disclosure arrow keys", async () => {
    const { container, root } = await mountNav();
    try {
      const workspace = buttonContaining(container, "Workspace");
      const growth = buttonContaining(container, "Growth");
      const settings = container.querySelector<HTMLAnchorElement>(
        'a[href="/app/settings"]',
      );
      expect(settings).toBeInstanceOf(HTMLAnchorElement);

      growth.focus();
      await press(growth, "ArrowRight");
      expect(growth.getAttribute("aria-expanded")).toBe("true");
      await press(growth, "ArrowDown");
      expect(document.activeElement).toBe(
        buttonContaining(container, "Create"),
      );

      growth.focus();
      await press(growth, "ArrowLeft");
      expect(growth.getAttribute("aria-expanded")).toBe("false");
      await press(growth, "Home");
      expect(document.activeElement).toBe(workspace);
      await press(workspace, "End");
      expect(document.activeElement).toBe(settings);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps palette-only routes unselected and mobile/coarse targets large", async () => {
    const { container, root } = await mountNav("/app/notifications");
    try {
      expect(container.querySelector('[aria-current="page"]')).toBeNull();
      for (const control of visibleControls(container)) {
        expect(control.className).toContain("min-h-11");
        expect(control.className).toContain(
          "[@media(pointer:coarse)]:min-h-11",
        );
      }
      const settings = container.querySelector<HTMLAnchorElement>(
        'a[data-tour="dashboard-nav-settings"]',
      );
      expect(settings?.closest("[hidden]")).toBeNull();
      for (const tourTarget of [
        "dashboard-nav-campaigns",
        "dashboard-nav-subscribers",
        "dashboard-nav-sequences",
        "dashboard-nav-settings",
      ]) {
        const target = container.querySelector(`[data-tour="${tourTarget}"]`);
        expect(target?.closest("[hidden]"), tourTarget).toBeNull();
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the collapsed desktop rail disclosed and fully named", async () => {
    const { container, root } = await mountNav(
      "/app/custom-objects/object_1",
      true,
    );
    try {
      const groupButtons = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button[data-dashboard-nav-group]",
        ),
      );
      expect(groupButtons).toHaveLength(4);
      expect(
        groupButtons.every((button) =>
          button.getAttribute("aria-label")?.includes("destinations"),
        ),
      ).toBe(true);
      const current = container.querySelector<HTMLAnchorElement>(
        'a[aria-current="page"]',
      );
      expect(current?.getAttribute("aria-label")).toBe("Custom objects");
      expect(current?.closest("[hidden]")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("rolls hidden actionable badges up to their closed group and collection", async () => {
    const { container, root } = await mountNav("/app", false, {
      "/app/approvals": 3,
    });
    try {
      expect(
        container.querySelector('[aria-label="3 pending in Account"]'),
      ).toBeInstanceOf(HTMLElement);
      await click(buttonContaining(container, "Account"));
      expect(
        container.querySelector(
          '[aria-label="3 pending in Workspace management"]',
        ),
      ).toBeInstanceOf(HTMLElement);
      expect(
        container
          .querySelector('a[href="/app/approvals"]')
          ?.closest("[hidden]"),
      ).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
