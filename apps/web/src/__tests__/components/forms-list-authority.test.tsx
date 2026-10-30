// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FormsListClient,
} from "@/app/(dashboard)/app/forms/forms-list-client";
import { FormsPageActions } from "@/app/(dashboard)/app/forms/forms-page-actions";
import type { FormListItem } from "@/lib/forms-types";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createForm: vi.fn(),
  deleteForm: vi.fn(),
  listForms: vi.fn(),
  updateForm: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/forms",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
}));

vi.mock("@/lib/forms-api", () => ({
  createForm: mocks.createForm,
  deleteForm: mocks.deleteForm,
  listForms: mocks.listForms,
  publicFormUrl: (slug: string) => `https://forms.example/${slug}`,
  updateForm: mocks.updateForm,
}));

vi.mock("@/lib/use-forms-origin", () => ({
  useFormsOrigin: () => "https://forms.example",
}));

const form: FormListItem = {
  id: "form-1",
  tenantId: "tenant-1",
  slug: "newsletter",
  name: "Newsletter",
  optInMode: "double",
  structure: { fields: [] },
  settings: { successMessage: "Thanks" },
  status: "draft",
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-08-01T00:00:00Z",
  submissions30d: 0,
  visits30d: 0,
  conversionRate: 0,
};

function identity(role: "owner" | "admin" | "editor" | "viewer") {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "user@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
  };
}

let root: Root | null = null;

async function render(
  component: typeof FormsListClient | typeof FormsPageActions,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        component === FormsListClient
          ? createElement(FormsListClient, { initialForms: [form] })
          : createElement(FormsPageActions),
      ),
    );
  });
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return host;
}

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.listForms.mockResolvedValue([form]);
});

describe("forms list authority", () => {
  it("does not offer creation or selection to a viewer", async () => {
    mocks.whoami.mockResolvedValue(identity("viewer"));
    const actions = await render(FormsPageActions);
    expect(actions.querySelector('a[href="/app/forms/new"]')).toBeNull();
    expect(actions.textContent).toContain("read-only");
    act(() => root?.unmount());
    root = null;

    const list = await render(FormsListClient);
    const boxes = list.querySelectorAll<HTMLInputElement>(
      "input[type=checkbox]",
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(Array.from(boxes).every((box) => box.disabled)).toBe(true);
  });

  it("lets an editor configure forms but keeps delete admin-only", async () => {
    const opened = identity("editor");
    mocks.whoami.mockResolvedValue(opened);
    mocks.whoamiFresh.mockResolvedValue(identity("viewer"));
    const list = await render(FormsListClient);
    const trigger = list.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Newsletter"]',
    );
    expect(trigger).toBeTruthy();
    await act(async () => trigger?.click());
    const duplicate = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === "Duplicate");
    const remove = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === "Delete");
    expect(duplicate?.disabled).toBe(false);
    expect(remove?.disabled).toBe(true);

    await act(async () => duplicate?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.createForm).not.toHaveBeenCalled();
  });

  it("offers destructive form controls to an admin", async () => {
    const opened = identity("admin");
    mocks.whoami.mockResolvedValue(opened);
    mocks.whoamiFresh.mockResolvedValue(opened);
    const list = await render(FormsListClient);
    const trigger = list.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Newsletter"]',
    );
    await act(async () => trigger?.click());
    const remove = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === "Delete");
    expect(remove?.disabled).toBe(false);
  });
});
