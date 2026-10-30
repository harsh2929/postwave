// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Integrations — support / customer-service provider connect (desktop parity
// platform-91). Desktop lists the static provider catalog
// (GET /api/v1/support-integrations/providers) and holds the connect submit;
// the server answers POST /api/v1/support-integrations with 503
// support_integration_runtime_held. What must be true on web: the dialog
// reads the catalog, renders desktop's held copy with both hold codes, the
// submit is disabled with the reason attached, no credential field is shown,
// nothing but the catalog GET leaves the client — and with the flag simulated
// as lifted, the same dialog POSTs the create with the desktop input shape.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ available: false }));
const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, get: mocks.apiGet, post: mocks.apiPost },
  };
});
vi.mock("@/lib/support-integration-operational-availability", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/support-integration-operational-availability")
  >();
  return {
    ...actual,
    get SUPPORT_INTEGRATION_RUNTIME_AVAILABLE() {
      return state.available;
    },
    requireSupportRuntime: () => {
      if (!state.available) throw new actual.SupportRuntimeHeldError();
    },
  };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { SupportProviderConnectDialog } from "@/components/integrations/support-provider-connect-dialog";
import {
  heldConnectSurfaceForCatalogItem,
  isConnectableCategory,
  surfaceForCatalogItem,
} from "@/lib/catalog-connect-map";
import { SupportRuntimeHeldError } from "@/lib/support-integration-operational-availability";
import {
  connectSupportIntegration,
  decodeSupportProviderCatalog,
  listSupportProviders,
} from "@/lib/support-integrations-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG = {
  items: [
    { key: "zendesk", name: "Zendesk", runtime_status: "held", hold_code: "support_integration_runtime_held" },
    { key: "gorgias", name: "Gorgias", runtime_status: "held", hold_code: "support_integration_runtime_held" },
  ],
  complete: true,
  provenance: { tenant_bound: false, source: "static_server_catalog" },
};
const ITEM = { slug: "zendesk", name: "Zendesk" };

const roots: Root[] = [];

