// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as AuthApi from "@/lib/auth-api";
import type * as InboundApi from "@/lib/inbound-routes-admin-api";
import type { MeResponse } from "@/lib/auth-api";
import type {
  InboundEmailEndpointReveal,
  InboundRoute,
} from "@/lib/inbound-routes-admin-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listRoutes: vi.fn(),
  createRoute: vi.fn(),
  updateRoute: vi.fn(),
  deleteRoute: vi.fn(),
  fingerprint: vi.fn(),
  getEndpoint: vi.fn(),
  rotateEndpoint: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthApi>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/inbound-routes-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof InboundApi>()),
  listInboundRoutesStrict: mocks.listRoutes,
  createInboundRouteStrict: mocks.createRoute,
  updateInboundRouteStrict: mocks.updateRoute,
  deleteInboundRouteStrict: mocks.deleteRoute,
  inboundRouteWriteFingerprint: mocks.fingerprint,
  getInboundEmailEndpointStrict: mocks.getEndpoint,
  rotateInboundEmailEndpointStrict: mocks.rotateEndpoint,
  previewInboundRoutesStrict: mocks.preview,
}));

import { InboundEndpointPanel } from "@/app/(dashboard)/app/routing/inbound-routes/inbound-endpoint-panel";
import { InboundRouteEditor } from "@/app/(dashboard)/app/routing/inbound-routes/inbound-route-editor";
import { InboundRoutesClient } from "@/app/(dashboard)/app/routing/inbound-routes/inbound-routes-client";
import { endpointMetadata } from "@/lib/inbound-routes-admin-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const ROUTE_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_ID = "00000000-0000-4000-8000-000000000003";
const ENDPOINT_ID = "00000000-0000-4000-8000-000000000004";
const SECRET = `iem_${"a".repeat(48)}`;
const roots: Root[] = [];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "inbound-admin",
    tenant_id: TENANT_ID,
    email: "inbound-admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Inbound workspace",
    workspace_slug: "inbound-workspace",
    ...overrides,
  };
}

