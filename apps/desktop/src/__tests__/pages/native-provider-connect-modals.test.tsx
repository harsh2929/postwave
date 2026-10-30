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
  CRMProviderSpec,
  IntegrationCatalogItem,
  SupportProviderSpec,
  WarehouseProviderSpec,
} from "../../lib/api-client";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  createCRMIntegration: vi.fn(),
  listCRMProviders: vi.fn(),
  listSupportProviders: vi.fn(),
  createSupportIntegration: vi.fn(),
  createWarehouseConnection: vi.fn(),
  listWarehouseProviders: vi.fn(),
  validateWarehouseConnection: vi.fn(),
  openUrl: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => {
  const emptyManagedProviderApi = {
    providers: async () => ({ data: { items: [] } }),
    create: async () => ({ data: {} }),
  };
  return {
    analyticsIntegrationsApi: emptyManagedProviderApi,
    commerceApi: {
      listProviders: async () => ({ data: { items: [] } }),
      startShopifyOAuth: async () => ({ data: { authorize_url: "" } }),
      createIntegration: async () => ({ data: {} }),
    },
    crmIntegrationsApi: {
      providers: mocks.listCRMProviders,
      create: mocks.createCRMIntegration,
    },
    leadIntegrationsApi: emptyManagedProviderApi,
    loyaltyIntegrationsApi: emptyManagedProviderApi,
    reviewIntegrationsApi: emptyManagedProviderApi,
    subscriptionIntegrationsApi: emptyManagedProviderApi,
    supportIntegrationsApi: {
      providers: mocks.listSupportProviders,
      create: mocks.createSupportIntegration,
    },
    warehouseApi: {
      providers: mocks.listWarehouseProviders,
      validate: mocks.validateWarehouseConnection,
      createConnection: mocks.createWarehouseConnection,
    },
  };
});

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import {
  CRMConnectModal,
  SupportConnectModal,
  WarehouseConnectModal,
} from "../../pages/integrations/NativeProviderConnectModals";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const item: IntegrationCatalogItem = {
  slug: "hubspot",
  name: "HubSpot",
  category: "crm",
  badge: "native",
  runtime_status: "available",
  summary: "Managed HubSpot CRM connector",
  capabilities: ["contacts", "companies"],
  native: true,
};

const provider: CRMProviderSpec = {
  provider: "hubspot",
  name: "HubSpot",
  category: "crm",
  auth_mode: "private_app",
  managed: true,
  runtime_status: "available",
  sync_model: "incremental_import",
  capabilities: ["contacts", "companies"],
  required_settings: [
    {
      key: "portal_id",
      label: "Portal ID",
      required: true,
      help: "Your numeric HubSpot portal identifier.",
    },
    {
      key: "credentials_ref",
      label: "Credential reference",
      required: true,
      secret: true,
    },
  ],
  optional_settings: [
    { key: "pipeline_id", label: "Pipeline ID", required: false },
  ],
  scopes: ["crm.objects.contacts.read"],
  sync_objects: ["contacts", "companies"],
  docs_url: "https://developers.hubspot.com/docs/api/crm/understanding-the-crm",
};

const warehouseItem: IntegrationCatalogItem = {
  slug: "snowflake",
  name: "Snowflake",
  category: "data_warehouse",
  badge: "native",
  runtime_status: "available",
  summary: "Managed Snowflake warehouse connector",
  capabilities: ["warehouse_export", "warehouse_import"],
  native: true,
};

const legacySupportItem: IntegrationCatalogItem = {
  slug: "zendesk",
  name: "Zendesk",
  category: "support",
  badge: "native",
  runtime_status: "available",
  summary: "Legacy cached native support runtime claim",
  capabilities: ["tickets", "messages", "sync", "backfill"],
  sources: ["support_integration"],
  native: true,
};

const canonicalSupportProvider: SupportProviderSpec = {
  key: "zendesk",
  name: "Zendesk",
  runtime_status: "held",
  hold_code: "support_integration_runtime_held",
};

const richLegacySupportProvider = {
  ...canonicalSupportProvider,
  provider: "zendesk",
  auth_mode: "api_token",
  credentials_ref: "vault://should-never-enter-renderer",
  required_settings: [
    { key: "subdomain", label: "Subdomain", required: true },
    { key: "credentials_ref", label: "Credential reference", required: true },
  ],
  scopes: ["tickets:read"],
  sync_objects: ["tickets", "messages"],
  docs_url: "https://example.test/runnable-support-setup",
};