function render(props: Partial<Parameters<typeof SupportProviderConnectDialog>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SupportProviderConnectDialog, {
          item: ITEM,
          open: true,
          onOpenChange,
          ...props,
        }),
      ),
    );
  });
  return { onOpenChange };
}

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Button "${label}" not found`);
  return found;
}

async function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(el, value);
  await act(async () => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.available = false;
  mocks.apiGet.mockResolvedValue(CATALOG);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("support provider connect — held (platform-91)", () => {
  it("lists the static catalog and holds the submit with desktop's copy; only the catalog GET is sent", async () => {
    render();
    await flush();
    expect(mocks.apiGet).toHaveBeenCalledTimes(1);
    expect(mocks.apiGet.mock.calls[0]?.[0]).toBe("/api/v1/support-integrations/providers");
    expect(mocks.apiGet.mock.calls[0]?.[1]).toMatchObject({ requireOnline: true, maxAttempts: 1 });

    const text = document.body.textContent ?? "";
    expect(text).toContain("Support integration runtime held");
    expect(text).toContain(
      "Catalog entry: Zendesk. Credentials and provider lifecycle actions are not available in this release.",
    );
    expect(text).toContain("Reported provider: Zendesk. This label is static catalog metadata, not proof of a connection or enabled runtime.");
    expect(text).toContain(
      "No credential field is shown and no create, ingest, sync, backfill, pause, disconnect, or run-history request will be sent.",
    );
    expect(text).toContain("support_integration_runtime_held");
    expect(text).toContain("support_provider_ingress_held");
    expect(document.querySelector("input")).toBeNull();

    const submit = button("Connect — unavailable");
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("title")).toBe(
      "Support provider runtime is release-held. No support runtime request was sent.",
    );
    const reasonId = submit.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toContain(
      "Support provider runtime is release-held. No support runtime request was sent.",
    );
    await act(async () => {
      submit.click();
    });
    await flush();
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("says when the catalog entry is not a reported provider", async () => {
    render({ item: { slug: "freshdesk", name: "Freshdesk" } });
    await flush();
    expect(document.body.textContent).toContain(
      "Freshdesk is not present in the reported support-provider catalog.",
    );
    expect(button("Connect — unavailable").disabled).toBe(true);
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("refuses a malformed catalog instead of rendering an empty one", async () => {
    mocks.apiGet.mockResolvedValueOnce({ ...CATALOG, items: [{ ...CATALOG.items[0], runtime_status: "available" }] });
    await expect(listSupportProviders()).rejects.toThrow(/static held projection/);
    expect(decodeSupportProviderCatalog({ items: [], complete: true, provenance: { tenant_bound: true, source: "static_server_catalog" } })).toBeNull();
    expect(decodeSupportProviderCatalog(CATALOG)?.items.map((i) => i.key)).toEqual(["zendesk", "gorgias"]);
  });

  it("refuses the connect transport before fetch while held", async () => {
    await expect(
      connectSupportIntegration({ provider: "zendesk", credentials_ref: "vault:1" }),
    ).rejects.toBeInstanceOf(SupportRuntimeHeldError);
    await expect(
      connectSupportIntegration({ provider: "zendesk" }),
    ).rejects.toMatchObject({ code: "support_integration_runtime_held", status: 503 });
    expect(mocks.apiPost).not.toHaveBeenCalled();
  });

  it("resolves customer_service to the held support surface without making it a live CatalogSurface", () => {
    const item = { category: "customer_service", sources: ["commerce"] };
    expect(surfaceForCatalogItem(item)).toBeNull();
    expect(isConnectableCategory("customer_service")).toBe(false);
    const held = heldConnectSurfaceForCatalogItem(item);
    expect(held).toMatchObject({
      key: "support",
      label: "Support",
      holdCode: "support_integration_runtime_held",
      dialog: "SupportProviderConnectDialog",
    });
    expect(held?.providers).toBe(listSupportProviders);
    expect(held?.connect).toBe(connectSupportIntegration);
    expect(heldConnectSurfaceForCatalogItem({ category: "crm" })).toBeNull();
  });
});

describe("support provider connect — flag simulated as lifted", () => {
  beforeEach(() => {
    state.available = true;
  });

  it("shows the connection form and POSTs the desktop input shape", async () => {
    mocks.apiPost.mockResolvedValueOnce({ id: "sint_1", provider: "zendesk", name: "Zendesk EU", status: "connected" });
    const onConnected = vi.fn();
    const { onOpenChange } = render({ onConnected });
    await flush();
    expect(document.body.textContent).toContain("Connect Zendesk");
    expect(document.body.textContent).not.toContain("No credential field is shown");
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs).toHaveLength(2);
    await setValue(inputs[0]!, "Zendesk EU");
    await setValue(inputs[1]!, " vault:zendesk/eu ");
    const connect = button("Connect");
    expect(connect.disabled).toBe(false);
    expect(connect.getAttribute("aria-describedby")).toBeNull();

    await act(async () => {
      connect.click();
    });
    await flush();

    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.apiPost.mock.calls[0]?.[0]).toBe("/api/v1/support-integrations");
    expect(mocks.apiPost.mock.calls[0]?.[1]).toEqual({
      provider: "zendesk",
      name: "Zendesk EU",
      status: "connected",
      scopes: [],
      credentials_ref: "vault:zendesk/eu",
      settings: {},
    });
    expect(mocks.apiPost.mock.calls[0]?.[2]).toMatchObject({ requireOnline: true, maxAttempts: 1 });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Zendesk connection saved");
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders the server's refusal when the lifted call is still declined", async () => {
    mocks.apiPost.mockRejectedValueOnce(new Error("Support-provider configuration is release-held"));
    render();
    await flush();
    await act(async () => {
      button("Connect").click();
    });
    await flush();
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith("Support-provider configuration is release-held");
  });
});
