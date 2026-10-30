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
  IntegrationCatalogItem,
  IntegrationConnection,
} from "../../lib/api-client";
import type { IntegrationLifecycleController } from "../../pages/integrations/useIntegrationLifecycleController";

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  callback: vi.fn(),
  detail: vi.fn(),
  disconnect: vi.fn(),
  navigateSection: vi.fn(),
  pause: vi.fn(),
  requestRoute: vi.fn(),
  startConnect: vi.fn(),
  sync: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", () => {
  const nativeLifecycle = {
    sync: vi.fn(),
    backfill: vi.fn(),
    pause: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    analyticsIntegrationsApi: nativeLifecycle,
    crmIntegrationsApi: nativeLifecycle,
    leadIntegrationsApi: nativeLifecycle,
    loyaltyIntegrationsApi: nativeLifecycle,
    reviewIntegrationsApi: nativeLifecycle,
    subscriptionIntegrationsApi: nativeLifecycle,
    supportIntegrationsApi: nativeLifecycle,
    integrationsApi: {
      backfill: mocks.backfill,
      callback: mocks.callback,
      detail: mocks.detail,
      disconnect: mocks.disconnect,
      pause: mocks.pause,
      startConnect: mocks.startConnect,
      sync: mocks.sync,
    },
  };
});

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSection: mocks.navigateSection,
  requestDesktopRouteNavigation: mocks.requestRoute,
}));

vi.mock("../../lib/store", () => ({ pathToSection: () => null }));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo },
}));

import { useIntegrationLifecycleController } from "../../pages/integrations/useIntegrationLifecycleController";

const commerceItem: IntegrationCatalogItem = {
  slug: "shopify",
  name: "Shopify",
  category: "ecommerce",
  badge: "native",
  runtime_status: "available",
  summary: "Commerce source",
  capabilities: ["orders"],
  native: true,
  sources: ["commerce"],
};

const bridgeItem: IntegrationCatalogItem = {
  slug: "typeform",
  name: "Typeform",
  category: "forms",
  badge: "zapier",
  runtime_status: "delegated",
  summary: "Bridge source",
  capabilities: ["profiles"],
  native: false,
  sources: ["bridge"],
};

const commerceConnection: IntegrationConnection = {
  slug: "shopify",
  name: "Shopify",
  category: "ecommerce",
  badge: "native",
  runtime_status: "available",
  connected: true,
  status: "active",
  count: 1,
  primary_connection_id: "store_1",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let controller: IntegrationLifecycleController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestRoute.mockResolvedValue("proceeded");
  mocks.sync.mockResolvedValue({
    data: { message: "Sync accepted", status: "accepted" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  controller = null;
  container?.remove();
  container = null;
});

function Harness({ canAdmin = true }: { canAdmin?: boolean }): ReactElement {
  controller = useIntegrationLifecycleController({
    canAdmin,
    catalog: null,
    connectionMap: new Map([["shopify", commerceConnection]]),
    refresh: vi.fn().mockResolvedValue(undefined),
  });
  return <div />;
}

function renderHarness(canAdmin = true): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness canAdmin={canAdmin} />));
}

function currentController(): IntegrationLifecycleController {
  if (!controller) throw new Error("Lifecycle controller did not render");
  return controller;
}

describe("Integrations commerce ownership handoff", () => {
  it("hands every commerce action to Commerce without calling generic integration mutations", async () => {
    renderHarness();
    const lifecycle = currentController();

    await act(async () => lifecycle.runAction(commerceItem, "connect"));
    await act(async () => lifecycle.runAction(commerceItem, "sync"));
    await act(async () => lifecycle.openDetail(commerceItem));
    for (const action of ["backfill", "pause", "disconnect"] as const) {
      await act(async () => lifecycle.runLifecycleAction(commerceItem, action));
    }

    expect(mocks.requestRoute.mock.calls.map(([route]) => route)).toEqual([
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "connect-store", resourceId: "store_1" },
      }),
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "sync-store", resourceId: "store_1" },
      }),
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "manage-store", resourceId: "store_1" },
      }),
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "backfill-store", resourceId: "store_1" },
      }),
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "pause-store", resourceId: "store_1" },
      }),
      expect.objectContaining({
        section: "commerce",
        overlay: { name: "disconnect-store", resourceId: "store_1" },
      }),
    ]);
    for (const [route] of mocks.requestRoute.mock.calls) {
      expect(route.filters).toEqual([{ key: "provider", value: "shopify" }]);
      expect(JSON.stringify(route).toLowerCase()).not.toMatch(
        /credential|password|secret|settings|token/u,
      );
    }
    expect(mocks.startConnect).not.toHaveBeenCalled();
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
    expect(currentController().pendingDisconnectItem).toBeNull();
    expect(currentController().selectedSlug).toBe("");
  });

  it("preserves the existing generic provider lifecycle outside Commerce", async () => {
    renderHarness();
    await act(async () => currentController().runAction(bridgeItem, "sync"));
    expect(mocks.sync).toHaveBeenCalledWith("typeform");
    expect(mocks.requestRoute).not.toHaveBeenCalled();
  });

  it("keeps the admin gate ahead of commerce mutation handoffs", async () => {
    renderHarness(false);
    await act(async () =>
      currentController().runLifecycleAction(commerceItem, "disconnect"),
    );
    expect(mocks.requestRoute).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Admin access is required to manage integrations.",
    );
  });
});