const warehouseProvider: WarehouseProviderSpec = {
  provider: "snowflake",
  name: "Snowflake",
  auth_mode: "key_pair",
  managed: true,
  runtime_status: "available",
  capabilities: ["warehouse_export", "warehouse_import"],
  required_settings: [
    { key: "account", label: "Account", required: true },
    {
      key: "credentials_ref",
      label: "Credential reference",
      required: true,
      secret: true,
    },
  ],
  optional_settings: [],
  sync_objects: ["profiles", "events", "campaigns"],
  docs_url: "https://docs.snowflake.com/en/user-guide/key-pair-auth",
};

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCRMProviders.mockResolvedValue({ data: { items: [provider] } });
  mocks.listSupportProviders.mockResolvedValue({
    data: {
      items: [canonicalSupportProvider],
      complete: true,
      provenance: { tenant_bound: false, source: "static_server_catalog" },
    },
  });
  mocks.createCRMIntegration.mockResolvedValue({ data: { id: "crm_1" } });
  mocks.listWarehouseProviders.mockResolvedValue({
    data: { items: [warehouseProvider] },
  });
  mocks.validateWarehouseConnection.mockResolvedValue({
    data: { valid: true, warnings: [] },
  });
  mocks.createWarehouseConnection.mockResolvedValue({
    data: { id: "warehouse_1" },
  });
  mocks.openUrl.mockResolvedValue(undefined);
});

