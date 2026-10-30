// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CrmLifecyclePanel } from "@/components/integrations/crm-lifecycle-panel";
import { ApiError } from "@/lib/api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  providers: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  sync: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  disconnect: vi.fn(),
  oauthAvailability: vi.fn(),
  oauthStartUrl: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/crm-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm-api")>()),
  crmApi: {
    providers: mocks.providers,
    list: mocks.list,
    create: mocks.create,
    sync: mocks.sync,
    pause: mocks.pause,
    resume: mocks.resume,
    disconnect: mocks.disconnect,
    oauthAvailability: mocks.oauthAvailability,
    oauthStartUrl: mocks.oauthStartUrl,
  },
}));

const ADMIN = {
  user_id: "admin-user",
  tenant_id: "tenant-a",
  email: "admin@example.test",
  role: "admin" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Acme",
  workspace_slug: "acme",
};

const PROVIDER = {
  provider: "salesforce",
  name: "Salesforce",
  category: "crm",
  auth_mode: "api_key_ref",
  managed: false,
  runtime_status: "available",
  capabilities: ["contacts"],
  required_settings: [],
  scopes: [],
  sync_objects: ["contact"],
  docs_url: "",
};

const CONNECTION = {
  id: "crm-1",
  provider: "salesforce",
  name: "Sensitive production CRM",
  status: "active",
  scopes: [],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { client, container, root };
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function button(label: string) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
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
beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(ADMIN);
  mocks.whoamiFresh.mockResolvedValue(ADMIN);
  mocks.providers.mockResolvedValue([PROVIDER]);
  mocks.list.mockResolvedValue([CONNECTION]);
  mocks.create.mockResolvedValue(CONNECTION);
  mocks.sync.mockResolvedValue({ ok: true });
  mocks.pause.mockResolvedValue({ ok: true });
  mocks.resume.mockResolvedValue({ ok: true });
  mocks.disconnect.mockResolvedValue({ ok: true });
  mocks.oauthAvailability.mockResolvedValue({ available: true });
  mocks.oauthStartUrl.mockReturnValue("#crm-oauth");
});
afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("CRM lifecycle authority containment", () => {
  it("does not request admin-scoped providers or connections for a viewer", async () => {
    mocks.whoami.mockResolvedValue({
      ...ADMIN,
      role: "viewer",
      effective_role: "viewer",
    });
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("reports an identity error without sending protected CRM reads", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity unavailable"));
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Couldn’t verify CRM access",
      ),
    );
    expect(view.container.textContent).toContain("No CRM request was made");
    expect(mocks.providers).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("renders a protected CRM 403 as unavailable rather than as an empty list", async () => {
    mocks.list.mockRejectedValue(new ApiError("forbidden", 403));
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;

    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "You need admin access to manage CRM integrations",
      ),
    );
    expect(view.container.textContent).not.toContain(
      "No CRM integrations connected",
    );
    expect(view.container.textContent).not.toContain(
      "Sensitive production CRM",
    );
    expect(button("Connect CRM")).toBeUndefined();
  });

  it("closes the connect form and purges its credential when provider metadata becomes unavailable", async () => {
    mocks.providers
      .mockResolvedValueOnce([PROVIDER])
      .mockRejectedValueOnce(new Error("registry offline"));
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Connect CRM")).toBeDefined());

    act(() => button("Connect CRM")?.click());
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLInputElement>("#crm-connect-credref"),
      ).not.toBeNull(),
    );
    act(() =>
      setInput(
        view.container.querySelector<HTMLInputElement>("#crm-connect-credref")!,
        "vault://tenant-a/private-registry-failure",
      ),
    );

    act(() => button("Refresh")?.click());
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "provider requirements could not be loaded",
      ),
    );

    expect(button("Connect CRM")).toBeUndefined();
    expect(view.container.querySelector("#crm-connect-credref")).toBeNull();
    expect(view.container.textContent).not.toContain(
      "vault://tenant-a/private-registry-failure",
    );
    expect(view.container.textContent).toContain("Sensitive production CRM");
  });

  it("locks a double-click and re-verifies exact admin authority before sync", async () => {
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Sync now")).toBeDefined());

    act(() => {
      button("Sync now")?.click();
      button("Sync now")?.click();
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.sync).not.toHaveBeenCalled();

    await act(async () => resolveFresh(ADMIN));
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(1));
    expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sync.mock.invocationCallOrder[0],
    );
    expect(mocks.sync.mock.calls[0]?.[0]).toBe("crm-1");
    expect(mocks.sync.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a frozen sync and purges connection data when authority changes", async () => {
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Sync now")).toBeDefined());

    act(() => button("Sync now")?.click());
    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    await act(async () => resolveFresh(ADMIN));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(mocks.sync).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain(
      "Sensitive production CRM",
    );
    expect(
      view.client.getQueryData([
        "integrations",
        "tenant-a",
        "admin",
        "admin-user",
        "durable-mode",
        "crm",
      ]),
    ).toBeUndefined();
  });

  it("locks CRM credential submission and drops its secret intent on an authority change", async () => {
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Connect CRM")).toBeDefined());

    act(() => button("Connect CRM")?.click());
    await waitFor(() =>
      expect(
        view.container.querySelector<HTMLInputElement>("#crm-connect-credref"),
      ).not.toBeNull(),
    );
    const credential = view.container.querySelector<HTMLInputElement>(
      "#crm-connect-credref",
    );
    act(() => setInput(credential!, "vault://tenant-a/private-crm"));
    const form = credential?.closest("form");
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();

    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    await act(async () => resolveFresh(ADMIN));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(mocks.create).not.toHaveBeenCalled();
    expect(view.container.textContent).not.toContain(
      "vault://tenant-a/private-crm",
    );
    expect(view.container.querySelector("#crm-connect-credref")).toBeNull();
  });

  it("locks managed CRM OAuth and suppresses navigation after authority changes", async () => {
    mocks.providers.mockResolvedValue([
      { ...PROVIDER, auth_mode: "oauth", managed: true },
    ]);
    let resolveFresh!: (value: typeof ADMIN) => void;
    mocks.whoamiFresh.mockReturnValue(
      new Promise<typeof ADMIN>((resolve) => {
        resolveFresh = resolve;
      }),
    );
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Connect CRM")).toBeDefined());

    act(() => button("Connect CRM")?.click());
    await waitFor(() =>
      expect(button("Connect with Salesforce")).toBeDefined(),
    );
    act(() => {
      button("Connect with Salesforce")?.click();
      button("Connect with Salesforce")?.click();
    });
    await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
    expect(mocks.oauthAvailability).toHaveBeenCalledTimes(1);
    expect(mocks.oauthAvailability.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(mocks.oauthAvailability.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.whoamiFresh.mock.invocationCallOrder[0],
    );

    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );
    await act(async () => resolveFresh(ADMIN));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(window.location.hash).toBe("");
  });

  it("closes and purges a CRM disconnect confirmation when authority changes", async () => {
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Disconnect")).toBeDefined());

    act(() => button("Disconnect")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Disconnect this CRM?"),
    );
    await act(async () => {
      view.client.setQueryData(["auth-me"], {
        ...ADMIN,
        role: "viewer",
        effective_role: "viewer",
      });
    });
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "Owner or admin access required",
      ),
    );

    expect(document.body.textContent).not.toContain("Disconnect this CRM?");
    expect(document.body.textContent).not.toContain("Sensitive production CRM");
  });

  it("closes a CRM disconnect confirmation when a refreshed protected read is rejected", async () => {
    mocks.list
      .mockResolvedValueOnce([CONNECTION])
      .mockRejectedValueOnce(new ApiError("forbidden", 403));
    const view = mount(createElement(CrmLifecyclePanel));
    mounted = view.root;
    await waitFor(() => expect(button("Disconnect")).toBeDefined());

    act(() => button("Disconnect")?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("Disconnect this CRM?"),
    );
    act(() => button("Refresh")?.click());
    await waitFor(() =>
      expect(view.container.textContent).toContain(
        "You need admin access to manage CRM integrations",
      ),
    );

    expect(document.body.textContent).not.toContain("Disconnect this CRM?");
    expect(document.body.textContent).not.toContain("Sensitive production CRM");
  });
});
