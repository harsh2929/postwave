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
  InboundRoute,
  InboundRouteMatch,
} from "@/lib/inbound-routes-admin-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  listRoutes: vi.fn(),
  updateRoute: vi.fn(),
  reorderRoutes: vi.fn(),
  listMatches: vi.fn(),
  fingerprint: vi.fn(),
  getEndpoint: vi.fn(),
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
  updateInboundRouteStrict: mocks.updateRoute,
  reorderInboundRoutesStrict: mocks.reorderRoutes,
  listInboundRouteMatchesStrict: mocks.listMatches,
  inboundRouteWriteFingerprint: mocks.fingerprint,
  getInboundEmailEndpointStrict: mocks.getEndpoint,
  previewInboundRoutesStrict: mocks.preview,
}));

import { InboundRoutesClient } from "@/app/(dashboard)/app/routing/inbound-routes/inbound-routes-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const FIRST_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_ID = "00000000-0000-4000-8000-000000000003";
const THIRD_ID = "00000000-0000-4000-8000-000000000004";
const roots: Root[] = [];

function me(): MeResponse {
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
  };
}

function route(overrides: Partial<InboundRoute> = {}): InboundRoute {
  return {
    id: FIRST_ID,
    name: "Support route",
    priority: 10,
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

const second = () =>
  route({
    id: SECOND_ID,
    name: "Billing route",
    priority: 20,
    matchRecipient: "billing@*",
    actions: [],
  });
const third = () =>
  route({
    id: THIRD_ID,
    name: "Catch-all route",
    priority: 30,
    matchRecipient: "*",
    actions: [],
  });

function match(overrides: Partial<InboundRouteMatch> = {}): InboundRouteMatch {
  return {
    id: 7,
    routeId: FIRST_ID,
    inboundEmailId: 99,
    recipient: "support@example.test",
    subject: "Re: invoice 42",
    fromEmail: "customer@example.test",
    matchedAt: "2026-08-30T09:30:00Z",
    ...overrides,
  };
}

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

function byLabel<T extends HTMLElement = HTMLElement>(label: string): T | null {
  return document.querySelector<T>(`[aria-label="${label}"]`);
}

function rowNames(): string[] {
  return Array.from(document.querySelectorAll("tbody tr")).map(
    (row) => row.querySelector("td:nth-child(2) .font-medium")?.textContent ?? "",
  );
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
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
  mocks.updateRoute.mockResolvedValue(undefined);
  mocks.reorderRoutes.mockResolvedValue(undefined);
  mocks.listMatches.mockResolvedValue([]);
  mocks.fingerprint.mockResolvedValue("a".repeat(64));
  mocks.getEndpoint.mockResolvedValue(null);
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

describe("inbound route row switch (deliverability-28)", () => {
  it("enables a route from its row by re-sending the reviewed definition and verifies the fresh receipt", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route({ enabled: true })]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLInputElement>("Enable Support route")).not.toBeNull(),
    );
    const toggle = byLabel<HTMLInputElement>("Enable Support route")!;
    expect(toggle.getAttribute("role")).toBe("switch");
    expect(toggle.checked).toBe(false);

    await act(async () => toggle.click());
    await eventually(() => expect(mocks.updateRoute).toHaveBeenCalledTimes(1));
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    const request = mocks.updateRoute.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      tenantId: TENANT_ID,
      routeId: FIRST_ID,
      expectedUpdatedAt: "2026-08-30T10:00:00Z",
      draft: {
        enabled: true,
        name: "Support route",
        priority: 10,
        stopOnMatch: true,
        matchRecipient: "support@*",
        matchSubjectPrefix: "",
        matchFromDomain: "",
        actionRetryMax: 0,
        actionRetryBackoffSeconds: 2,
        actions: [
          {
            kind: "webhook",
            url: "https://hooks.example.test/inbound",
            extra: { custom: "safe" },
            preserveHmacFromIndex: 0,
          },
        ],
      },
    });
    expect(request.draft.actions[0]).not.toHaveProperty("hmacSecret");

    await eventually(() =>
      expect(byLabel<HTMLInputElement>("Disable Support route")).not.toBeNull(),
    );
    expect(byLabel<HTMLInputElement>("Disable Support route")!.checked).toBe(
      true,
    );
    expect(mocks.listRoutes).toHaveBeenCalledTimes(3);
  });

  it("disables an enabled route with the same full-definition write", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route({ enabled: true })])
      .mockResolvedValueOnce([route({ enabled: true })])
      .mockResolvedValueOnce([route()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLInputElement>("Disable Support route")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLInputElement>("Disable Support route")!.click(),
    );
    await eventually(() => expect(mocks.updateRoute).toHaveBeenCalledTimes(1));
    expect(mocks.updateRoute.mock.calls[0]?.[0]).toMatchObject({
      routeId: FIRST_ID,
      draft: { enabled: false, name: "Support route" },
    });
    await eventually(() =>
      expect(byLabel<HTMLInputElement>("Enable Support route")).not.toBeNull(),
    );
  });

  it("writes nothing when the fresh definition differs from the reviewed row", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route()])
      .mockResolvedValueOnce([route({ matchRecipient: "changed@*" })]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLInputElement>("Enable Support route")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLInputElement>("Enable Support route")!.click(),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "This route changed on the server. Nothing was written",
      ),
    );
    expect(mocks.updateRoute).not.toHaveBeenCalled();
    expect(byLabel<HTMLInputElement>("Enable Support route")!.checked).toBe(
      false,
    );
  });
});

