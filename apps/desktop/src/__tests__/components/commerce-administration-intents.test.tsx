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

import type {
  CommerceIntegration,
  CommerceProviderSpec,
} from "../../lib/api-client";
import type { CommerceAdministrationIntent } from "../../lib/commerce-owner-intents";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  createIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  listProviders: vi.fn(),
  onReload: vi.fn(),
  onResolved: vi.fn(),
  openUrl: vi.fn(),
  pauseIntegration: vi.fn(),
  startShopifyOAuth: vi.fn(),
  syncIntegration: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  commerceApi: {
    createIntegration: mocks.createIntegration,
    disconnectIntegration: mocks.disconnectIntegration,
    listProviders: mocks.listProviders,
    pauseIntegration: mocks.pauseIntegration,
    startShopifyOAuth: mocks.startShopifyOAuth,
    syncIntegration: mocks.syncIntegration,
  },
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { IntegrationsTab } from "../../components/commerce/IntegrationsTab";

const integration: CommerceIntegration = {
  id: "store_1",
  provider: "bigcommerce",
  shop_domain: "store.example.com",
  status: "active",
  scopes: [],
  settings: {},
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
};

const providers: CommerceProviderSpec[] = [
  {
    provider: "shopify",
    name: "Shopify",
    category: "commerce",
    auth_mode: "oauth",
    managed: true,
    runtime_status: "available",
    capabilities: ["orders"],
    required_settings: [
      { key: "shop_domain", label: "Shop domain", required: true },
    ],
    scopes: ["read_orders"],
    sync_objects: ["orders"],
    docs_url: "https://shopify.dev/",
  },
  {
    provider: "bigcommerce",
    name: "BigCommerce",
    category: "commerce",
    auth_mode: "api_key_ref",
    managed: true,
    runtime_status: "partial",
    capabilities: ["orders"],
    required_settings: [
      {
        key: "credential_ref",
        label: "Credential reference",
        required: true,
        secret: true,
      },
    ],
    scopes: [],
    sync_objects: ["orders"],
    docs_url: "https://developer.bigcommerce.com/",
  },
];

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onReload.mockResolvedValue(undefined);
  mocks.listProviders.mockResolvedValue({ data: { items: providers } });
  mocks.syncIntegration.mockResolvedValue({
    data: {
      customers_upserted: 1,
      products_upserted: 2,
      orders_upserted: 3,
    },
  });
  mocks.pauseIntegration.mockResolvedValue({
    data: { ...integration, status: "paused" },
  });
  mocks.disconnectIntegration.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function render(
  intent: CommerceAdministrationIntent,
  integrations: CommerceIntegration[] = [integration],
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <IntegrationsTab
        integrations={integrations}
        err={null}
        canAdmin
        onReload={mocks.onReload}
        administrationIntent={intent}
        onAdministrationIntentResolved={mocks.onResolved}
      />,
    ),
  );
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${name}`);
  }
  return button;
}

function dialogButtonNamed(name: string): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll(
      '[role="dialog"] button, [role="alertdialog"] button',
    ),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing dialog button: ${name}`);
  }
  return button;
}

describe("Commerce administration route intents", () => {
  it("does not sync on render and resolves only after the explicit action succeeds", async () => {
    render({
      task: "sync",
      provider: "bigcommerce",
      integrationId: "store_1",
    });
    expect(document.body.textContent).toContain(
      "opening this route never runs it automatically",
    );
    expect(mocks.syncIntegration).not.toHaveBeenCalled();

    act(() => buttonNamed("Sync now").click());
    await waitFor(() => {
      expect(mocks.syncIntegration).toHaveBeenCalledWith("store_1", {});
      expect(mocks.onResolved).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps an accepted store mutation under the process lifecycle guard", async () => {
    let finishSync: ((value: unknown) => void) | null = null;
    mocks.syncIntegration.mockReturnValue(
      new Promise((resolve) => {
        finishSync = resolve;
      }),
    );
    render({
      task: "sync",
      provider: "bigcommerce",
      integrationId: "store_1",
    });
    act(() => buttonNamed("Sync now").click());
    await waitFor(() => {
      expect(mocks.syncIntegration).toHaveBeenCalledTimes(1);
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      expect.objectContaining({
        label: "Commerce store operation",
        level: "blocking",
        canDiscard: false,
      }),
    ]);

    act(() => {
      finishSync?.({
        data: {
          customers_upserted: 1,
          products_upserted: 2,
          orders_upserted: 3,
        },
      });
    });
    await waitFor(() => {
      expect(mocks.onResolved).toHaveBeenCalledTimes(1);
    });
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("requires confirmation before pause and disconnect mutations", async () => {
    render({
      task: "pause",
      provider: "bigcommerce",
      integrationId: "store_1",
    });
    expect(mocks.pauseIntegration).not.toHaveBeenCalled();
    act(() => buttonNamed("Review pause").click());
    expect(mocks.pauseIntegration).not.toHaveBeenCalled();
    act(() => dialogButtonNamed("Pause integration").click());
    await waitFor(() => {
      expect(mocks.pauseIntegration).toHaveBeenCalledWith("store_1");
      expect(mocks.onResolved).toHaveBeenCalledTimes(1);
    });

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.replaceChildren();
    render({
      task: "disconnect",
      provider: "bigcommerce",
      integrationId: "store_1",
    });
    expect(mocks.disconnectIntegration).not.toHaveBeenCalled();
    act(() => buttonNamed("Review disconnect").click());
    expect(mocks.disconnectIntegration).not.toHaveBeenCalled();
    act(() => dialogButtonNamed("Disconnect").click());
    await waitFor(() => {
      expect(mocks.disconnectIntegration).toHaveBeenCalledWith("store_1");
      expect(mocks.onResolved).toHaveBeenCalledTimes(2);
    });
  });

  it("reopens a connect intent with the requested provider and no mutation", async () => {
    render({ task: "connect", provider: "bigcommerce" });
    await waitFor(() => {
      const select = document.querySelector("select");
      expect(select).toBeInstanceOf(HTMLSelectElement);
      expect((select as HTMLSelectElement).value).toBe("bigcommerce");
    });
    expect(mocks.createIntegration).not.toHaveBeenCalled();
    expect(mocks.startShopifyOAuth).not.toHaveBeenCalled();
    act(() => buttonNamed("Cancel").click());
    await waitFor(() => {
      expect(mocks.onResolved).toHaveBeenCalledTimes(1);
    });
  });

  it("does not open a duplicate connector when the handoff identifies an existing store", () => {
    render({
      task: "connect",
      provider: "bigcommerce",
      integrationId: "store_1",
    });
    expect(document.body.textContent).toContain(
      "No duplicate connection dialog was opened.",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.listProviders).not.toHaveBeenCalled();
    expect(mocks.createIntegration).not.toHaveBeenCalled();
  });

  it("offers canonical reconnect setup instead of invalid actions for a disconnected store", async () => {
    const disconnected = { ...integration, status: "disconnected" };
    render(
      {
        task: "connect",
        provider: "bigcommerce",
        integrationId: "store_1",
      },
      [disconnected],
    );
    await waitFor(() => {
      expect(document.querySelector("select")).toBeInstanceOf(
        HTMLSelectElement,
      );
    });
    expect(document.body.textContent).not.toContain("Sync now");
    expect(document.body.textContent).not.toContain("Review disconnect");
    expect(mocks.createIntegration).not.toHaveBeenCalled();
  });
});
