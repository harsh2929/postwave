// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  identity: {
    user_id: "user-1",
    tenant_id: "tenant-1",
    role: "admin",
    viewer_mode: false,
  },
  whoami: vi.fn(),
  verifyAdmin: vi.fn(),
  list: vi.fn(),
  promotions: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));
vi.mock("@/lib/forms-api", () => ({
  listFormVariants: mocks.list,
  listFormVariantPromotions: mocks.promotions,
  createFormVariant: mocks.create,
  updateFormVariant: mocks.update,
  deleteFormVariant: mocks.remove,
}));

import { VariantsPanel } from "@/app/(dashboard)/app/forms/[id]/_variants-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const variant = {
  id: "variant-1",
  tenantId: "tenant-1",
  formId: "form-1",
  label: "Headline B",
  displayConfig: {},
  trafficPct: 40,
  status: "exploring" as const,
  lastZScore: 0,
  impressions: 0,
  submissions: 0,
  conversionRate: 0,
  createdAt: "2026-08-30T00:00:00Z",
  updatedAt: "2026-08-30T00:00:00Z",
};

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(VariantsPanel, { formId: "form-1" }),
      ),
    );
  });
  return { container, root };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void) {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await settle();
    }
  }
  throw last;
}

function button(name: RegExp): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find((item) =>
    name.test(item.textContent?.trim() ?? ""),
  );
  if (!match) throw new Error(`button not found: ${name}`);
  return match as HTMLButtonElement;
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(mocks.identity);
  mocks.verifyAdmin.mockResolvedValue(mocks.identity);
  mocks.list.mockResolvedValue([variant]);
  mocks.promotions.mockResolvedValue([]);
  mocks.update.mockResolvedValue({
    ...variant,
    label: "Updated",
    trafficPct: 35,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("form variant configuration", () => {
  it("states the runtime hold and updates stored configuration after fresh authority", async () => {
    const view = mount();
    await waitFor(() => expect(button(/^Edit$/u)).toBeTruthy());
    expect(view.container.textContent).toMatch(/no public traffic is split/u);
    expect(document.body.textContent).not.toMatch(/Evaluate now/u);

    act(() => button(/^Edit$/u).click());
    const label = document.querySelector<HTMLInputElement>(
      "#edit-variant-label",
    )!;
    const traffic = document.querySelector<HTMLInputElement>(
      "#edit-variant-traffic",
    )!;
    act(() => {
      setValue(label, "Updated");
      setValue(traffic, "35");
    });
    act(() => button(/^Save configuration$/u).click());

    await waitFor(() => expect(mocks.update).toHaveBeenCalledOnce());
    expect(mocks.verifyAdmin).toHaveBeenCalledWith(mocks.identity);
    expect(mocks.verifyAdmin.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.update.mock.invocationCallOrder[0]!,
    );
    expect(mocks.update).toHaveBeenCalledWith("form-1", "variant-1", {
      label: "Updated",
      trafficPct: 35,
    });
    await waitFor(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(1),
    );
    act(() => view.root.unmount());
  });

  it("keeps readers read-only while preserving variant visibility", async () => {
    mocks.whoami.mockResolvedValueOnce({ ...mocks.identity, role: "viewer" });
    const view = mount();
    await waitFor(() =>
      expect(view.container.textContent).toContain("Headline B"),
    );
    expect(view.container.textContent).toMatch(/read-only/u);
    expect(document.body.textContent).not.toMatch(/\bEdit\b|\bDelete\b/u);
    expect(mocks.verifyAdmin).not.toHaveBeenCalled();
    act(() => view.root.unmount());
  });
});