describe("inbound route reorder (deliverability-29)", () => {
  it("moves a route earlier by posting the complete ordered id list and verifies the fresh order", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([second(), route(), third()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Move Billing route earlier")).not.toBeNull(),
    );
    expect(rowNames()).toEqual([
      "Support route",
      "Billing route",
      "Catch-all route",
    ]);

    await act(async () =>
      byLabel<HTMLButtonElement>("Move Billing route earlier")!.click(),
    );
    await eventually(() =>
      expect(mocks.reorderRoutes).toHaveBeenCalledTimes(1),
    );
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.reorderRoutes.mock.calls[0]?.[0]).toEqual({
      routeIds: [SECOND_ID, FIRST_ID, THIRD_ID],
      idempotencyKey: expect.stringMatching(/^inbound-route-reorder-/),
    });
    await eventually(() =>
      expect(rowNames()).toEqual([
        "Billing route",
        "Support route",
        "Catch-all route",
      ]),
    );
  });

  it("moves a route later with the same complete-list write", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([second(), route(), third()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Move Support route later")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLButtonElement>("Move Support route later")!.click(),
    );
    await eventually(() =>
      expect(mocks.reorderRoutes).toHaveBeenCalledTimes(1),
    );
    expect(mocks.reorderRoutes.mock.calls[0]?.[0].routeIds).toEqual([
      SECOND_ID,
      FIRST_ID,
      THIRD_ID,
    ]);
  });

  it("drops a dragged route before its target and posts the resulting complete order", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([route(), second(), third()])
      .mockResolvedValueOnce([third(), route(), second()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(document.querySelectorAll("tbody tr")).toHaveLength(3),
    );
    const rows = document.querySelectorAll("tbody tr");
    const handle = rows[2]!.querySelector("[draggable]")!;
    await act(async () => {
      handle.dispatchEvent(new MouseEvent("dragstart", { bubbles: true }));
    });
    await act(async () => {
      rows[0]!.dispatchEvent(
        new MouseEvent("dragover", {
          bubbles: true,
          cancelable: true,
          clientY: -1,
        }),
      );
    });
    await act(async () => {
      rows[0]!.dispatchEvent(
        new MouseEvent("drop", { bubbles: true, cancelable: true }),
      );
    });
    await eventually(() =>
      expect(mocks.reorderRoutes).toHaveBeenCalledTimes(1),
    );
    expect(mocks.reorderRoutes.mock.calls[0]?.[0].routeIds).toEqual([
      THIRD_ID,
      FIRST_ID,
      SECOND_ID,
    ]);
    await eventually(() =>
      expect(rowNames()).toEqual([
        "Catch-all route",
        "Support route",
        "Billing route",
      ]),
    );
  });

  it("withholds the ends and pauses reordering while a filter narrows the catalogue", async () => {
    mocks.listRoutes.mockResolvedValue([route(), second(), third()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Move Billing route earlier")).not.toBeNull(),
    );
    expect(byLabel<HTMLButtonElement>("Move Support route earlier")!.disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>("Move Catch-all route later")!.disabled).toBe(true);
    expect(byLabel<HTMLButtonElement>("Move Billing route earlier")!.disabled).toBe(false);

    await act(async () =>
      setValue(byLabel<HTMLInputElement>("Search inbound routes")!, "billing"),
    );
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Move Billing route earlier")!.disabled).toBe(true),
    );
    expect(document.body.textContent).toContain(
      "Clear the search and state filter to reorder",
    );
    expect(mocks.reorderRoutes).not.toHaveBeenCalled();
  });

  it("posts nothing when the fresh catalogue order differs from the reviewed one", async () => {
    mocks.listRoutes
      .mockResolvedValueOnce([route(), second()])
      .mockResolvedValueOnce([second(), route()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Move Billing route earlier")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLButtonElement>("Move Billing route earlier")!.click(),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "The route order changed on the server. Nothing was reordered",
      ),
    );
    expect(mocks.reorderRoutes).not.toHaveBeenCalled();
  });
});

