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

import type { CommerceProviderSpec } from "../../lib/api-client";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  createIntegration: vi.fn(),
  listProviders: vi.fn(),
  openUrl: vi.fn(),
  startShopifyOAuth: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  commerceApi: {
    createIntegration: mocks.createIntegration,
    listProviders: mocks.listProviders,
    startShopifyOAuth: mocks.startShopifyOAuth,
  },
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: vi.fn(),
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { StoreConnectModal } from "../../components/commerce/IntegrationsTab";

const shopify: CommerceProviderSpec = {
  provider: "shopify",
  name: "Shopify",
  category: "commerce",
  auth_mode: "oauth",
  managed: true,
  runtime_status: "available",
  sync_model: "webhook",
  capabilities: ["commerce"],
  required_settings: [
    {
      key: "shop_domain",
      label: "Shop domain",
      required: true,
    },
  ],
  scopes: ["read_orders"],
  sync_objects: ["customers", "orders"],
  docs_url: "https://shopify.dev/",
};

const foundation: CommerceProviderSpec = {
  provider: "bigcommerce",
  name: "BigCommerce",
  category: "commerce",
  auth_mode: "api_key_ref",
  managed: true,
  runtime_status: "partial",
  sync_model: "postwave_commerce_ingest",
  capabilities: ["commerce"],
  required_settings: [
    {
      key: "credential_ref",
      label: "Credential reference",
      required: true,
      secret: true,
    },
  ],
  scopes: [],
  sync_objects: ["customers", "orders"],
  docs_url: "https://developer.bigcommerce.com/",
};

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
  mocks.listProviders.mockResolvedValue({
    data: { items: [shopify, foundation] },
  });
  mocks.startShopifyOAuth.mockResolvedValue({
    data: { authorize_url: "https://accounts.shopify.test/oauth" },
  });
  mocks.createIntegration.mockResolvedValue({ data: { id: "commerce_1" } });
  mocks.openUrl.mockResolvedValue(undefined);
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

function field(labelText: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(labelText),
  );
  const control = label?.htmlFor
    ? document.getElementById(label.htmlFor)
    : null;
  if (!(control instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${labelText}`);
  }
  return control;
}

function providerSelect(): HTMLSelectElement {
  const select = document.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("Missing provider select");
  }
  return select;
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

function chooseProvider(provider: string): void {
  const select = providerSelect();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, provider);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
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

describe("StoreConnectModal credential lifecycle", () => {
  it("contains a thrown provider-registry request and leaves a cleanly closable dialog", async () => {
    const onClose = vi.fn();
    mocks.listProviders.mockRejectedValue(
      new Error("credential-bearing transport detail must not leak"),
    );
    render(<StoreConnectModal onClose={onClose} onConnected={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Store provider setup couldn't be loaded. Check your connection and retry.",
      );
      expect(providerSelect().disabled).toBe(false);
    });
    expect(document.body.textContent).not.toContain(
      "credential-bearing transport detail",
    );
    act(() => buttonNamed("Cancel").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires explicit discard for provider switches and local close", async () => {
    const onClose = vi.fn();
    render(<StoreConnectModal onClose={onClose} onConnected={vi.fn()} />);
    await waitFor(() => {
      expect(field("Shop domain")).toBeInstanceOf(HTMLInputElement);
    });
    changeInput(field("Shop domain"), "shop.example.myshopify.com");

    chooseProvider("bigcommerce");
    expect(providerSelect().value).toBe("shopify");
    expect(document.body.textContent).toContain(
      "Discard credentials and switch provider?",
    );
    act(() => buttonNamed("Keep editing").click());
    expect(field("Shop domain").value).toBe("shop.example.myshopify.com");

    chooseProvider("bigcommerce");
    act(() => buttonNamed("Discard and switch").click());
    await waitFor(() => {
      expect(providerSelect().value).toBe("bigcommerce");
      expect(field("Credential reference").value).toBe("");
    });
    changeInput(field("Credential reference"), "vault://commerce/production");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      expect.objectContaining({
        label: "Store connection credentials",
        level: "blocking",
        canDiscard: true,
      }),
    ]);

    act(() => buttonNamed("Cancel").click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Discard store credentials?");
    act(() => buttonNamed("Discard credentials").click());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(field("Credential reference").value).toBe("");
  });

  it("closes and clears a committed connection even when the post-commit refresh fails", async () => {
    const onClose = vi.fn();
    const onConnected = vi
      .fn()
      .mockRejectedValue(new Error("post-commit refresh failed"));
    render(<StoreConnectModal onClose={onClose} onConnected={onConnected} />);
    await waitFor(() => {
      expect(field("Shop domain")).toBeInstanceOf(HTMLInputElement);
    });
    chooseProvider("bigcommerce");
    await waitFor(() => {
      expect(field("Credential reference")).toBeInstanceOf(HTMLInputElement);
    });
    changeInput(field("Credential reference"), "vault://commerce/production");
    act(() => buttonNamed("Save connection").click());

    await waitFor(() => {
      expect(mocks.createIntegration).toHaveBeenCalledTimes(1);
      expect(onConnected).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(mocks.createIntegration).toHaveBeenCalledWith({
      provider: "bigcommerce",
      settings: { credential_ref: "vault://commerce/production" },
      credential_ref: "vault://commerce/production",
    });
    expect(field("Credential reference").value).toBe("");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "BigCommerce connection saved.",
    );
    expect(document.body.textContent).not.toContain(
      "post-commit refresh failed",
    );
  });

  it("single-flights thrown OAuth requests and keeps the draft retryable", async () => {
    let rejectRequest: ((reason?: unknown) => void) | null = null;
    const onClose = vi.fn();
    mocks.startShopifyOAuth.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );
    render(<StoreConnectModal onClose={onClose} onConnected={vi.fn()} />);
    await waitFor(() => {
      expect(field("Shop domain")).toBeInstanceOf(HTMLInputElement);
    });
    changeInput(field("Shop domain"), "shop.example.myshopify.com");

    const connect = buttonNamed("Open Shopify authorization");
    act(() => {
      connect.click();
      connect.click();
    });
    await waitFor(() => {
      expect(mocks.startShopifyOAuth).toHaveBeenCalledTimes(1);
      expect(buttonNamed("Connecting...").disabled).toBe(false);
      expect(buttonNamed("Connecting...").getAttribute("aria-disabled")).toBe(
        "true",
      );
    });
    const concerns = await inspectLifecycle(quitIntent);
    expect(concerns.length).toBeGreaterThanOrEqual(1);
    expect(concerns.every((concern) => !concern.canDiscard)).toBe(true);
    const headerClose = document.querySelector(".modal-close");
    if (!(headerClose instanceof HTMLButtonElement)) {
      throw new Error("Missing modal close button");
    }
    act(() => headerClose.click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      rejectRequest?.(new Error("vault://commerce/production must not leak"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(buttonNamed("Open Shopify authorization").disabled).toBe(false);
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "The store connection couldn't be completed.",
      );
    });
    expect(document.body.textContent).not.toContain("must not leak");
    expect(field("Shop domain").value).toBe("shop.example.myshopify.com");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });
});
