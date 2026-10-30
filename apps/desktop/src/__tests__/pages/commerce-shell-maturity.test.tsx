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

import type { CommerceIntegration } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  available: vi.fn(),
  canAdmin: true,
  catalogsProps: vi.fn(),
  fromApiError: vi.fn(),
  integrationsProps: vi.fn(),
  lifecycleProps: vi.fn(),
  listIntegrations: vi.fn(),
  navigateDesktopRoute: vi.fn(),
  recoveryProps: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  commerceApi: {
    listIntegrations: mocks.listIntegrations,
  },
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.available,
    fromApiError: mocks.fromApiError,
  }),
}));

vi.mock("../../lib/desktop-router", async () => {
  const React = await import("react");
  return {
    navigateDesktopRoute: mocks.navigateDesktopRoute,
    useDesktopRoute: () => ({ section: "commerce" }),
    useDesktopRouteTab: <T extends string>(
      _section: string,
      _allowed: readonly T[],
      fallback: T,
    ) => React.useState<T>(fallback),
  };
});

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
}));

vi.mock("../../components/Icon", () => ({
  Icon: () => null,
}));

vi.mock("../../components/commerce/IntegrationsTab", () => ({
  IntegrationsTab: (props: {
    canAdmin: boolean;
    err: string | null;
    integrations: CommerceIntegration[] | null;
  }) => {
    mocks.integrationsProps(props);
    return (
      <div data-commerce-shell-surface="stores">
        {props.err ? <output data-store-error>{props.err}</output> : null}
      </div>
    );
  },
}));

vi.mock("../../components/commerce/CatalogsTab", () => ({
  CatalogsTab: (props: {
    canAdmin: boolean;
    integrations: CommerceIntegration[] | null;
  }) => {
    mocks.catalogsProps(props);
    return <div data-commerce-shell-surface="catalogs" />;
  },
}));

vi.mock("../../components/commerce/RecoveryTab", () => ({
  RecoveryTab: (props: {
    canAdmin: boolean;
    integrations: CommerceIntegration[] | null;
    integrationsErr: string | null;
  }) => {
    mocks.recoveryProps(props);
    return <div data-commerce-shell-surface="recovery" />;
  },
}));

vi.mock("../../components/commerce/LifecycleTab", () => ({
  LifecycleTab: (props: {
    canAdmin: boolean;
    integrations: CommerceIntegration[] | null;
    integrationsErr: string | null;
  }) => {
    mocks.lifecycleProps(props);
    return <div data-commerce-shell-surface="lifecycle" />;
  },
}));

import { Commerce } from "../../pages/Commerce";

const healthyStore: CommerceIntegration = {
  id: "store_healthy",
  provider: "shopify",
  shop_domain: "healthy.example",
  status: "connected",
  scopes: [],
  settings: {},
  last_sync_at: "2026-07-21T09:00:00Z",
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-21T09:00:00Z",
};

const attentionStore: CommerceIntegration = {
  id: "store_attention",
  provider: "bigcommerce",
  shop_domain: "attention.example",
  status: "paused",
  scopes: [],
  settings: {},
  error_message: "Provider access requires review.",
  last_sync_at: "2026-07-22T10:00:00Z",
  created_at: "2026-07-02T00:00:00Z",
  updated_at: "2026-07-22T10:00:00Z",
};