describe("SupportConnectModal", () => {
  it("contains a rich legacy provider spec to catalog-only hold copy", async () => {
    const onClose = vi.fn();
    const onConnected = vi.fn();
    render(
      <SupportConnectModal
        item={legacySupportItem}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );

    await waitFor(() => {
      expect(mocks.listSupportProviders).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "Support integration runtime held",
      );
      expect(document.body.textContent).toContain("Reported provider: Zendesk");
    });
    expect(document.body.textContent).toContain(
      "support_integration_runtime_held",
    );
    expect(document.body.textContent).toContain("support_provider_ingress_held");
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("Credential reference");
    expect(document.body.textContent).not.toContain("Save configuration");
    expect(document.body.textContent).not.toContain(
        richLegacySupportProvider.docs_url,
    );
    expect(mocks.createSupportIntegration).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(
      Array.from(document.querySelectorAll("button")).map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["✕", "Close"]);

    act(() => buttonNamed("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.createSupportIntegration).not.toHaveBeenCalled();
  });

  it("rejects a rich legacy provider row without exposing its setup fields", async () => {
    mocks.listSupportProviders.mockResolvedValueOnce({
      data: {
        items: [richLegacySupportProvider],
        complete: true,
        provenance: { tenant_bound: false, source: "static_server_catalog" },
      },
    });
    render(
      <SupportConnectModal
        item={legacySupportItem}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "malformed static catalog metadata",
      );
    });
    expect(document.body.textContent).toContain("Zendesk");
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).not.toContain("Credential reference");
    expect(document.body.textContent).not.toContain(
      richLegacySupportProvider.docs_url,
    );
    expect(mocks.createSupportIntegration).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
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

function inputForLabel(labelText: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(labelText),
  );
  if (!(label instanceof HTMLLabelElement) || !label.htmlFor) {
    throw new Error(`Missing associated label: ${labelText}`);
  }
  const input = document.getElementById(label.htmlFor);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Missing input for label: ${labelText}`);
  }
  return input;
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickSaveConfiguration(): void {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Save configuration",
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("Missing Save configuration button");
  }
  act(() => button.click());
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

describe("CRMConnectModal", () => {
  it("contains a thrown provider-registry request and leaves a cleanly closable dialog", async () => {
    const onClose = vi.fn();
    mocks.listCRMProviders.mockRejectedValue(
      new Error("credential-bearing transport detail must not leak"),
    );
    render(
      <CRMConnectModal item={item} onClose={onClose} onConnected={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "CRM provider setup couldn't be loaded. Check your connection and retry.",
      );
      expect(document.body.textContent).not.toContain("Loading CRM");
    });
    expect(document.body.textContent).not.toContain(
      "credential-bearing transport detail",
    );
    act(() => buttonNamed("Close").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("retries a failed provider registry request without reopening the dialog", async () => {
    mocks.listCRMProviders
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: { items: [provider] } });
    render(
      <CRMConnectModal item={item} onClose={vi.fn()} onConnected={vi.fn()} />,
    );

    await waitFor(() => {
      expect(buttonNamed("Retry setup")).toBeInstanceOf(HTMLButtonElement);
    });
    act(() => buttonNamed("Retry setup").click());

    await waitFor(() => {
      expect(mocks.listCRMProviders).toHaveBeenCalledTimes(2);
      expect(inputForLabel("Portal ID")).toBeInstanceOf(HTMLInputElement);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("renders a labelled dialog with explicitly associated provider fields", async () => {
    render(
      <CRMConnectModal item={item} onClose={vi.fn()} onConnected={vi.fn()} />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Configure HubSpot");
      expect(inputForLabel("Portal ID")).toBeInstanceOf(HTMLInputElement);
    });

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(
      document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Configure HubSpot");
    expect(
      document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("HubSpot CRM import configuration");

    const portalInput = inputForLabel("Portal ID");
    expect(portalInput.placeholder).toBe("12345678");
    const credentialReference = inputForLabel("Credential reference");
    expect(credentialReference.type).toBe("text");
    expect(credentialReference.getAttribute("autocomplete")).toBe("off");
    expect(inputForLabel("Credential reference").placeholder).toBe(
      "vault://integrations/hubspot",
    );
    expect(document.body.textContent).toContain(
      "Never paste an API key, OAuth token, password, private key, or secret JSON here.",
    );
    act(() => buttonNamed("Open HubSpot setup guide").click());
    await waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith(provider.docs_url),
    );
  });

  it("validates required fields and submits trimmed provider configuration", async () => {
    const onClose = vi.fn();
    const onConnected = vi
      .fn()
      .mockRejectedValue(new Error("post-commit refresh failed"));
    render(
      <CRMConnectModal
        item={item}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );

    await waitFor(() => {
      expect(inputForLabel("Portal ID")).toBeInstanceOf(HTMLInputElement);
    });

    clickSaveConfiguration();
    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Portal ID is required.",
      );
      expect(document.activeElement).toBe(inputForLabel("Portal ID"));
    });
    expect(inputForLabel("Portal ID").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(
      inputForLabel("Portal ID").getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(mocks.createCRMIntegration).not.toHaveBeenCalled();

    changeInput(inputForLabel("Portal ID"), " 12345678 ");
    changeInput(
      inputForLabel("Credential reference"),
      "sk_live_this-is-raw-secret-material",
    );
    clickSaveConfiguration();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This looks like raw credential material.",
      );
      expect(document.activeElement).toBe(
        inputForLabel("Credential reference"),
      );
    });
    expect(
      inputForLabel("Credential reference").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(mocks.createCRMIntegration).not.toHaveBeenCalled();

    changeInput(
      inputForLabel("Credential reference"),
      " cred_hubspot_production ",
    );
    changeInput(inputForLabel("Pipeline ID"), "   ");
    clickSaveConfiguration();

    await waitFor(() => {
      expect(mocks.createCRMIntegration).toHaveBeenCalledTimes(1);
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createCRMIntegration).toHaveBeenCalledWith({
      provider: "hubspot",
      name: "HubSpot 12345678",
      credentials_ref: "cred_hubspot_production",
      settings: {
        portal_id: "12345678",
      },
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "HubSpot configuration saved",
        detail: expect.stringContaining("Confirm account identity"),
      }),
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(inputForLabel("Portal ID").value).toBe("");
    expect(inputForLabel("Credential reference").value).toBe("");
  });

  it("permits hide but requires explicit zeroizing discard before local or destructive close", async () => {
    const onClose = vi.fn();
    render(
      <CRMConnectModal item={item} onClose={onClose} onConnected={vi.fn()} />,
    );
    await waitFor(() => {
      expect(inputForLabel("Portal ID")).toBeInstanceOf(HTMLInputElement);
    });

    changeInput(inputForLabel("Portal ID"), "12345678");
    changeInput(
      inputForLabel("Credential reference"),
      "cred_hubspot_production",
    );

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "HubSpot CRM credentials",
        level: "blocking",
        canSave: false,
        canDiscard: true,
        canRecover: false,
      },
    ]);
    await expect(
      inspectLifecycle({
        ...quitIntent,
        kind: "close-window",
        disposition: "hide",
      }),
    ).resolves.toEqual([]);

    act(() => buttonNamed("Cancel").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Discard provider credentials?",
    );
    act(() => buttonNamed("Keep editing").click());
    expect(inputForLabel("Credential reference").value).toBe(
      "cred_hubspot_production",
    );

    act(() => buttonNamed("Cancel").click());
    act(() => buttonNamed("Discard credentials").click());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(inputForLabel("Portal ID").value).toBe("");
    expect(inputForLabel("Credential reference").value).toBe("");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("single-flights a thrown request, blocks destructive lifecycle, and retains the retryable draft", async () => {
    let rejectRequest: ((reason?: unknown) => void) | null = null;
    const onClose = vi.fn();
    mocks.createCRMIntegration.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    render(
      <CRMConnectModal item={item} onClose={onClose} onConnected={vi.fn()} />,
    );
    await waitFor(() => {
      expect(inputForLabel("Portal ID")).toBeInstanceOf(HTMLInputElement);
    });
    changeInput(inputForLabel("Portal ID"), "12345678");
    changeInput(
      inputForLabel("Credential reference"),
      "cred_hubspot_production",
    );

    const connect = buttonNamed("Save configuration");
    act(() => {
      connect.click();
      connect.click();
    });
    await waitFor(() => {
      expect(mocks.createCRMIntegration).toHaveBeenCalledTimes(1);
      expect(buttonNamed("Saving...").disabled).toBe(true);
    });
    const concerns = await inspectLifecycle(quitIntent);
    expect(concerns.length).toBeGreaterThanOrEqual(1);
    expect(concerns.every((concern) => concern.level === "blocking")).toBe(
      true,
    );
    expect(concerns.every((concern) => !concern.canDiscard)).toBe(true);
    const headerClose = document.querySelector(".modal-close");
    if (!(headerClose instanceof HTMLButtonElement)) {
      throw new Error("Missing modal close button");
    }
    expect(headerClose.disabled).toBe(true);
    act(() => headerClose.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      rejectRequest?.(new Error("cred_hubspot_production must not leak"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(buttonNamed("Save configuration").disabled).toBe(false);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "HubSpot configuration couldn't be saved. Check your connection and retry.",
      );
    });
    expect(document.body.textContent).not.toContain("must not leak");
    expect(inputForLabel("Credential reference").value).toBe(
      "cred_hubspot_production",
    );
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      expect.objectContaining({ canDiscard: true }),
    ]);
  });
});

describe("WarehouseConnectModal", () => {
  it("requires an explicit validate, review, then create sequence", async () => {
    const onClose = vi.fn();
    const onConnected = vi.fn().mockResolvedValue(undefined);
    mocks.validateWarehouseConnection.mockResolvedValue({
      data: {
        valid: true,
        warnings: ["The selected role can also read an unused schema."],
      },
    });

    render(
      <WarehouseConnectModal
        item={warehouseItem}
        onClose={onClose}
        onConnected={onConnected}
      />,
    );
    await waitFor(() => {
      expect(inputForLabel("Account")).toBeInstanceOf(HTMLInputElement);
    });
    changeInput(inputForLabel("Account"), " xy12345.us-east-1 ");
    changeInput(
      inputForLabel("Credential reference"),
      " vault://warehouse/snowflake ",
    );

    act(() => buttonNamed("Validate connection").click());
    await waitFor(() => {
      expect(mocks.validateWarehouseConnection).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "Validation passed — review before creating",
      );
      expect(document.body.textContent).toContain(
        "The selected role can also read an unused schema.",
      );
    });
    expect(mocks.createWarehouseConnection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "No connection has been created.",
    );
    expect(document.body.textContent).not.toContain(
      "vault://warehouse/snowflake",
    );
    expect(mocks.validateWarehouseConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "snowflake",
        direction: "bidirectional",
        credentials_ref: "vault://warehouse/snowflake",
        config: {
          account: "xy12345.us-east-1",
        },
        object_selection: ["profiles", "events", "campaigns"],
        cadence: "manual",
        backfill_days: 90,
      }),
    );

    act(() => buttonNamed("Save reviewed configuration").click());
    await waitFor(() => {
      expect(mocks.createWarehouseConnection).toHaveBeenCalledTimes(1);
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createWarehouseConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "snowflake",
        credentials_ref: "vault://warehouse/snowflake",
      }),
    );
  });
});
