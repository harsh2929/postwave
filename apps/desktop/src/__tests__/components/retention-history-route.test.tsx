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

import type {
  DesktopNavigateOptions,
  DesktopRoute,
  DesktopRouteSnapshot,
} from "../../lib/desktop-router";
import type { RetentionOfferHistoryRow } from "../../lib/retention-offers-contract";

const mocks = vi.hoisted(() => {
  const snapshot: DesktopRouteSnapshot = {
    route: { section: "retentionOffers" },
    canonicalUrl: "/app/retention-offers",
    revision: 0,
    source: "restore",
    restoreScrollTop: null,
  };
  return {
    applyRoute: vi.fn(),
    detailProps: vi.fn(),
    funnel: vi.fn(),
    me: {
      user: "admin@example.test",
      tenant: "10000000-0000-4000-8000-000000000001",
      role: "admin",
      effectiveRole: "admin",
    } as {
      user: string;
      tenant: string;
      role: string;
      effectiveRole: string;
    } | null,
    navigate: vi.fn(),
    offers: vi.fn(),
    requestBack: vi.fn(),
    requestNavigate: vi.fn(),
    routeListeners: new Set<() => void>(),
    settings: vi.fn(),
    snapshot,
    tiers: vi.fn(),
  };
});

vi.mock("../../lib/api/retention-history", () => ({
  loadRetentionFunnel: mocks.funnel,
  loadRetentionOffers: mocks.offers,
  loadRetentionTiers: mocks.tiers,
  loadRetentionWinbackSettings: mocks.settings,
}));