function route(overrides: Partial<InboundRoute> = {}): InboundRoute {
  return {
    id: ROUTE_ID,
    name: "Support route",
    priority: 100,
    stopOnMatch: true,
    enabled: false,
    matchRecipient: "support@*",
    matchSubjectPrefix: "",
    matchFromDomain: "",
    actions: [
      {
        kind: "webhook",
        url: "https://hooks.example.test/inbound",
        extra: { custom: "safe" },
        hasStoredHmacSecret: true,
        sourceIndex: 0,
      },
    ],
    matchCount: 0,
    actionRetryMax: 0,
    actionRetryBackoffSeconds: 2,
    updatedAt: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

const reveal: InboundEmailEndpointReveal = {
  id: ENDPOINT_ID,
  tenantId: TENANT_ID,
  slug: "0123456789abcdef",
  secretConfigured: true,
  rotationRequired: false,
  secretRotatedAt: "2026-08-30T10:00:00Z",
  createdAt: "2026-08-29T10:00:00Z",
  secret: SECRET,
};

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

function control(labelText: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim().startsWith(labelText),
  );
  const input = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(input instanceof HTMLInputElement))
    throw new Error(`Missing input for ${labelText}`);
  return input;
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, networkMode: "always" },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  return { container, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(me());
  mocks.whoamiFresh.mockResolvedValue(me());
  mocks.listRoutes.mockResolvedValue([route()]);
  mocks.getEndpoint.mockResolvedValue(null);
  mocks.rotateEndpoint.mockResolvedValue(reveal);
  mocks.fingerprint.mockResolvedValue("a".repeat(64));
  mocks.createRoute.mockResolvedValue(CREATED_ID);
  mocks.preview.mockResolvedValue({
    matches: [],
    evaluated: 1,
    noMatches: true,
  });
  vi.stubGlobal("crypto", {
    randomUUID: () => "00000000-0000-4000-8000-000000000099",
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("inbound route control plane", () => {
  it("does not request admin route or endpoint data for a non-admin", async () => {
    mocks.whoami.mockResolvedValue(
      me({ role: "viewer", effective_role: "viewer" }),
    );
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(container.textContent).toContain("Administrator access is required"),
    );
    expect(mocks.listRoutes).not.toHaveBeenCalled();
    expect(mocks.getEndpoint).not.toHaveBeenCalled();
  });

  it("loads safe rows and derives detail from a fresh catalogue read", async () => {
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Inspect Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Inspect Support route"]',
        ) as HTMLButtonElement
      ).click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("HMAC configured · value withheld"),
    );
    expect(mocks.listRoutes).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("stored-secret");
  });

  it("creates a disabled route and verifies its fresh receipt", async () => {
    const created = route({
      id: CREATED_ID,
      name: "New disabled route",
      matchRecipient: "*",
      actions: [],
    });
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route(), created]);
    await render(<InboundRoutesClient />);
    await eventually(() => expect(button("New disabled route")).toBeDefined());
    await act(async () => button("New disabled route")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Create inbound route"),
    );
    await act(async () => setValue(control("Name"), "New disabled route"));
    await act(async () => button("Create route")!.click());
    await eventually(() => expect(mocks.createRoute).toHaveBeenCalledTimes(1));
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.createRoute.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT_ID,
      draft: { enabled: false, name: "New disabled route", actions: [] },
    });
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Create inbound route"),
    );
  });

  it("rechecks and verifies a full route update", async () => {
    const updated = route({ name: "Updated support route" });
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([updated]);
    mocks.updateRoute.mockResolvedValue(undefined);
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Edit Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Edit Support route"]',
        ) as HTMLButtonElement
      ).click();
    });
    await eventually(() => expect(control("Name").value).toBe("Support route"));
    await act(async () => setValue(control("Name"), "Updated support route"));
    await act(async () => button("Save changes")!.click());
    await eventually(() => expect(mocks.updateRoute).toHaveBeenCalledTimes(1));
    expect(mocks.updateRoute.mock.calls[0]?.[0]).toMatchObject({
      tenantId: TENANT_ID,
      routeId: ROUTE_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft: { name: "Updated support route" },
    });
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Save changes"),
    );
  });

  it("reconciles an uncertain update from exact fresh state without replaying it", async () => {
    const updated = route({
      name: "Updated support route",
      updatedAt: "2026-08-30T10:01:00Z",
    });
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([updated]);
    mocks.updateRoute.mockRejectedValueOnce(new Error("Response was lost"));
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Edit Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () =>
      (
        container.querySelector(
          'button[aria-label="Edit Support route"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await act(async () => setValue(control("Name"), "Updated support route"));
    await act(async () => button("Save changes")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Response was lost"),
    );
    await act(async () => button("Save changes")!.click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Save changes"),
    );
    expect(mocks.updateRoute).toHaveBeenCalledTimes(1);
  });

  it("creates a disabled secret-stripped duplicate after a fresh comparison", async () => {
    const copy = route({
      id: CREATED_ID,
      name: "Support route (copy)",
      priority: 101,
      actions: [
        {
          ...route().actions[0]!,
          hasStoredHmacSecret: false,
        },
      ],
    });
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route(), copy]);
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Duplicate Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Duplicate Support route"]',
        ) as HTMLButtonElement
      ).click();
    });
    await eventually(() => expect(button("Create disabled copy")).toBeDefined());
    await act(async () => button("Create disabled copy")!.click());
    await eventually(() => expect(mocks.createRoute).toHaveBeenCalledTimes(1));
    const request = mocks.createRoute.mock.calls[0]?.[0];
    expect(request.draft.enabled).toBe(false);
    expect(request.draft.actions[0]).not.toHaveProperty("preserveHmacFromIndex");
    expect(request.draft.actions[0]).not.toHaveProperty("hmacSecret");
  });

  it("requires the exact route name and verifies deletion absence", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([]);
    mocks.deleteRoute.mockResolvedValue(undefined);
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Delete Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () => {
      (
        container.querySelector(
          'button[aria-label="Delete Support route"]',
        ) as HTMLButtonElement
      ).click();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("Type Support route to confirm"),
    );
    expect(button("Delete route")?.disabled).toBe(true);
    const deleteLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("Support route"),
    ) as HTMLLabelElement;
    const deleteInput = document.getElementById(deleteLabel.htmlFor) as HTMLInputElement;
    await act(async () => setValue(deleteInput, "Support route"));
    await act(async () => button("Delete route")!.click());
    await eventually(() => expect(mocks.deleteRoute).toHaveBeenCalledTimes(1));
    expect(mocks.deleteRoute.mock.calls[0]?.[0]).toMatchObject({ routeId: ROUTE_ID });
  });

  it("reconciles an uncertain delete from fresh absence without replaying it", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([]);
    mocks.deleteRoute.mockRejectedValueOnce(new Error("Response was lost"));
    const { container } = await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(
        container.querySelector('button[aria-label="Delete Support route"]'),
      ).not.toBeNull(),
    );
    await act(async () =>
      (
        container.querySelector(
          'button[aria-label="Delete Support route"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const deleteLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("Support route"),
    ) as HTMLLabelElement;
    await act(async () =>
      setValue(
        document.getElementById(deleteLabel.htmlFor) as HTMLInputElement,
        "Support route",
      ),
    );
    await act(async () => button("Delete route")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Response was lost"),
    );
    await act(async () => button("Delete route")!.click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Delete inbound route?"),
    );
    expect(mocks.deleteRoute).toHaveBeenCalledTimes(1);
  });

  it("requires explicit discard and clears a local HMAC action draft", async () => {
    const onClose = vi.fn();
    await render(
      <InboundRouteEditor
        state={{ mode: "edit", route: route({ actions: [{ ...route().actions[0]!, hasStoredHmacSecret: false }] }) }}
        onClose={onClose}
        onSave={vi.fn()}
      />,
    );
    await eventually(() => expect(control("HMAC signing secret")).toBeDefined());
    await act(async () => setValue(control("HMAC signing secret"), "draft-secret"));
    expect(control("HMAC signing secret").value).toBe("draft-secret");
    await act(async () => button("Cancel")!.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Type DISCARD to confirm"),
    );
    const discardLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("DISCARD"),
    ) as HTMLLabelElement;
    const discardInput = document.getElementById(discardLabel.htmlFor) as HTMLInputElement;
    await act(async () => setValue(discardInput, "DISCARD"));
    await act(async () => button("Discard draft")!.click());
    await eventually(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("draft-secret");
  });

  it("freezes matcher, action, and secret controls during a captured save", async () => {
    let release: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await render(
      <InboundRouteEditor
        state={{ mode: "edit", route: route() }}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    await eventually(() => expect(control("Name")).toBeDefined());
    await act(async () => setValue(control("Name"), "Captured route"));
    await act(async () => button("Save changes")!.click());
    await eventually(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(control("Name").closest("fieldset")?.disabled).toBe(true);
    expect(control("HMAC signing secret").closest("fieldset")?.disabled).toBe(
      true,
    );
    expect(button("Add action")?.closest("fieldset")?.disabled).toBe(true);
    await act(async () => release?.());
  });

  it("keeps a rotated secret outside query cache until stored or explicitly abandoned", async () => {
    const { client } = await render(
      <InboundEndpointPanel me={me()} queryScope={["scope", TENANT_ID]} />,
    );
    await eventually(() => expect(button("Create endpoint")).toBeDefined());
    const createConfirm = Array.from(document.querySelectorAll("button")).filter(
      (candidate) => candidate.textContent?.trim() === "Create endpoint",
    ).at(-1) as HTMLButtonElement;
    await act(async () => createConfirm.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Type CREATE to confirm"),
    );
    const createLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("CREATE"),
    ) as HTMLLabelElement;
    const createInput = document.getElementById(createLabel.htmlFor) as HTMLInputElement;
    await act(async () => setValue(createInput, "CREATE"));
    const confirmCreate = Array.from(document.querySelectorAll("button")).filter(
      (candidate) => candidate.textContent?.trim() === "Create endpoint",
    ).at(-1) as HTMLButtonElement;
    await act(async () => confirmCreate.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Store this signing secret now"),
    );
    expect(document.body.textContent).not.toContain(SECRET);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
    await act(async () => button("Show")!.click());
    expect(document.body.textContent).toContain(SECRET);
    const storedCheckbox = Array.from(document.querySelectorAll("input")).find(
      (candidate) => candidate.type === "checkbox",
    ) as HTMLInputElement;
    await act(async () => storedCheckbox.click());
    await act(async () => button("Acknowledge and clear")!.click());
    await eventually(() =>
      expect(document.body.textContent).not.toContain("Store this signing secret now"),
    );
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("replays an uncertain endpoint rotation key before changed-metadata preflight", async () => {
    mocks.rotateEndpoint.mockRejectedValueOnce(new Error("Response was lost"));
    await render(
      <InboundEndpointPanel me={me()} queryScope={["scope", TENANT_ID]} />,
    );
    await eventually(() => expect(button("Create endpoint")).toBeDefined());
    await act(async () => button("Create endpoint")!.click());
    const createLabel = Array.from(document.querySelectorAll("label")).find(
      (candidate) => candidate.textContent?.includes("CREATE"),
    ) as HTMLLabelElement;
    await act(async () =>
      setValue(
        document.getElementById(createLabel.htmlFor) as HTMLInputElement,
        "CREATE",
      ),
    );
    const confirmCreate = () =>
      Array.from(document.querySelectorAll("button"))
        .filter((candidate) => candidate.textContent?.trim() === "Create endpoint")
        .at(-1) as HTMLButtonElement;
    await act(async () => confirmCreate().click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Response was lost"),
    );
    mocks.getEndpoint.mockResolvedValueOnce(endpointMetadata(reveal));
    await act(async () => confirmCreate().click());
    await eventually(() =>
      expect(document.body.textContent).toContain("Store this signing secret now"),
    );
    expect(mocks.rotateEndpoint).toHaveBeenCalledTimes(2);
    expect(mocks.rotateEndpoint.mock.calls[0]?.[0].idempotencyKey).toBe(
      mocks.rotateEndpoint.mock.calls[1]?.[0].idempotencyKey,
    );
    // Initial query + first attempt preflight only: the uncertain retry goes
    // straight to idempotent replay so a committed shown-once secret survives.
    expect(mocks.getEndpoint).toHaveBeenCalledTimes(2);
  });
});
