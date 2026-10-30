// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listTypes: vi.fn(),
  getType: vi.fn(),
  createType: vi.fn(),
  updateType: vi.fn(),
  deleteType: vi.fn(),
  listRecords: vi.fn(),
  searchRecords: vi.fn(),
  getRecord: vi.fn(),
  upsertRecord: vi.fn(),
  deleteRecord: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/custom-objects",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/custom-objects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/custom-objects-api")>()),
  listCustomObjectTypes: mocks.listTypes,
  getCustomObjectType: mocks.getType,
  createCustomObjectType: mocks.createType,
  updateCustomObjectType: mocks.updateType,
  deleteCustomObjectType: mocks.deleteType,
  listCustomObjectRecords: mocks.listRecords,
  searchCustomObjectRecords: mocks.searchRecords,
  getCustomObjectRecord: mocks.getRecord,
  upsertCustomObjectRecord: mocks.upsertRecord,
  deleteCustomObjectRecord: mocks.deleteRecord,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}));

import { ApiError } from "@/lib/api";
import type {
  CustomObjectRecord,
  CustomObjectType,
} from "@/lib/custom-objects-api";
// The route wrapper intentionally defers this protected workspace with
// `next/dynamic({ ssr: false })`. happy-dom does not consistently hydrate that
// cold boundary, so behavioral coverage mounts the real client directly.
import { CustomObjectsClient as Page } from "@/app/(dashboard)/app/custom-objects/custom-objects-client";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const TYPE = "33333333-3333-4333-8333-333333333333";
const RECORD = "44444444-4444-4444-8444-444444444444";
const CREATED = "2026-08-29T09:00:00Z";
const UPDATED = "2026-08-29T10:00:00Z";

function me(role: "owner" | "admin" | "editor" | "viewer" = "owner") {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
  };
}

function objectType(
  override: Partial<CustomObjectType> = {},
): CustomObjectType {
  return {
    id: TYPE,
    tenantId: TENANT,
    key: "support_ticket",
    label: "Support ticket",
    primaryKey: "external_id",
    schema: {
      type: "object",
      properties: { priority: { type: "string" } },
    },
    status: "active",
    version: 3,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...override,
  };
}

function record(
  override: Partial<CustomObjectRecord> = {},
): CustomObjectRecord {
  return {
    id: RECORD,
    tenantId: TENANT,
    objectTypeId: TYPE,
    externalId: "ticket-42",
    properties: { priority: "high", subject: "Printer" },
    version: 2,
    createdAt: CREATED,
    updatedAt: UPDATED,
    ...override,
  };
}

async function flush(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function clickButton(label: string) {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  expect(button, `button named ${label}`).toBeTruthy();
  await act(async () => {
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return button as HTMLButtonElement;
}

async function fillLabel(labelText: string, value: string) {
  const label = [...document.querySelectorAll<HTMLLabelElement>("label")].find(
    (candidate) => candidate.textContent?.trim() === labelText,
  );
  expect(label, `label named ${labelText}`).toBeTruthy();
  const field = document.getElementById(label?.htmlFor ?? "") as
    | HTMLInputElement
    | HTMLTextAreaElement
    | null;
  expect(field).toBeTruthy();
  const prototype =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
    field?.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(me());
  mocks.listTypes.mockResolvedValue([objectType()]);
  mocks.getType.mockResolvedValue(objectType());
  mocks.createType.mockResolvedValue(objectType({ version: 1 }));
  mocks.updateType.mockResolvedValue(objectType({ version: 4 }));
  mocks.deleteType.mockResolvedValue(undefined);
  mocks.listRecords.mockResolvedValue({
    items: [record()],
    limit: 100,
    hasMore: false,
  });
  mocks.searchRecords.mockResolvedValue({
    items: [record()],
    limit: 100,
    hasMore: false,
  });
  mocks.getRecord.mockResolvedValue(record());
  mocks.upsertRecord.mockResolvedValue(record({ version: 3 }));
  mocks.deleteRecord.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("custom-object control plane", () => {
  it("does not request object data when workspace verification fails", async () => {
    mocks.whoami.mockRejectedValue(new ApiError("signed out", 401));
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "Could not verify the active account and workspace.",
      );
      expect(mocks.listTypes).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("honors effective viewer mode and exposes no mutation controls", async () => {
    mocks.whoami.mockResolvedValue({
      ...me("owner"),
      effective_role: "viewer",
      viewer_mode: true,
    });
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain("Read-only access");
      expect(container.textContent).toContain("Support ticket");
      expect(container.textContent).not.toContain("New object type");
      expect(
        [...container.querySelectorAll("button")].some((button) =>
          /^(edit|delete)$/iu.test(button.textContent?.trim() ?? ""),
        ),
      ).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("reauthorizes and submits a complete type-creation intent", async () => {
    const { root } = await renderPage(Page);
    try {
      await clickButton("New object type");
      await fillLabel("Type key", "booking");
      await fillLabel("Display label", "Booking");
      await clickButton("Create type");
      await flush();

      expect(mocks.whoami).toHaveBeenCalledTimes(2);
      expect(mocks.createType).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: expect.objectContaining({
            tenantId: TENANT,
            userId: USER,
            role: "owner",
          }),
          key: "booking",
          label: "Booking",
          primaryKey: "external_id",
          schema: { type: "object", properties: {} },
          idempotencyKey: expect.any(String),
        }),
      );
      expect(mocks.listTypes.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Custom object type created.",
      );
    } finally {
      unmount(root);
    }
  });

  it("reloads and blocks an edit when the loaded version conflicts", async () => {
    mocks.updateType.mockRejectedValue(
      new ApiError("stale", 409, { error: { code: "stale_write" } }),
    );
    const { root } = await renderPage(Page);
    try {
      await clickButton("Edit");
      await fillLabel("Display label", "Customer ticket");
      await clickButton("Save new version");
      await flush();

      expect(mocks.getType).toHaveBeenCalledWith({
        tenantId: TENANT,
        id: TYPE,
      });
      expect(mocks.updateType).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "This item changed after you opened it.",
      );
      expect(mocks.listTypes.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      unmount(root);
    }
  });

  it("browses records and sends exact filters through the search client", async () => {
    const { root } = await renderPage(Page);
    try {
      await clickButton("Browse records");
      await flush();
      expect(mocks.listRecords).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT, typeId: TYPE, limit: 100 }),
      );

      await fillLabel("Exact property", "customer_ref");
      await fillLabel("Exact value", "private@example.test");
      await clickButton("Search");
      await flush();

      expect(mocks.searchRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          typeId: TYPE,
          property: "customer_ref",
          value: "private@example.test",
          limit: 100,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain("ticket-42");
    } finally {
      unmount(root);
    }
  });

  it("keeps disabled records inspectable while removing create and edit", async () => {
    mocks.listTypes.mockResolvedValue([objectType({ status: "disabled" })]);
    const { root } = await renderPage(Page);
    try {
      await clickButton("Browse records");
      await flush();
      expect(document.body.textContent).toContain("Record writes disabled");
      expect(document.body.textContent).toContain("ticket-42");
      expect(document.body.textContent).not.toContain("New record");
      const editButtons = [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Edit",
      );
      expect(editButtons).toHaveLength(1);
    } finally {
      unmount(root);
    }
  });
});
