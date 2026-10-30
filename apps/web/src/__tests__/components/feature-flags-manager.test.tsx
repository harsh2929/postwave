// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  resolve: vi.fn(),
  successToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, error: vi.fn() },
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/feature-flags-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags-admin-api")>()),
  listFeatureFlagRegistry: mocks.list,
  upsertFeatureFlagOverride: mocks.upsert,
  removeFeatureFlagOverride: mocks.remove,
  resolveFeatureFlag: mocks.resolve,
}));

import { FeatureFlagsManager } from "@/app/(dashboard)/app/workspace-ops/feature-flags-manager";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

const DEFAULT = {
  id: "33333333-3333-4333-8333-333333333333",
  key: "new_composer",
  value: "off",
  note: "Platform rollout",
  tenantId: null,
  isDefault: true,
  enabled: true,
  createdAt: "2026-08-30T10:00:00Z",
  updatedAt: "2026-08-30T10:01:00Z",
};

const OVERRIDE = {
  ...DEFAULT,
  id: "44444444-4444-4444-8444-444444444444",
  value: "on",
  note: "Beta workspace",
  tenantId: IDENTITY.tenant_id,
  isDefault: false,
  updatedAt: "2026-08-30T10:02:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.verifyAdmin.mockResolvedValue(IDENTITY);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("FeatureFlagsManager", () => {
  it("creates a tenant override from a default after acknowledgement and readback", async () => {
    mocks.list
      .mockResolvedValueOnce([DEFAULT])
      .mockResolvedValueOnce([DEFAULT])
      .mockResolvedValueOnce([OVERRIDE, DEFAULT]);
    mocks.upsert.mockResolvedValue({
      id: OVERRIDE.id,
      key: OVERRIDE.key,
      value: OVERRIDE.value,
    });
    const root = render();
    try {
      await flush();
      await click(button("Override"));
      expect(input("feature-flag-key").value).toBe("new_composer");
      await setInput(input("feature-flag-value"), "on");
      await setInput(input("feature-flag-note"), "Beta workspace");
      const acknowledgement = [...document.querySelectorAll("label")].find(
        (label) => label.textContent?.includes("I reviewed the key and value"),
      );
      const checkbox =
        acknowledgement?.querySelector<HTMLInputElement>("input");
      await clickInput(checkbox as HTMLInputElement);
      await click(button("Save override"));
      await flush(8);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(IDENTITY);
      expect(mocks.upsert).toHaveBeenCalledWith({
        key: "new_composer",
        value: "on",
        note: "Beta workspace",
      });
      expect(document.body.textContent).toContain(
        "Tenant override saved and confirmed",
      );
      expect(document.body.textContent).toContain("new_composer = on");
    } finally {
      act(() => root.unmount());
    }
  });

  it("requires typed confirmation before removing an exact override revision", async () => {
    mocks.list
      .mockResolvedValueOnce([OVERRIDE, DEFAULT])
      .mockResolvedValueOnce([OVERRIDE, DEFAULT])
      .mockResolvedValueOnce([DEFAULT]);
    mocks.remove.mockResolvedValue(undefined);
    const root = render();
    try {
      await flush();
      await click(button("Remove"));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).toBeTruthy();
      await setInput(
        dialog?.querySelector<HTMLInputElement>("input") as HTMLInputElement,
        "REMOVE OVERRIDE",
      );
      await click(button("Remove override", dialog as HTMLElement));
      await flush(8);

      expect(mocks.remove).toHaveBeenCalledWith("new_composer");
      expect(document.body.textContent).toContain("Tenant override removed");
      expect(document.body.textContent).not.toContain("Beta workspace");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders an uncached effective-resolution source without mutating", async () => {
    mocks.list.mockResolvedValue([DEFAULT]);
    mocks.resolve.mockResolvedValue({
      key: "new_composer",
      value: "off",
      source: "default",
    });
    const root = render();
    try {
      await flush();
      const resolveInput = document.querySelector<HTMLInputElement>(
        '[aria-label="Flag key to resolve"]',
      );
      await setInput(resolveInput as HTMLInputElement, "new_composer");
      await click(button("Resolve"));
      await flush();
      expect(mocks.resolve).toHaveBeenCalledWith("new_composer");
      expect(document.body.textContent).toContain("default");
      expect(document.body.textContent).toContain("new_composer = off");
      expect(mocks.verifyAdmin).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FeatureFlagsManager, { identity: IDENTITY }),
      ),
    );
  });
  return root;
}

async function flush(times = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function input(id: string): HTMLInputElement {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement))
    throw new Error(`Missing input: ${id}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickInput(target: HTMLInputElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setInput(
  target: HTMLInputElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