describe("inbound route match history (deliverability-32)", () => {
  it("reads the inspected route's newest matches and renders each match", async () => {
    mocks.listMatches.mockResolvedValue([
      match(),
      match({
        id: 6,
        subject: "",
        fromEmail: "other@example.test",
        matchedAt: "2026-08-29T08:00:00Z",
      }),
    ]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Inspect Support route")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLButtonElement>("Inspect Support route")!.click(),
    );
    await eventually(() => expect(mocks.listMatches).toHaveBeenCalledTimes(1));
    expect(mocks.listMatches.mock.calls[0]?.[0]).toMatchObject({
      routeId: FIRST_ID,
      limit: 50,
    });
    await eventually(() =>
      expect(document.body.textContent).toContain("customer@example.test"),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Match history");
    expect(dialog.textContent).toContain("support@example.test");
    expect(dialog.textContent).toContain("Re: invoice 42");
    expect(dialog.textContent).toContain("other@example.test");
    expect(dialog.querySelectorAll("ol li time")).toHaveLength(2);
  });

  it("renders the empty history state as an ordinary outcome, not an error", async () => {
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Inspect Support route")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLButtonElement>("Inspect Support route")!.click(),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain("No matches recorded yet"),
    );
    expect(
      document.querySelector('[role="dialog"] [role="alert"]'),
    ).toBeNull();
  });

  it("renders the server's sentence when history cannot be read and offers a retry", async () => {
    mocks.listMatches
      .mockRejectedValueOnce(new Error("match history unavailable"))
      .mockResolvedValueOnce([match()]);
    await render(<InboundRoutesClient />);
    await eventually(() =>
      expect(byLabel<HTMLButtonElement>("Inspect Support route")).not.toBeNull(),
    );
    await act(async () =>
      byLabel<HTMLButtonElement>("Inspect Support route")!.click(),
    );
    await eventually(() =>
      expect(document.body.textContent).toContain("match history unavailable"),
    );
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Retry history",
    )!;
    await act(async () => retry.click());
    await eventually(() =>
      expect(document.body.textContent).toContain("customer@example.test"),
    );
    expect(mocks.listMatches).toHaveBeenCalledTimes(2);
  });
});
