// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectPanel } from "@/components/integrations/connect-panel";
import { ApiError } from "@/lib/api";
import type {
  ProviderSpec,
  SurfaceClient,
} from "@/lib/integrations-surface-api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CREDENTIAL_SPEC: ProviderSpec = {
  provider: "salesforce",
  name: "Salesforce",
  category: "crm",
  auth_mode: "api_key_ref",
  managed: false,
  runtime_status: "available",
  capabilities: [],
  required_settings: [],
  scopes: [],
  sync_objects: [],
  docs_url: "",
};

const INGEST_SPEC: ProviderSpec = {
  ...CREDENTIAL_SPEC,
  provider: "trustpilot",
  name: "Trustpilot",
  category: "reviews",
  auth_mode: "ingest_token_ref",
  sync_model: "postwave_review_ingest",
};

const OAUTH_SPEC: ProviderSpec = {
  ...CREDENTIAL_SPEC,
  provider: "hubspot",
  name: "HubSpot",
  auth_mode: "oauth",
  managed: true,
};

function surface(overrides: Partial<SurfaceClient> = {}): SurfaceClient {
  return {
    providers: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    sync: vi.fn().mockResolvedValue({}),
    pause: vi.fn().mockResolvedValue({}),
    disconnect: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function mount(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return { container, root };
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

let mounted: Root | null = null;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("integration connect authority containment", () => {
  it("locks managed OAuth and orders availability, fresh authority, then navigation", async () => {
    const oauthAvailability = vi.fn().mockResolvedValue({ available: true });
    const oauthStartUrl = vi.fn().mockReturnValue("#oauth-start");
    const beforeWrite = vi.fn().mockResolvedValue(undefined);
    const client = surface({ oauthAvailability, oauthStartUrl });
    const view = mount(
      createElement(ConnectPanel, {
        spec: OAUTH_SPEC,
        surface: client,
        authorityKey: "tenant-a:admin",
        beforeWrite,
        onConnected: vi.fn(),
      }),
    );
    mounted = view.root;
    const connect = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Connect with HubSpot",
    );

    act(() => {
      connect?.click();
      connect?.click();
    });
    await waitFor(() => expect(oauthStartUrl).toHaveBeenCalledTimes(1));

    expect(oauthAvailability).toHaveBeenCalledTimes(1);
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(oauthAvailability.mock.invocationCallOrder[0]).toBeLessThan(
      beforeWrite.mock.invocationCallOrder[0],
    );
    expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
      oauthStartUrl.mock.invocationCallOrder[0],
    );
    expect(oauthAvailability.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(window.location.hash).toBe("#oauth-start");
  });

  it("does not navigate a frozen OAuth intent after authority changes", async () => {
    let releaseAuthority!: () => void;
    const beforeWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseAuthority = resolve;
        }),
    );
    const oauthStartUrl = vi.fn().mockReturnValue("#should-not-open");
    const client = surface({
      oauthAvailability: vi.fn().mockResolvedValue({ available: true }),
      oauthStartUrl,
    });
    const props = {
      spec: OAUTH_SPEC,
      surface: client,
      authorityKey: "tenant-a:admin",
      beforeWrite,
      onConnected: vi.fn(),
    };
    const view = mount(createElement(ConnectPanel, props));
    mounted = view.root;
    const connect = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Connect with HubSpot",
    );

    act(() => connect?.click());
    await waitFor(() => expect(beforeWrite).toHaveBeenCalledTimes(1));
    act(() => {
      view.root.render(
        createElement(ConnectPanel, {
          ...props,
          authorityKey: "tenant-b:admin",
        }),
      );
    });
    await act(async () => releaseAuthority());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(oauthStartUrl).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("synchronously locks credential submits and drops the frozen write after an authority change", async () => {
    let releaseAuthority!: () => void;
    const beforeWrite = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseAuthority = resolve;
        }),
    );
    const create = vi.fn().mockResolvedValue({});
    const client = surface({ create });
    const onConnected = vi.fn();
    const view = mount(
      createElement(ConnectPanel, {
        spec: CREDENTIAL_SPEC,
        surface: client,
        authorityKey: "tenant-a:admin",
        beforeWrite,
        onConnected,
      }),
    );
    mounted = view.root;
    const credential =
      view.container.querySelector<HTMLInputElement>("#connect-credref");
    expect(credential).not.toBeNull();
    act(() => setInput(credential!, "vault://tenant-a/private"));
    const form = credential?.closest("form");

    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();

    act(() => {
      view.root.render(
        createElement(ConnectPanel, {
          spec: CREDENTIAL_SPEC,
          surface: client,
          authorityKey: "tenant-b:admin",
          beforeWrite,
          onConnected,
        }),
      );
    });
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLInputElement>("#connect-credref")
          ?.value,
      ).toBe(""),
    );
    await act(async () => releaseAuthority());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(create).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("reports a credential-write 403 as an admin authorization failure", async () => {
    const create = vi.fn().mockRejectedValue(new ApiError("forbidden", 403));
    const onConnected = vi.fn();
    const view = mount(
      createElement(ConnectPanel, {
        spec: CREDENTIAL_SPEC,
        surface: surface({ create }),
        authorityKey: "tenant-a:admin",
        beforeWrite: vi.fn().mockResolvedValue(undefined),
        onConnected,
      }),
    );
    mounted = view.root;
    const credential =
      view.container.querySelector<HTMLInputElement>("#connect-credref");
    act(() => setInput(credential!, "vault://tenant-a/private"));
    act(() => {
      credential
        ?.closest("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Admin access is required to connect this integration",
      ),
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("purges a reveal-once ingest URL and rotate dialog on authority change", async () => {
    const provisionIngest = vi.fn().mockResolvedValue({
      integration_id: "ingest-1",
      provider: "trustpilot",
      provider_name: "Trustpilot",
      name: "Trustpilot",
      status: "active",
      ingest_path: "/api/v1/review-integrations/webhook-ingest/token-secret",
      ingest_url: "https://example.test/ingest/token-secret",
      ingest_token: "token-secret",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
    const client = surface({ provisionIngest, rotateIngest: vi.fn() });
    const props = {
      spec: INGEST_SPEC,
      surface: client,
      authorityKey: "tenant-a:admin",
      beforeWrite: vi.fn().mockResolvedValue(undefined),
      onConnected: vi.fn(),
    };
    const view = mount(createElement(ConnectPanel, props));
    mounted = view.root;
    const provision = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes("Provision ingest"),
    );
    act(() => provision?.click());
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLInputElement>("#ingest-url")?.value,
      ).toContain("token-secret"),
    );

    const rotate = [...view.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Rotate token",
    );
    act(() => rotate?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Rotate the ingest token?"),
    );

    act(() => {
      view.root.render(
        createElement(ConnectPanel, {
          ...props,
          authorityKey: "tenant-b:admin",
        }),
      );
    });
    await waitFor(() =>
      expect(view.container.textContent).not.toContain("token-secret"),
    );
    expect(document.body.textContent).not.toContain("Rotate the ingest token?");
  });
});
