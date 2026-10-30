// @vitest-environment happy-dom

import {
  act,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Section } from "../../lib/store";
import type { DesktopRouteSnapshot } from "../../lib/desktop-router";

const state = vi.hoisted(() => ({
  routeSnapshot: {
    route: { section: "dashboard" },
    canonicalUrl: "/app/dashboard",
    revision: 0,
    source: "navigation",
    restoreScrollTop: null,
  } as DesktopRouteSnapshot,
  section: "dashboard" as Section,
  tenant: "Acme Workspace",
}));

vi.mock("../../lib/desktop-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/desktop-router")>();
  return {
    ...actual,
    useDesktopRouteSnapshot: () => state.routeSnapshot,
  };
});

vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return {
    ...actual,
    useSection: () => state.section,
    useMe: () => ({
      tenant: state.tenant,
      user: "owner@example.test",
      role: "admin",
      effectiveRole: "admin",
    }),
  };
});

vi.mock("../../components/Sidebar", () => ({
  Sidebar: () => <nav aria-label="Primary" />,
}));
vi.mock("../../components/TopBar", () => ({
  TopBar: ({ trailingAccessory }: { trailingAccessory?: ReactNode }) => (
    <header>{trailingAccessory}</header>
  ),
}));
vi.mock("../../components/StatusBar", () => ({ StatusBar: () => <footer /> }));
vi.mock("../../components/OfflineBanner", () => ({
  OfflineBanner: () => null,
}));
vi.mock("../../components/CommandPalette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../../components/DesktopDestinationGate", () => ({
  DesktopDestinationGate: ({ children }: { children: ReactElement }) =>
    children,
}));