vi.mock("../../lib/store", () => ({
  useMe: () => mocks.me,
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  const actual = await vi.importActual<
    typeof import("../../lib/desktop-router")
  >("../../lib/desktop-router");
  const applyRoute = (
    route: DesktopRoute,
    options: DesktopNavigateOptions = {},
  ): void => {
    const canonicalUrl = actual.serializeDesktopRoute(route);
    mocks.snapshot = {
      route,
      canonicalUrl,
      revision: mocks.snapshot.revision + 1,
      source: options.source ?? "navigation",
      restoreScrollTop: null,
    };
    for (const listener of mocks.routeListeners) listener();
  };
  mocks.applyRoute.mockImplementation(applyRoute);
  mocks.navigate.mockImplementation(applyRoute);
  mocks.requestNavigate.mockImplementation(
    async (route: DesktopRoute, options?: DesktopNavigateOptions) => {
      applyRoute(route, options);
      return "proceeded";
    },
  );
  mocks.requestBack.mockImplementation(async (route: DesktopRoute) => {
    applyRoute(route, { source: "history" });
    return "proceeded";
  });
  return {
    ...actual,
    getDesktopRoute: () => mocks.snapshot.route,
    navigateDesktopRoute: mocks.navigate,
    requestDesktopRouteBackNavigation: mocks.requestBack,
    requestDesktopRouteNavigation: mocks.requestNavigate,
    useDesktopRouteSnapshot: () =>
      React.useSyncExternalStore(
        (listener) => {
          mocks.routeListeners.add(listener);
          return () => mocks.routeListeners.delete(listener);
        },
        () => mocks.snapshot,
        () => mocks.snapshot,
      ),
  };
});

vi.mock("../../components/Icon", () => ({
  Icon: ({ name }: { name: string }) => (
    <span aria-hidden="true" data-test-icon={name} />
  ),
}));

vi.mock("../../components/retention/RetentionOfferDetail", () => ({
  RetentionOfferDetail: (props: {
    row: RetentionOfferHistoryRow | null;
    open: boolean;
    reconciliationPending?: boolean;
    onClose: () => void;
  }) => {
    mocks.detailProps(props);
    return props.open && props.row ? (
      <div role="dialog" aria-label="Offer detail test boundary">
        {props.row.offer.headline}
        <button type="button" onClick={props.onClose}>
          Close detail
        </button>
      </div>
    ) : null;
  },
}));

import { RetentionHistoryWorkspace } from "../../components/retention/RetentionHistoryWorkspace";

const OFFER_1 = "20000000-0000-4000-8000-000000000001";
const OFFER_2 = "20000000-0000-4000-8000-000000000002";
const TIER_1 = "30000000-0000-4000-8000-000000000001";
const TIER_2 = "30000000-0000-4000-8000-000000000002";

const OFFER_ITEMS = [
  {
    id: OFFER_1,
    tierId: TIER_1,
    discount: { kind: "percent" as const, percent: 20 },
    durationMonths: 2,
    headline: "Keep the founder rate",
    body: "Stay for the next chapter.",
    providerCouponPresent: true,
    active: true,
    createdAt: "2026-07-12T09:00:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z",
  },
  {
    id: OFFER_2,
    tierId: TIER_2,
    discount: { kind: "fixed" as const, minorUnits: 1250, currency: null },
    durationMonths: 1,
    headline: "Annual member save",
    body: "A fixed historical term.",
    providerCouponPresent: false,
    active: false,
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
  },
];

const FUNNEL_ITEMS = [
  {
    offerId: OFFER_1,
    tierId: TIER_1,
    shown: 20,
    accepted: 5,
    declined: 10,
    expired: 2,
  },
  {
    offerId: OFFER_2,
    tierId: TIER_2,
    shown: 4,
    accepted: 1,
    declined: 2,
    expired: 0,
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function setDesktopRoute(route: DesktopRoute): void {
  mocks.applyRoute(route, { source: "restore" });
  mocks.applyRoute.mockClear();
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.offers.mockReset();
  mocks.funnel.mockReset();
  mocks.tiers.mockReset();
  mocks.settings.mockReset();
  mocks.routeListeners.clear();
  mocks.me = {
    user: "admin@example.test",
    tenant: "10000000-0000-4000-8000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  };
  setDesktopRoute({ section: "retentionOffers" });
  mocks.offers.mockResolvedValue({
    data: { items: OFFER_ITEMS, reportedCount: 2 },
  });
  mocks.funnel.mockResolvedValue({
    data: { items: FUNNEL_ITEMS, reportedCount: 2 },
  });
  mocks.tiers.mockResolvedValue({
    data: {
      items: [
        { id: TIER_1, name: "Founders", active: true },
        { id: TIER_2, name: "Annual", active: false },
      ],
    },
  });
  mocks.settings.mockResolvedValue({
    data: {
      enabled: true,
      churnThreshold: 0.7,
      churnProfilesScored: 38,
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement = <RetentionHistoryWorkspace />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function normalizedText(node: Element | null): string {
  return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function routeAnnouncementText(): string {
  return normalizedText(
    document.querySelector("[data-retention-route-announcement]"),
  );
}

function tabNamed(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find(
    (candidate) => candidate.querySelector("strong")?.textContent === label,
  );
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function buttonNamed(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => normalizedText(candidate) === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function selectNamed(label: string): HTMLSelectElement {
  const match = Array.from(document.querySelectorAll<HTMLLabelElement>("label"))
    .find(
      (candidate) =>
        normalizedText(candidate.querySelector(":scope > span")) === label,
    )
    ?.querySelector<HTMLSelectElement>("select");
  if (!match) throw new Error(`Missing select: ${label}`);
  return match;
}

function expectEveryTabToOwnAPanel(): void {
  for (const tab of document.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const panelId = tab.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId ?? "")?.getAttribute("role")).toBe(
      "tabpanel",
    );
  }
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Retention history route orchestration", () => {
  it("waits for a resolved workspace identity before issuing any read", async () => {
    mocks.me = null;
    render();
    await flush();

    expect(mocks.offers).not.toHaveBeenCalled();
    expect(mocks.funnel).not.toHaveBeenCalled();
    expect(mocks.tiers).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Loading retention history");
  });

  it("synchronously masks the previous workspace while a new tenant snapshot loads", async () => {
    const nextTenant = "10000000-0000-4000-8000-000000000002";
    const nextOfferRead = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();
    expect(document.body.textContent).toContain("Keep the founder rate");

    mocks.offers.mockReturnValueOnce(nextOfferRead.promise);
    mocks.me = {
      user: "next-admin@example.test",
      tenant: nextTenant,
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<RetentionHistoryWorkspace />));

    expect(document.body.textContent).not.toContain("Keep the founder rate");
    expect(document.body.textContent).toContain("Loading retention history");
    await flush();
    expect(mocks.offers).toHaveBeenLastCalledWith(nextTenant);

    nextOfferRead.resolve({
      data: {
        items: [
          {
            ...OFFER_ITEMS[0],
            id: "20000000-0000-4000-8000-000000000099",
            headline: "Next workspace offer",
          },
        ] as typeof OFFER_ITEMS,
        reportedCount: 1,
      },
    });
    await flush();

    expect(document.body.textContent).toContain("Next workspace offer");
    expect(document.body.textContent).not.toContain("Keep the founder rate");
  });

  it("does not resurrect an earlier critical snapshot across an A to B to A identity cycle", async () => {
    const originalTenant = mocks.me?.tenant;
    const nextTenant = "10000000-0000-4000-8000-000000000002";
    if (!originalTenant) throw new Error("Missing original tenant");
    const priorAItems = [
      {
        ...OFFER_ITEMS[0],
        headline: "Prior A paired snapshot",
      },
    ] as typeof OFFER_ITEMS;
    const freshAItems = [
      {
        ...OFFER_ITEMS[0],
        headline: "Fresh A after identity cycle",
      },
    ] as typeof OFFER_ITEMS;
    const bOfferRead = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    const bFunnelRead = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();
    const freshAOfferRead = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    const freshAFunnelRead = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();

    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    mocks.offers.mockResolvedValueOnce({
      data: { items: priorAItems, reportedCount: priorAItems.length },
    });
    mocks.funnel.mockResolvedValueOnce({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });
    act(() => buttonNamed("Refresh records").click());
    await flush();
    expect(document.body.textContent).toContain("Prior A paired snapshot");

    mocks.offers.mockReturnValueOnce(bOfferRead.promise);
    mocks.funnel.mockReturnValueOnce(bFunnelRead.promise);
    mocks.me = {
      user: "next-admin@example.test",
      tenant: nextTenant,
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<RetentionHistoryWorkspace />));
    expect(document.body.textContent).not.toContain("Prior A paired snapshot");
    expect(document.body.textContent).toContain("Loading retention history");
    await flush();
    expect(mocks.offers).toHaveBeenLastCalledWith(nextTenant);

    mocks.offers.mockReturnValueOnce(freshAOfferRead.promise);
    mocks.funnel.mockReturnValueOnce(freshAFunnelRead.promise);
    mocks.me = {
      user: "admin@example.test",
      tenant: originalTenant,
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<RetentionHistoryWorkspace />));
    expect(document.body.textContent).not.toContain("Prior A paired snapshot");
    expect(document.body.textContent).toContain("Loading retention history");
    await flush();
    expect(mocks.offers).toHaveBeenLastCalledWith(originalTenant);

    freshAOfferRead.resolve({
      data: { items: freshAItems, reportedCount: freshAItems.length },
    });
    freshAFunnelRead.resolve({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });
    await flush();
    expect(document.body.textContent).toContain("Fresh A after identity cycle");
    expect(document.body.textContent).not.toContain("Prior A paired snapshot");

    bOfferRead.resolve({
      data: {
        items: [
          { ...OFFER_ITEMS[0], headline: "Late B response" },
        ] as typeof OFFER_ITEMS,
        reportedCount: 1,
      },
    });
    bFunnelRead.resolve({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });
    await flush();
    expect(document.body.textContent).toContain("Fresh A after identity cycle");
    expect(document.body.textContent).not.toContain("Late B response");
    expect(document.body.textContent).not.toContain("Prior A paired snapshot");
  });

  it("keeps every tab relationship valid while critical reads are pending", () => {
    const pending = new Promise<never>(() => undefined);
    mocks.offers.mockReturnValue(pending);
    mocks.funnel.mockReturnValue(pending);
    mocks.tiers.mockReturnValue(pending);
    mocks.settings.mockReturnValue(pending);

    render();

    expectEveryTabToOwnAPanel();
    expect(document.body.textContent).toContain("Loading retention history");
  });

  it("distinguishes staggered supporting reads from unavailable data", async () => {
    const pending = new Promise<never>(() => undefined);
    mocks.funnel.mockReturnValue(pending);
    mocks.settings.mockReturnValue(pending);

    render();
    await flush();

    expect(document.body.textContent).toContain(
      "Offer records are ready; funnel counters are still loading.",
    );
    expect(document.body.textContent).toContain("Funnel read in progress");
    expect(document.body.textContent).not.toContain(
      "The funnel request did not produce verified data.",
    );

    act(() => tabNamed("Readiness").click());
    const text = document.body.textContent ?? "";
    expect(text).toContain("The funnel response is still loading");
    expect(text).toContain("Win-back settings are still loading.");
    expect(text).toContain("Reading stored settings…");
    expect(text).not.toContain("Win-back settings are unavailable.");
    expect(
      document.querySelector(".rhs-winback-unknown")?.getAttribute("role"),
    ).toBe("status");
  });

  it("defers evidence filters and tier-name queries until their supporting reads settle", async () => {
    const funnelRead = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();
    const tierRead = deferred<{
      data: {
        items: Array<{ id: string; name: string; active: boolean }>;
      };
    }>();
    mocks.funnel.mockReturnValue(funnelRead.promise);
    mocks.tiers.mockReturnValue(tierRead.promise);
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      query: "Founders",
      filters: [{ key: "evidence", value: "measured" }],
    });

    render();
    await flush();

    expect(document.body.textContent).toContain("Supporting results pending");
    expect(document.body.textContent).toContain(
      "Supporting evidence is still loading.",
    );
    expect(document.body.textContent).not.toContain(
      "No offer matches these controls.",
    );

    funnelRead.resolve({
      data: { items: FUNNEL_ITEMS, reportedCount: FUNNEL_ITEMS.length },
    });
    tierRead.resolve({
      data: {
        items: [
          { id: TIER_1, name: "Founders", active: true },
          { id: TIER_2, name: "Annual", active: false },
        ],
      },
    });
    await flush();

    expect(document.body.textContent).toContain("1 matching offer");
    expect(document.body.textContent).toContain("Keep the founder rate");
    expect(document.body.textContent).not.toContain(
      "Supporting evidence is still loading.",
    );
  });

  it("withholds tier and funnel dependent results when their reads are unavailable", async () => {
    mocks.funnel.mockResolvedValue({
      error: { status: 503, message: "private funnel dependency" },
    });
    mocks.tiers.mockResolvedValue({
      error: { status: 503, message: "private tier dependency" },
    });
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      query: "Founders",
      filters: [{ key: "evidence", value: "measured" }],
    });

    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Supporting results unavailable");
    expect(text).toContain("Supporting results are unavailable.");
    expect(text).toContain("No empty-result claim or metric order is shown.");
    expect(text).not.toContain("No offer matches these controls.");
    expect(text).not.toContain("private funnel dependency");
    expect(text).not.toContain("private tier dependency");
  });

  it("loads four independent reads and presents only bounded stored-row truth", async () => {
    render();
    await flush();

    expect(mocks.offers).toHaveBeenCalledTimes(1);
    expect(mocks.funnel).toHaveBeenCalledTimes(1);
    expect(mocks.tiers).toHaveBeenCalledTimes(1);
    expect(mocks.settings).toHaveBeenCalledTimes(1);
    expect(mocks.snapshot.route).toEqual({ section: "retentionOffers" });

    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "See what the retention record can prove—and where it stops.",
    );
    expect(text).toContain("Counts are event rows, not unique customers.");
    expect(text).toContain("24");
    expect(text).toContain("6");
    expect(text).toContain("25.0%");
    expect(text).toContain("Accepted ÷ shown events");
    expect(text).not.toMatch(/\b(?:Create|Edit|Delete|Activate|Save offer)\b/u);
    expect(document.querySelector("form")).toBeNull();
  });

  it("uses manual APG tabs and mounts exactly the selected route-backed panel", async () => {
    render();
    await flush();

    const overview = tabNamed("Overview");
    const history = tabNamed("Offer history");
    const readiness = tabNamed("Readiness");
    expect(
      document.querySelector(
        '[role="tablist"][aria-label="Retention history views"]',
      ),
    ).not.toBeNull();
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(history.tabIndex).toBe(-1);
    expect(routeAnnouncementText()).toBe("");

    act(() => overview.focus());
    expect(press(overview, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(history);
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(press(history, "Enter").defaultPrevented).toBe(true);
    await flush();
    expect(history.getAttribute("aria-selected")).toBe("true");
    expect(routeAnnouncementText()).toBe("");
    expect(document.body.textContent).toContain(
      "Stored offers and recorded outcomes",
    );

    press(history, "End");
    expect(document.activeElement).toBe(readiness);
    expect(press(readiness, " ").defaultPrevented).toBe(true);
    await flush();
    expect(routeAnnouncementText()).toBe("");
    expect(document.body.textContent).toContain(
      "Stored facts do not become runtime promises.",
    );
    expect(document.body.textContent).toContain(
      "Three admin retention endpoints",
    );
    expect(document.body.textContent).toContain(
      "Tier names come from a separate shared read.",
    );
  });

  it("keeps fixed amounts currency-honest and filters current stored rows", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("1,250 minor units off");
    expect(text).not.toContain("$12.50");
    expect(text).toContain("currency not stored");

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    if (!search) throw new Error("Missing history search");
    act(() => {
      Reflect.set(HTMLInputElement.prototype, "value", "annual", search);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(document.body.textContent).toContain("1 matching offer");
    expect(document.body.textContent).toContain("Annual member save");
    expect(document.body.textContent).not.toContain("Keep the founder rate");
    expect(mocks.requestNavigate).toHaveBeenLastCalledWith(
      {
        section: "retentionOffers",
        tab: "history",
        query: "annual",
      },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );

    const navigationCount = mocks.requestNavigate.mock.calls.length;
    act(() => {
      Reflect.set(HTMLInputElement.prototype, "value", "annual ", search);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(search.value).toBe("annual ");
    expect(mocks.requestNavigate).toHaveBeenCalledTimes(navigationCount);

    act(() => {
      Reflect.set(HTMLInputElement.prototype, "value", "annual member", search);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(mocks.requestNavigate).toHaveBeenLastCalledWith(
      {
        section: "retentionOffers",
        tab: "history",
        query: "annual member",
      },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );

    const status = selectNamed("Stored state");
    act(() => {
      Reflect.set(HTMLSelectElement.prototype, "value", "active", status);
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(mocks.requestNavigate).toHaveBeenLastCalledWith(
      {
        section: "retentionOffers",
        tab: "history",
        query: "annual member",
        filters: [{ key: "status", value: "active" }],
      },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: false,
        source: "navigation",
      }),
    );
  });

  it("returns focus to the search field after its clear action removes the query", async () => {
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      query: "annual",
    });
    render();
    await flush();

    const search = document.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    const clear = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear offer search"]',
    );
    if (!search || !clear) throw new Error("Missing search clear controls");
    act(() => {
      clear.focus();
      clear.click();
    });
    await flush();

    expect(search.value).toBe("");
    expect(document.activeElement).toBe(search);
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
    });
  });

  it("replace-clamps a syntactically valid page after the verified result shrinks", async () => {
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      filters: [{ key: "page", value: "25" }],
    });
    render();
    await flush();

    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
    });
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      { section: "retentionOffers", tab: "history" },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
  });

  it("preserves a valid deep-linked page while rows load and after a multipage response", async () => {
    let resolveOffers: (value: {
      data: {
        items: typeof OFFER_ITEMS;
        reportedCount: number;
      };
    }) => void = () => undefined;
    const pendingOffers = new Promise<{
      data: {
        items: typeof OFFER_ITEMS;
        reportedCount: number;
      };
    }>((resolve) => {
      resolveOffers = resolve;
    });
    const pageItems = Array.from({ length: 21 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, "0");
      return {
        ...OFFER_ITEMS[0],
        id: `20000000-0000-4000-8000-${suffix}`,
        tierId: `30000000-0000-4000-8000-${suffix}`,
        headline: `Retained offer ${index + 1}`,
      };
    }) as typeof OFFER_ITEMS;
    mocks.offers.mockReturnValue(pendingOffers);
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      filters: [{ key: "page", value: "2" }],
    });

    render();
    await flush();
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
      filters: [{ key: "page", value: "2" }],
    });
    expect(mocks.requestNavigate).not.toHaveBeenCalled();

    resolveOffers({
      data: { items: pageItems, reportedCount: pageItems.length },
    });
    await flush();
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
      filters: [{ key: "page", value: "2" }],
    });
    expect(document.body.textContent).toContain("Retained offer 21");
    expect(
      normalizedText(document.querySelector(".rhs-pagination [role='status']")),
    ).toBe("Page 2 of 2");

    const previous = buttonNamed("Previous");
    act(() => {
      previous.focus();
      previous.click();
    });
    await flush();
    expect(document.activeElement).toBe(previous);
    expect(
      normalizedText(document.querySelector(".rhs-pagination [role='status']")),
    ).toBe("Page 1 of 2");
  });

  it("opens the exact retained row for inspection without exposing a mutation", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    const inspect = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".rhs-row-open"),
    )[0];
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();

    const latest = mocks.detailProps.mock.calls.at(-1)?.[0] as
      | { row: RetentionOfferHistoryRow; open: boolean }
      | undefined;
    expect(latest?.open).toBe(true);
    expect(latest?.row.offer.id).toBe(OFFER_1);
    expect(
      document.querySelector(
        '[role="dialog"][aria-label="Offer detail test boundary"]',
      ),
    ).not.toBeNull();
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: OFFER_1,
      },
    });

    act(() => buttonNamed("Close detail").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.requestBack).toHaveBeenCalledWith(
      {
        section: "retentionOffers",
        tab: "history",
      },
      expect.any(Function),
    );
  });

  it("preserves owned history through open, Back, Forward, and Close", async () => {
    const baseRoute = {
      section: "retentionOffers" as const,
      tab: "history",
      query: "founder",
    };
    const detailRoute = {
      ...baseRoute,
      overlay: {
        name: "retention-offer-detail" as const,
        resourceId: OFFER_1,
      },
    };
    setDesktopRoute(baseRoute);
    render();
    await flush();

    const inspect = document.querySelector<HTMLButtonElement>(".rhs-row-open");
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();
    expect(mocks.snapshot.route).toEqual(detailRoute);

    act(() => {
      void mocks.applyRoute(baseRoute, { source: "history" });
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.snapshot.source).toBe("history");

    act(() => {
      void mocks.applyRoute(detailRoute, { source: "history" });
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.requestBack.mockClear();
    mocks.requestNavigate.mockClear();
    act(() => buttonNamed("Close detail").click());
    await flush();

    expect(mocks.requestBack).toHaveBeenCalledWith(
      baseRoute,
      expect.any(Function),
    );
    expect(mocks.requestNavigate).not.toHaveBeenCalled();
    expect(mocks.snapshot.route).toEqual(baseRoute);
    expect(mocks.snapshot.source).toBe("history");
  });

  it("revokes owned history after a true route divergence", async () => {
    const baseRoute = {
      section: "retentionOffers" as const,
      tab: "history",
    };
    const detailRoute = {
      ...baseRoute,
      overlay: {
        name: "retention-offer-detail" as const,
        resourceId: OFFER_1,
      },
    };
    setDesktopRoute(baseRoute);
    render();
    await flush();

    const inspect = document.querySelector<HTMLButtonElement>(".rhs-row-open");
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();
    act(() => {
      void mocks.applyRoute(baseRoute, { source: "history" });
    });
    await flush();
    act(() => {
      void mocks.applyRoute(
        { ...baseRoute, query: "annual" },
        { source: "history" },
      );
    });
    await flush();
    act(() => {
      void mocks.applyRoute(baseRoute, { source: "history" });
    });
    await flush();
    act(() => {
      void mocks.applyRoute(detailRoute, { source: "history" });
    });
    await flush();

    mocks.requestBack.mockClear();
    mocks.requestNavigate.mockClear();
    act(() => buttonNamed("Close detail").click());
    await flush();

    expect(mocks.requestBack).not.toHaveBeenCalled();
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      baseRoute,
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
  });

  it("revokes owned history when the workspace identity changes", async () => {
    const baseRoute = {
      section: "retentionOffers" as const,
      tab: "history",
    };
    setDesktopRoute(baseRoute);
    render();
    await flush();

    const inspect = document.querySelector<HTMLButtonElement>(".rhs-row-open");
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();

    mocks.me = {
      user: "next-admin@example.test",
      tenant: "10000000-0000-4000-8000-000000000002",
      role: "admin",
      effectiveRole: "admin",
    };
    act(() => root?.render(<RetentionHistoryWorkspace />));
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.requestBack.mockClear();
    mocks.requestNavigate.mockClear();
    act(() => buttonNamed("Close detail").click());
    await flush();

    expect(mocks.requestBack).not.toHaveBeenCalled();
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      baseRoute,
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
  });

  it("marks an open detail as reconciling while its paired refresh is pending", async () => {
    const refreshedOffers = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    const refreshedFunnel = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    const inspect = document.querySelector<HTMLButtonElement>(".rhs-row-open");
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();

    mocks.offers.mockReturnValueOnce(refreshedOffers.promise);
    mocks.funnel.mockReturnValueOnce(refreshedFunnel.promise);
    act(() => buttonNamed("Refresh records").click());
    await flush();

    const pendingDetail = mocks.detailProps.mock.calls.at(-1)?.[0] as
      | { reconciliationPending?: boolean }
      | undefined;
    expect(pendingDetail?.reconciliationPending).toBe(true);

    refreshedOffers.resolve({
      data: { items: OFFER_ITEMS, reportedCount: OFFER_ITEMS.length },
    });
    refreshedFunnel.resolve({
      data: { items: FUNNEL_ITEMS, reportedCount: FUNNEL_ITEMS.length },
    });
    await flush();
    const settledDetail = mocks.detailProps.mock.calls.at(-1)?.[0] as
      | { reconciliationPending?: boolean }
      | undefined;
    expect(settledDetail?.reconciliationPending).toBe(false);
  });

  it("falls back to an exact replacement when the owned detail Back cannot be applied", async () => {
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      query: "founder",
      filters: [{ key: "status", value: "active" }],
    });
    render();
    await flush();

    const inspect = document.querySelector<HTMLButtonElement>(".rhs-row-open");
    if (!inspect) throw new Error("Missing inspect button");
    act(() => inspect.click());
    await flush();

    mocks.requestBack.mockResolvedValueOnce("failed");
    mocks.requestNavigate.mockClear();
    act(() => buttonNamed("Close detail").click());
    await flush();

    const base = {
      section: "retentionOffers" as const,
      tab: "history",
      query: "founder",
      filters: [{ key: "status", value: "active" }],
    };
    expect(mocks.requestBack).toHaveBeenCalledWith(base, expect.any(Function));
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      base,
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes a direct detail deep link by replacement without a blind Back", async () => {
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      query: "founder",
      overlay: {
        name: "retention-offer-detail",
        resourceId: OFFER_1,
      },
    });
    render();
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    mocks.requestNavigate.mockClear();
    act(() => buttonNamed("Close detail").click());
    await flush();

    expect(mocks.requestBack).not.toHaveBeenCalled();
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      {
        section: "retentionOffers",
        tab: "history",
        query: "founder",
      },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
  });

  it("self-heals a missing deep-linked row against the current verified response", async () => {
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });
    render();
    await flush();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "not present in the current verified offer-row response",
    );
    expect(routeAnnouncementText()).toBe(
      "The requested retention record was not present in the current verified offer-row response and has been closed.",
    );
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
    });
    expect(mocks.requestNavigate).toHaveBeenCalledWith(
      { section: "retentionOffers", tab: "history" },
      expect.objectContaining({
        isStillCurrent: expect.any(Function),
        replace: true,
        source: "navigation",
      }),
    );
  });

  it("reports a blocked missing-record repair without claiming the URL closed", async () => {
    mocks.requestNavigate.mockResolvedValueOnce("cancelled");
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });

    render();
    await flush();

    expect(mocks.snapshot.route).toMatchObject({
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });
    expect(document.body.textContent).toContain(
      "could not be closed because navigation was blocked",
    );
    expect(routeAnnouncementText()).toBe(
      "The missing retention record could not be closed because navigation was blocked.",
    );
    expect(document.body.textContent).not.toContain("has been closed");

    act(() => buttonNamed("Retry route repair").click());
    await flush();
    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "history",
    });
    expect(document.body.textContent).toContain(
      "The retention route repair completed.",
    );
    expect(routeAnnouncementText()).toBe(
      "The retention route repair completed.",
    );
  });

  it("drops a blocked repair after an independent canonical navigation supersedes it", async () => {
    mocks.requestNavigate.mockResolvedValueOnce("cancelled");
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });
    render();
    await flush();
    expect(document.body.textContent).toContain("Route repair was blocked.");
    expect(buttonNamed("Retry route repair")).not.toBeNull();

    act(() => {
      mocks.applyRoute(
        { section: "retentionOffers", tab: "readiness" },
        { source: "navigation" },
      );
    });
    await flush();

    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "readiness",
    });
    expect(document.body.textContent).not.toContain(
      "Route repair was blocked.",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => normalizedText(button) === "Retry route repair",
      ),
    ).toBe(false);
  });

  it("ignores a late blocked-repair result after canonical navigation already won", async () => {
    const lateRepair = deferred<"cancelled">();
    mocks.requestNavigate.mockReturnValueOnce(lateRepair.promise);
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });
    render();
    await flush();

    act(() => {
      mocks.applyRoute(
        { section: "retentionOffers", tab: "readiness" },
        { source: "navigation" },
      );
    });
    await flush();
    lateRepair.resolve("cancelled");
    await flush();

    expect(mocks.snapshot.route).toEqual({
      section: "retentionOffers",
      tab: "readiness",
    });
    expect(document.body.textContent).not.toContain(
      "Route repair was blocked.",
    );
    expect(document.body.textContent).not.toContain("navigation was blocked");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (button) => normalizedText(button) === "Retry route repair",
      ),
    ).toBe(false);
  });

  it("ignores a superseded repair while a newer route intent is still pending", async () => {
    const oldRepair = deferred<"cancelled">();
    const newerIntent = deferred<"cancelled">();
    mocks.requestNavigate
      .mockReturnValueOnce(oldRepair.promise)
      .mockReturnValueOnce(newerIntent.promise);
    setDesktopRoute({
      section: "retentionOffers",
      tab: "history",
      overlay: {
        name: "retention-offer-detail",
        resourceId: "20000000-0000-4000-8000-000000000099",
      },
    });
    render();
    await flush();

    act(() => tabNamed("Readiness").click());
    oldRepair.resolve("cancelled");
    await flush();

    expect(mocks.snapshot.route).toMatchObject({
      section: "retentionOffers",
      tab: "history",
    });
    expect(document.body.textContent).not.toContain(
      "Route repair was blocked.",
    );
    expect(document.body.textContent).not.toContain("navigation was blocked");

    newerIntent.resolve("cancelled");
    await flush();
    expect(document.body.textContent).not.toContain(
      "Route repair was blocked.",
    );
  });

  it("keeps offers visible and treats a failed funnel as unknown, never zero", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    mocks.funnel.mockResolvedValue({
      error: {
        status: 503,
        message: "private aggregation failure",
      },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain("Keep the founder rate");
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).not.toContain(
      "private aggregation failure",
    );

    act(() => tabNamed("Overview").click());
    expect(document.body.textContent).toContain("Funnel unknown");
    expect(document.body.textContent).toContain(
      "Dashes mean unknown, never zero.",
    );
  });

  it("withholds aggregates when loaded resources disagree", async () => {
    mocks.funnel.mockResolvedValue({
      data: { items: [], reportedCount: 0 },
    });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("2 reconciliation issues block aggregate claims.");
    expect(text).toContain("Withheld pending reconciliation");
    expect(text).not.toContain("25.0%");
  });

  it("never asserts an integrity defect while a paired refresh is between generations", async () => {
    const refreshedFunnel = deferred<{
      data: {
        items: Array<(typeof FUNNEL_ITEMS)[number]>;
        reportedCount: number;
      };
    }>();
    mocks.offers
      .mockResolvedValueOnce({
        data: { items: OFFER_ITEMS, reportedCount: OFFER_ITEMS.length },
      })
      .mockResolvedValueOnce({
        data: { items: [OFFER_ITEMS[0]], reportedCount: 1 },
      });
    mocks.funnel
      .mockResolvedValueOnce({
        data: { items: FUNNEL_ITEMS, reportedCount: FUNNEL_ITEMS.length },
      })
      .mockReturnValueOnce(refreshedFunnel.promise);
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    act(() => buttonNamed("Refresh records").click());
    await flush();
    act(() => tabNamed("Overview").click());

    const pendingText = document.body.textContent ?? "";
    expect(pendingText).toContain(
      "Offer and funnel refreshes are being reconciled.",
    );
    expect(pendingText).not.toContain("reconciliation issue blocks");
    expect(pendingText).not.toContain("reconciliation issues block");
    expect(pendingText).not.toContain("Orphan funnel tiles");

    refreshedFunnel.resolve({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });
    await flush();

    expect(document.body.textContent).not.toContain(
      "Offer and funnel refreshes are being reconciled.",
    );
    expect(document.body.textContent).toContain("20");
    expect(document.body.textContent).toContain("5");
  });

  it("keeps the newest verified critical refresh when an older attempt completes later", async () => {
    const olderOffers = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    const olderFunnel = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();
    const newerOffers = deferred<{
      data: { items: typeof OFFER_ITEMS; reportedCount: number };
    }>();
    const newerFunnel = deferred<{
      data: { items: typeof FUNNEL_ITEMS; reportedCount: number };
    }>();
    const supersededItems = [
      { ...OFFER_ITEMS[0], headline: "Superseded refresh result" },
    ] as typeof OFFER_ITEMS;
    const newestItems = [
      { ...OFFER_ITEMS[0], headline: "Newest verified refresh" },
    ] as typeof OFFER_ITEMS;
    const newestFunnel = [
      { ...FUNNEL_ITEMS[0], shown: 40, accepted: 10 },
    ] as typeof FUNNEL_ITEMS;
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    mocks.offers
      .mockReturnValueOnce(olderOffers.promise)
      .mockReturnValueOnce(newerOffers.promise);
    mocks.funnel
      .mockReturnValueOnce(olderFunnel.promise)
      .mockReturnValueOnce(newerFunnel.promise);
    const refresh = buttonNamed("Refresh records");
    act(() => {
      refresh.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      refresh.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(mocks.offers).toHaveBeenCalledTimes(3);
    expect(mocks.funnel).toHaveBeenCalledTimes(3);

    newerOffers.resolve({
      data: { items: newestItems, reportedCount: newestItems.length },
    });
    newerFunnel.resolve({
      data: { items: newestFunnel, reportedCount: newestFunnel.length },
    });
    await flush();
    expect(document.body.textContent).toContain("Newest verified refresh");
    expect(document.body.textContent).not.toContain(
      "Superseded refresh result",
    );
    expect(document.body.textContent).not.toContain(
      "Paired refresh incomplete.",
    );

    olderOffers.resolve({
      data: { items: supersededItems, reportedCount: supersededItems.length },
    });
    olderFunnel.resolve({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });
    await flush();

    expect(document.body.textContent).toContain("Newest verified refresh");
    expect(document.body.textContent).not.toContain(
      "Superseded refresh result",
    );
    expect(document.body.textContent).not.toContain(
      "Paired refresh incomplete.",
    );
  });

  it("indexes every reconciliation category with bounded record references", async () => {
    const offerId = (suffix: string) =>
      `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
    const tierId = (suffix: string) =>
      `30000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
    const extraOffers = ["3", "4", "5"].map((suffix) => ({
      ...OFFER_ITEMS[0],
      id: offerId(suffix),
      tierId: tierId(suffix),
      headline: `Offer ${suffix}`,
    }));
    mocks.offers.mockResolvedValue({
      data: {
        items: [...OFFER_ITEMS, ...extraOffers],
        reportedCount: 5,
      },
    });
    mocks.funnel.mockResolvedValue({
      data: {
        items: [
          FUNNEL_ITEMS[1],
          { ...FUNNEL_ITEMS[1] },
          {
            offerId: offerId("3"),
            tierId: tierId("33"),
            shown: 1,
            accepted: 0,
            declined: 0,
            expired: 0,
          },
          {
            offerId: offerId("4"),
            tierId: tierId("4"),
            shown: 1,
            accepted: 1,
            declined: 1,
            expired: 0,
          },
          {
            offerId: offerId("5"),
            tierId: tierId("5"),
            shown: 1,
            accepted: 1,
            declined: 0,
            expired: 0,
          },
          {
            offerId: offerId("99"),
            tierId: tierId("99"),
            shown: 1,
            accepted: 0,
            declined: 0,
            expired: 0,
          },
        ],
        reportedCount: 6,
      },
    });

    render();
    await flush();

    const text = document.body.textContent ?? "";
    for (const label of [
      "Missing funnel tiles",
      "Duplicate funnel tiles",
      "Orphan funnel tiles",
      "Tier mismatches",
      "Outcomes exceed shown",
    ]) {
      expect(text).toContain(label);
    }
    for (const id of [
      OFFER_1,
      OFFER_2,
      offerId("3"),
      offerId("4"),
      offerId("99"),
    ]) {
      expect(text).toContain(id);
    }
    expect(text).toContain("5 reconciliation issues block aggregate claims.");
  });

  it("distinguishes a valid empty stored-row response from loading or failure", async () => {
    mocks.offers.mockResolvedValue({
      data: { items: [], reportedCount: 0 },
    });
    mocks.funnel.mockResolvedValue({
      data: { items: [], reportedCount: 0 },
    });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "No current stored offer rows were returned.",
    );
    expect(document.body.textContent).toContain("valid, empty collection");
    expect(document.body.textContent).not.toContain("History unavailable");
    expect(document.body.textContent).toContain("Refresh records");
    expectEveryTabToOwnAPanel();

    act(() => tabNamed("Readiness").click());
    expect(document.body.textContent).toContain(
      "Stored facts do not become runtime promises.",
    );
  });

  it("keeps orphan-funnel diagnostics visible beside a valid empty offer response", async () => {
    mocks.offers.mockResolvedValue({
      data: { items: [], reportedCount: 0 },
    });
    mocks.funnel.mockResolvedValue({
      data: { items: [FUNNEL_ITEMS[0]], reportedCount: 1 },
    });

    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("No current stored offer rows were returned.");
    expect(text).toContain("1 reconciliation issue blocks aggregate claims.");
    expect(text).toContain("Orphan funnel tiles");
    expect(text).toContain(OFFER_1);
    expect(text).toContain("Refresh records");
  });

  it("shows critical offer recovery on a direct Readiness deep link", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "readiness" });
    mocks.offers.mockResolvedValue({
      error: {
        status: 503,
        message: "private offer storage topology",
      },
    });

    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The stored offer-row response could not be verified.",
    );
    expect(document.body.textContent).toContain("Check again");
    expect(document.body.textContent).not.toContain(
      "private offer storage topology",
    );
  });

  it("distinguishes a verified tier-catalogue gap from an unavailable name read", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    mocks.tiers.mockResolvedValue({
      data: {
        items: [{ id: TIER_2, name: "Annual", active: false }],
      },
    });

    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Verified tier-catalogue gap.");
    expect(text).toContain("1 offer row references");
    expect(text).toContain("absent from verified catalogue");
    expect(text).not.toContain("Tier names are unavailable.");
  });

  it("redacts an initial offer error and recovers the paired critical reads from any tab", async () => {
    mocks.offers
      .mockResolvedValueOnce({
        error: {
          status: 500,
          message: "database password and raw tenant payload",
        },
      })
      .mockResolvedValueOnce({
        data: { items: OFFER_ITEMS, reportedCount: 2 },
      });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The stored offer-row response could not be verified.",
    );
    expect(document.body.textContent).toContain(
      "The service could not complete the request.",
    );
    expect(document.body.textContent).not.toContain("database password");
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".rhs-hero-facts strong"),
      )
        .slice(0, 3)
        .map((node) => node.textContent),
    ).toEqual(["—", "—", "—"]);

    act(() => tabNamed("Readiness").click());
    expect(document.body.textContent).toContain(
      "The stored offer-row response could not be verified.",
    );
    act(() => buttonNamed("Check again").click());
    await flush();
    expect(mocks.offers).toHaveBeenCalledTimes(2);
    expect(mocks.funnel).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "Stored facts do not become runtime promises.",
    );

    act(() => tabNamed("Overview").click());
    expect(document.body.textContent).toContain(
      "Read the caveat beside the signal.",
    );
  });

  it("retains the last verified offer snapshot after a refresh failure", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    mocks.offers
      .mockResolvedValueOnce({
        data: { items: OFFER_ITEMS, reportedCount: 2 },
      })
      .mockResolvedValueOnce({
        error: {
          status: 503,
          message: "private storage topology",
        },
      });
    render();
    await flush();

    act(() => buttonNamed("Refresh records").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Using the last verified offer-row response.",
    );
    expect(document.body.textContent).toContain("Last verified rows");
    expect(document.body.textContent).toContain("Last verified per-tier rows");
    expect(document.body.textContent).toContain("Keep the founder rate");
    expect(document.body.textContent).not.toContain("private storage topology");
  });

  it("labels a retained empty snapshot as last verified after refresh failure", async () => {
    mocks.offers
      .mockResolvedValueOnce({
        data: { items: [], reportedCount: 0 },
      })
      .mockResolvedValueOnce({
        error: {
          status: 503,
          message: "private empty-snapshot topology",
        },
      });
    mocks.funnel.mockResolvedValue({
      data: { items: [], reportedCount: 0 },
    });
    setDesktopRoute({ section: "retentionOffers", tab: "history" });
    render();
    await flush();

    act(() => buttonNamed("Refresh records").click());
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Last verified empty response");
    expect(text).toContain(
      "No offer rows were present in the last verified response.",
    );
    expect(text).not.toContain("No current stored offer rows were returned.");
    expect(text).not.toContain("private empty-snapshot topology");
  });

  it.each(["overview", "history"] as const)(
    "labels every stale supporting read with one aggregate alert on %s",
    async (tab) => {
      mocks.funnel.mockResolvedValueOnce({
        data: { items: FUNNEL_ITEMS, reportedCount: 2 },
      });
      mocks.tiers.mockResolvedValueOnce({
        data: {
          items: [
            { id: TIER_1, name: "Founders", active: true },
            { id: TIER_2, name: "Annual", active: false },
          ],
        },
      });
      mocks.settings.mockResolvedValueOnce({
        data: {
          enabled: true,
          churnThreshold: 0.7,
          churnProfilesScored: 38,
        },
      });
      mocks.funnel.mockResolvedValueOnce({
        error: { status: 503, message: "private funnel topology" },
      });
      mocks.tiers.mockResolvedValueOnce({
        error: { status: 503, message: "private tier topology" },
      });
      mocks.settings.mockResolvedValueOnce({
        error: { status: 503, message: "private worker topology" },
      });
      setDesktopRoute({ section: "retentionOffers", tab: "history" });
      render();
      await flush();

      act(() => buttonNamed("Refresh records").click());
      await flush();
      if (tab === "overview") {
        act(() => tabNamed("Overview").click());
        await flush();
      }

      const text = document.body.textContent ?? "";
      expect(text).toContain("Funnel refresh failed.");
      expect(text).toContain("Tier-name refresh failed.");
      expect(text).toContain("Stored-setting refresh failed.");
      expect(text).toContain("Paired refresh incomplete.");
      expect(text).toContain(
        "funnel joins, row evidence, totals, and rates are unknown",
      );
      expect(text).toContain("· stale");
      expect(
        Array.from(
          document.querySelectorAll<HTMLElement>(".rhs-provenance > span"),
        ).some((node) => /^Funnel .+ · stale$/u.test(normalizedText(node))),
      ).toBe(true);
      expect(text).not.toMatch(/private (funnel|tier|worker) topology/u);
      if (tab === "history") expect(text).toContain("Keep the founder rate");
      const alerts = Array.from(
        document.querySelectorAll<HTMLElement>('[role="alert"]'),
      );
      expect(alerts).toHaveLength(1);
      expect(normalizedText(alerts[0])).toContain("Refresh incomplete.");
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>("button"),
        ).filter(
          (button) => normalizedText(button) === "Retry incomplete refresh",
        ),
      ).toHaveLength(1);
    },
  );

  it("labels stored win-back inputs without claiming a live worker", async () => {
    setDesktopRoute({ section: "retentionOffers", tab: "readiness" });
    render();
    await flush();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Win-back setting observation");
    expect(text).toContain("Stored switch");
    expect(text).toContain("Enabled");
    expect(text).toContain("38");
    expect(text).toContain("Runtime delivery");
    expect(text).toContain("Not certified");
    expect(text).toContain("stored switch is not proof of worker startup");
    expect(text).not.toContain("win-backs are live");
  });
});