const stores = [healthyStore, attentionStore];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.listIntegrations.mockReset();
  mocks.listIntegrations.mockResolvedValue({ data: [] });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement = <Commerce />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function normalizedText(node: Element | null): string {
  return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => normalizedText(candidate) === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${name}`);
  }
  return button;
}

function tabNamed(name: string): HTMLButtonElement {
  const tab = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find(
    (candidate) => candidate.querySelector("strong")?.textContent === name,
  );
  if (!tab) throw new Error(`Missing tab: ${name}`);
  return tab;
}

function pressKey(target: HTMLElement, key: string): KeyboardEvent {
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

function factValue(label: string): string {
  const snapshot = document.querySelector(
    '[aria-label="Commerce connection snapshot"]',
  );
  const fact = Array.from(snapshot?.children ?? []).find(
    (candidate) => candidate.querySelector("strong")?.textContent === label,
  );
  if (!fact) throw new Error(`Missing Commerce fact: ${label}`);
  const heading = fact.querySelector("strong")?.textContent ?? "";
  return normalizedText(fact).slice(heading.length).trim();
}

function expectRoleDelegation(canAdmin: boolean): void {
  expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ canAdmin }),
  );

  act(() => tabNamed("Catalogs & feeds").click());
  expect(mocks.catalogsProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ canAdmin }),
  );

  act(() => tabNamed("Recovery").click());
  expect(mocks.recoveryProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ canAdmin }),
  );

  act(() => tabNamed("Lifecycle health").click());
  expect(mocks.lifecycleProps).toHaveBeenLastCalledWith(
    expect.objectContaining({ canAdmin }),
  );
}

describe("Commerce route-shell maturity", () => {
  it("reports connection facts without turning them into delivery or certification claims", async () => {
    mocks.listIntegrations.mockResolvedValue({ data: stores });
    render();
    await flush();

    expect(normalizedText(document.querySelector('[role="status"]'))).toBe(
      "Review needed",
    );
    expect(factValue("Connections")).toBe("2");
    expect(factValue("Healthy")).toBe("1");
    expect(factValue("Needs review")).toBe("1");
    expect(factValue("Last recorded sync")).not.toMatch(
      /^(?:—|Not recorded|Unavailable)$/u,
    );
    expect(mocks.available).toHaveBeenCalledTimes(1);

    const body = normalizedText(document.body);
    expect(body).toContain(
      "Store states only; each dataset owns its refresh. Provider capability is partial and certification-pending.",
    );
    expect(body).toContain(
      "Recorded connection state is not proof of complete provider reconciliation or message delivery.",
    );
    expect(body).toContain("No mutation runs when this workspace opens.");
    expect(body).not.toMatch(
      /fully certified|delivery verified|messages? (?:were )?delivered|reconciliation complete/iu,
    );
  });

  it("fails closed on a malformed initial response instead of claiming an empty ready state", async () => {
    mocks.listIntegrations.mockResolvedValue({
      data: { items: [] },
    });
    render();
    await flush();

    expect(normalizedText(document.querySelector('[role="status"]'))).toBe(
      "Verification unavailable",
    );
    expect(factValue("Connections")).toBe("Unavailable");
    expect(factValue("Healthy")).toBe("Unavailable");
    expect(factValue("Needs review")).toBe("Unavailable");
    expect(factValue("Last recorded sync")).toBe("Unavailable");
    expect(document.body.textContent).toContain(
      "Commerce returned an invalid store-connection response. No connections are shown as verified.",
    );
    expect(document.body.textContent).not.toContain("Ready to connect");
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.fromApiError).not.toHaveBeenCalled();
    expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        integrations: [],
      }),
    );
  });

  it("explains administrator-only discovery to a viewer without treating the suite as available", async () => {
    mocks.canAdmin = false;
    const error = {
      status: 403,
      code: "forbidden",
      message: "Forbidden",
    };
    mocks.listIntegrations.mockResolvedValue({ error });
    render();
    await flush();

    expect(normalizedText(document.querySelector('[role="status"]'))).toBe(
      "Verification unavailable",
    );
    expect(document.body.textContent).toContain(
      "This server restricts store discovery to administrators, so read-only Commerce reports cannot be safely scoped from this account.",
    );
    expect(factValue("Connections")).toBe("Unavailable");
    expect(mocks.fromApiError).toHaveBeenCalledWith(error, {
      endpointAbsenceMeansNotConfigured: true,
    });
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        canAdmin: false,
        integrations: [],
      }),
    );
  });

  it("retains previously verified facts when a later store-state refresh fails", async () => {
    const refreshError = {
      status: 503,
      code: "upstream_unavailable",
      message: "Provider state refresh is unavailable.",
    };
    mocks.listIntegrations
      .mockResolvedValueOnce({ data: stores })
      .mockResolvedValueOnce({ error: refreshError });
    render();
    await flush();

    expect(factValue("Connections")).toBe("2");
    act(() => buttonNamed("Refresh store states").click());
    await flush();

    expect(normalizedText(document.querySelector('[role="status"]'))).toBe(
      "Refresh failed · retained states",
    );
    expect(factValue("Connections")).toBe("2");
    expect(factValue("Healthy")).toBe("1");
    expect(factValue("Needs review")).toBe("1");
    expect(document.body.textContent).toContain(refreshError.message);
    expect(mocks.integrationsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        err: refreshError.message,
        integrations: stores,
      }),
    );
    expect(mocks.available).toHaveBeenCalledTimes(1);
    expect(mocks.fromApiError).toHaveBeenCalledWith(refreshError, {
      endpointAbsenceMeansNotConfigured: true,
    });
  });

  it("keeps the route refresh scoped to store states and names dataset ownership", async () => {
    mocks.listIntegrations.mockResolvedValue({ data: stores });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "Store states only; each dataset owns its refresh.",
    );
    expect(mocks.listIntegrations).toHaveBeenCalledTimes(1);

    act(() => buttonNamed("Refresh store states").click());
    await flush();

    expect(mocks.listIntegrations).toHaveBeenCalledTimes(2);
    expect(buttonNamed("Refresh store states").getAttribute("aria-busy")).toBe(
      null,
    );
  });

  it("uses manual APG keyboard activation and preserves exact tab-to-panel relationships", async () => {
    mocks.listIntegrations.mockResolvedValue({ data: stores });
    render();
    await flush();

    const storeTab = tabNamed("Stores");
    const catalogsTab = tabNamed("Catalogs & feeds");
    const storePanel = document.getElementById(
      storeTab.getAttribute("aria-controls") ?? "",
    );
    expect(storeTab.getAttribute("aria-selected")).toBe("true");
    expect(storePanel?.getAttribute("role")).toBe("tabpanel");
    expect(storePanel?.getAttribute("aria-labelledby")).toBe(storeTab.id);
    expect(storePanel?.hasAttribute("hidden")).toBe(false);
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
        (candidate) => candidate.tabIndex === 0,
      ),
    ).toHaveLength(1);

    act(() => storeTab.focus());
    expect(pressKey(storeTab, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(catalogsTab);
    expect(storeTab.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector('[data-commerce-shell-surface="stores"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-commerce-shell-surface="catalogs"]'),
    ).toBeNull();

    expect(pressKey(catalogsTab, "Enter").defaultPrevented).toBe(true);
    expect(catalogsTab.getAttribute("aria-selected")).toBe("true");
    const catalogsPanel = document.getElementById(
      catalogsTab.getAttribute("aria-controls") ?? "",
    );
    expect(catalogsPanel?.hasAttribute("hidden")).toBe(false);
    expect(
      document.querySelector('[data-commerce-shell-surface="catalogs"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      "Catalogs & feeds workspace selected. Shape catalog sources into reusable feeds.",
    );

    pressKey(catalogsTab, "End");
    const lifecycleTab = tabNamed("Lifecycle health");
    expect(document.activeElement).toBe(lifecycleTab);
    expect(catalogsTab.getAttribute("aria-selected")).toBe("true");
    pressKey(lifecycleTab, " ");
    expect(lifecycleTab.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps one route heading followed by the selected workspace heading", async () => {
    render();
    await flush();

    const headings = Array.from(document.querySelectorAll("h1, h2")).map(
      normalizedText,
    );
    expect(headings).toEqual([
      "Commerce — Turn storefront signals into timely customer moments.",
      "Stores workspace",
    ]);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    expect(
      document.querySelector(".commerce-hero")?.getAttribute("aria-labelledby"),
    ).toBe("commerce-title");

    act(() => tabNamed("Recovery").click());
    expect(
      Array.from(document.querySelectorAll("h1, h2")).map(normalizedText),
    ).toEqual([
      "Commerce — Turn storefront signals into timely customer moments.",
      "Recovery workspace",
    ]);
  });

  it.each([
    { canAdmin: false, role: "viewer" },
    { canAdmin: true, role: "administrator" },
  ])(
    "delegates $role authority consistently to every task surface",
    async ({ canAdmin }) => {
      mocks.canAdmin = canAdmin;
      mocks.listIntegrations.mockResolvedValue({ data: stores });
      render();
      await flush();

      expectRoleDelegation(canAdmin);
    },
  );
});