import { AppShell } from "../../components/AppShell";

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
  document.title = "";
  state.section = "dashboard";
  state.routeSnapshot = {
    route: { section: "dashboard" },
    canonicalUrl: "/app/dashboard",
    revision: 0,
    source: "navigation",
    restoreScrollTop: null,
  };
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AppShell navigation accessibility", () => {
  it("routes the optional help accessory through the shell topbar", async () => {
    render(
      <AppShell topbarAccessory={<button aria-label="Open help">?</button>}>
        <h1>Dashboard</h1>
      </AppShell>,
    );
    await flush();

    const help = document.querySelector<HTMLButtonElement>(
      'header button[aria-label="Open help"]',
    );
    expect(help).not.toBeNull();
    expect(help?.closest("main")).toBeNull();
  });

  it("provides skip/main landmarks and updates title, focus, and announcement", async () => {
    const view = render(
      <AppShell>
        <h1>Dashboard</h1>
      </AppShell>,
    );
    await flush();

    const main = document.querySelector<HTMLElement>("main#main-content");
    expect(document.querySelector<HTMLAnchorElement>(".skip-link")?.hash).toBe(
      "#main-content",
    );
    expect(main?.getAttribute("aria-label")).toBe("Dashboard content");
    expect(main?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(main);
    expect(document.title).toBe("Acme Workspace — Dashboard — Moosewave");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Navigated to Dashboard",
    );

    state.section = "campaigns";
    state.routeSnapshot = {
      route: { section: "campaigns" },
      canonicalUrl: "/app/campaigns",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <h1>Campaigns</h1>
      </AppShell>,
    );
    await flush();
    expect(main?.getAttribute("aria-label")).toBe("Campaigns content");
    expect(document.title).toBe("Acme Workspace — Campaigns — Moosewave");
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Navigated to Campaigns",
    );
    expect(document.activeElement).toBe(main);
  });

  it("does not overwrite the mounted Settings anchor's authoritative scroll", async () => {
    const view = render(
      <AppShell>
        <AnchorScrollOwner anchor={null} />
      </AppShell>,
    );
    await flush();
    const main = document.querySelector<HTMLElement>("main#main-content");
    if (!main) throw new Error("Missing main content");
    main.scrollTop = 73;

    state.section = "settings";
    state.routeSnapshot = {
      route: { section: "settings", settingsAnchor: "api-keys" },
      canonicalUrl: "/app/settings?anchor=api-keys",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <AnchorScrollOwner anchor="api-keys" />
      </AppShell>,
    );
    await flush();

    expect(main.scrollTop).toBe(420);
    expect(document.activeElement).not.toBe(main);
    expect(document.title).toBe(
      "Acme Workspace — Settings — API keys — Moosewave",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Navigated to Settings, API keys",
    );
  });

  it("preserves directory scroll and origin focus across subscriber drawer open and close", async () => {
    state.section = "subscribers";
    state.routeSnapshot = {
      route: { section: "subscribers" },
      canonicalUrl: "/app/subscribers",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const view = render(
      <AppShell>
        <button type="button">Open Alice</button>
      </AppShell>,
    );
    await flush();
    const main = document.querySelector<HTMLElement>("main#main-content");
    const origin = document.querySelector<HTMLButtonElement>("button");
    if (!main || !origin) throw new Error("Missing subscriber route fixtures");
    main.scrollTop = 384;
    origin.focus();

    state.routeSnapshot = {
      route: {
        section: "subscribers",
        overlay: {
          name: "subscriber-detail",
          resourceId: "subscriber-42",
        },
      },
      canonicalUrl:
        "/app/subscribers?overlay=subscriber-detail&overlayId=subscriber-42",
      revision: 2,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <button type="button">Open Alice</button>
      </AppShell>,
    );
    await flush();

    expect(main.scrollTop).toBe(384);
    expect(document.activeElement).toBe(origin);
    expect(document.title).toBe(
      "Acme Workspace — Subscribers — Subscriber details — Moosewave",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "Navigated to Subscribers, Subscriber details",
    );
    expect(document.title).not.toContain("subscriber-42");

    state.routeSnapshot = {
      route: { section: "subscribers" },
      canonicalUrl: "/app/subscribers",
      revision: 3,
      source: "history",
      restoreScrollTop: 0,
    };
    view.rerender(
      <AppShell>
        <button type="button">Open Alice</button>
      </AppShell>,
    );
    await flush();

    expect(main.scrollTop).toBe(384);
    expect(document.activeElement).toBe(origin);
  });

  it("restores the captured tab-origin scroll after a direct route commit anchors elsewhere", async () => {
    state.section = "retentionOffers";
    state.routeSnapshot = {
      route: { section: "retentionOffers" },
      canonicalUrl: "/app/retention-offers",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const view = render(
      <AppShell>
        <RoutedTabAnchorFixture label="Overview" anchoredScrollTop={null} />
      </AppShell>,
    );
    await flush();

    const main = document.querySelector<HTMLElement>("main#main-content");
    const tab = document.querySelector<HTMLButtonElement>('[role="tab"]');
    if (!main || !tab) throw new Error("Missing routed tab fixtures");
    main.scrollTop = 4;
    tab.focus();
    // Chromium can scroll the newly focused tab before Enter activates it.
    // The activation capture must supersede the earlier focus coordinate.
    main.scrollTop = 9;
    act(() => {
      tab.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });

    state.routeSnapshot = {
      route: { section: "retentionOffers", tab: "history" },
      canonicalUrl: "/app/retention-offers?tab=history",
      revision: 2,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <RoutedTabAnchorFixture label="Offer history" anchoredScrollTop={175} />
      </AppShell>,
    );
    await flush();

    expect(main.scrollTop).toBe(9);
    expect(document.activeElement).toBe(tab);
    expect(
      document.querySelector("[data-app-route-announcement]")?.textContent,
    ).toBe("Navigated to Retention history, Offer history");
    expect(document.title).toBe(
      "Acme Workspace — Retention history — Offer history — Moosewave",
    );
  });

  it("uses canonical human labels for every Retention tab announcement", async () => {
    state.section = "retentionOffers";
    state.routeSnapshot = {
      route: { section: "retentionOffers" },
      canonicalUrl: "/app/retention-offers",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const view = render(
      <AppShell>
        <h1>Overview</h1>
      </AppShell>,
    );
    await flush();

    const announcers = document.querySelectorAll(
      "[data-app-route-announcement]",
    );
    expect(announcers).toHaveLength(1);
    expect(announcers[0]?.getAttribute("aria-live")).toBe("polite");
    expect(announcers[0]?.textContent).toBe(
      "Navigated to Retention history, Overview",
    );

    const transitions = [
      {
        route: { section: "retentionOffers", tab: "history" } as const,
        canonicalUrl: "/app/retention-offers?tab=history",
        label: "Offer history",
      },
      {
        route: { section: "retentionOffers", tab: "readiness" } as const,
        canonicalUrl: "/app/retention-offers?tab=readiness",
        label: "Readiness",
      },
      {
        route: { section: "retentionOffers" } as const,
        canonicalUrl: "/app/retention-offers",
        label: "Overview",
      },
      {
        route: {
          section: "retentionOffers",
          tab: "untrusted-route-token",
        } as const,
        canonicalUrl: "/app/retention-offers?tab=untrusted-route-token",
        label: "Overview",
      },
    ];

    for (const [index, transition] of transitions.entries()) {
      state.routeSnapshot = {
        route: transition.route,
        canonicalUrl: transition.canonicalUrl,
        revision: index + 2,
        source: "navigation",
        restoreScrollTop: null,
      };
      view.rerender(
        <AppShell>
          <h1>{transition.label}</h1>
        </AppShell>,
      );
      await flush();

      expect(announcers[0]?.textContent).toBe(
        `Navigated to Retention history, ${transition.label}`,
      );
      expect(document.title).toBe(
        `Acme Workspace — Retention history — ${transition.label} — Moosewave`,
      );
    }

    expect(announcers[0]?.textContent).not.toMatch(/, (?:history|readiness)$/u);
    expect(document.title).not.toContain("untrusted-route-token");
  });

  it("resets scroll and moves focus to main when a direct tab transition replaces the focused tab", async () => {
    state.section = "retentionOffers";
    state.routeSnapshot = {
      route: { section: "retentionOffers" },
      canonicalUrl: "/app/retention-offers",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const view = render(
      <AppShell>
        <button type="button" role="tab" key="overview-tab">
          Overview
        </button>
      </AppShell>,
    );
    await flush();

    const main = document.querySelector<HTMLElement>("main#main-content");
    const originTab = document.querySelector<HTMLButtonElement>('[role="tab"]');
    if (!main || !originTab) throw new Error("Missing routed tab fixtures");
    main.scrollTop = 384;
    originTab.focus();

    state.routeSnapshot = {
      route: { section: "retentionOffers", tab: "history" },
      canonicalUrl: "/app/retention-offers?tab=history",
      revision: 2,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <button type="button" role="tab" key="history-tab">
          Offer history
        </button>
      </AppShell>,
    );
    await flush();

    expect(originTab.isConnected).toBe(false);
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(main);
  });

  it("does not treat a connected tab outside main as an in-place tab origin", async () => {
    state.section = "retentionOffers";
    state.routeSnapshot = {
      route: { section: "retentionOffers" },
      canonicalUrl: "/app/retention-offers",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const accessory = (
      <button type="button" role="tab">
        External tab
      </button>
    );
    const view = render(
      <AppShell topbarAccessory={accessory}>
        <h1>Overview</h1>
      </AppShell>,
    );
    await flush();

    const main = document.querySelector<HTMLElement>("main#main-content");
    const externalTab = document.querySelector<HTMLButtonElement>(
      'header [role="tab"]',
    );
    if (!main || !externalTab) throw new Error("Missing external tab fixtures");
    main.scrollTop = 384;
    externalTab.focus();

    state.routeSnapshot = {
      route: { section: "retentionOffers", tab: "history" },
      canonicalUrl: "/app/retention-offers?tab=history",
      revision: 2,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell topbarAccessory={accessory}>
        <h1>History</h1>
      </AppShell>,
    );
    await flush();

    expect(externalTab.isConnected).toBe(true);
    expect(main.scrollTop).toBe(0);
    expect(document.activeElement).toBe(main);
  });

  it.each(["history", "restore"] as const)(
    "honors saved scroll and main-focus fallback for a %s tab transition",
    async (source) => {
      state.section = "retentionOffers";
      state.routeSnapshot = {
        route: { section: "retentionOffers", tab: "history" },
        canonicalUrl: "/app/retention-offers?tab=history",
        revision: 1,
        source: "navigation",
        restoreScrollTop: null,
      };
      const view = render(
        <AppShell>
          <button type="button" role="tab">
            Offer history
          </button>
        </AppShell>,
      );
      await flush();

      const main = document.querySelector<HTMLElement>("main#main-content");
      const tab = document.querySelector<HTMLButtonElement>('[role="tab"]');
      if (!main || !tab) throw new Error("Missing history tab fixtures");
      main.scrollTop = 384;
      tab.focus();

      state.routeSnapshot = {
        route: { section: "retentionOffers" },
        canonicalUrl: "/app/retention-offers",
        revision: 2,
        source,
        restoreScrollTop: 72,
      };
      view.rerender(
        <AppShell>
          <button type="button" role="tab">
            Overview
          </button>
        </AppShell>,
      );
      await flush();

      expect(tab.isConnected).toBe(true);
      expect(main.scrollTop).toBe(72);
      expect(document.activeElement).toBe(main);
    },
  );

  it("repairs body focus without resetting scroll on a programmatic same-tab update", async () => {
    state.section = "retentionOffers";
    state.routeSnapshot = {
      route: { section: "retentionOffers", tab: "history" },
      canonicalUrl: "/app/retention-offers?tab=history",
      revision: 1,
      source: "navigation",
      restoreScrollTop: null,
    };
    const view = render(
      <AppShell>
        <h1>Offer history</h1>
      </AppShell>,
    );
    await flush();

    const main = document.querySelector<HTMLElement>("main#main-content");
    if (!main) throw new Error("Missing main content");
    main.scrollTop = 321;
    main.blur();
    expect(document.activeElement).toBe(document.body);

    state.routeSnapshot = {
      route: {
        section: "retentionOffers",
        tab: "history",
        query: "active",
      },
      canonicalUrl: "/app/retention-offers?tab=history&q=active",
      revision: 2,
      source: "navigation",
      restoreScrollTop: null,
    };
    view.rerender(
      <AppShell>
        <h1>Offer history</h1>
      </AppShell>,
    );
    await flush();

    expect(main.scrollTop).toBe(321);
    expect(document.activeElement).toBe(main);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("");
  });
});

function AnchorScrollOwner({
  anchor,
}: {
  anchor: string | null;
}): ReactElement {
  useEffect(() => {
    if (anchor) {
      const main = document.querySelector<HTMLElement>("main#main-content");
      if (main) main.scrollTop = 420;
      document.querySelector<HTMLElement>("[data-anchor-owner]")?.focus();
    }
  }, [anchor]);
  return (
    <h1 data-anchor-owner tabIndex={-1}>
      {anchor ?? "Dashboard"}
    </h1>
  );
}

function RoutedTabAnchorFixture({
  label,
  anchoredScrollTop,
}: {
  label: string;
  anchoredScrollTop: number | null;
}): ReactElement {
  useLayoutEffect(() => {
    if (anchoredScrollTop === null) return;
    const main = document.querySelector<HTMLElement>("main#main-content");
    if (main) main.scrollTop = anchoredScrollTop;
  }, [anchoredScrollTop]);
  return (
    <button type="button" role="tab">
      {label}
    </button>
  );
}
