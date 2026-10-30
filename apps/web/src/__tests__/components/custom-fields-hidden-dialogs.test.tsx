// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CustomFieldsSettingsPage from "@/app/(dashboard)/app/settings/custom-fields/page";
import type { MeResponse } from "@/lib/auth-api";
import type { CustomField } from "@/lib/custom-fields-api";
import { qk } from "@/lib/query-keys";

const mocks = vi.hoisted(() => ({
  createCustomField: vi.fn(),
  deleteCustomField: vi.fn(),
  getCustomFieldReferences: vi.fn(),
  getCustomFieldUsage: vi.fn(),
  getCustomFieldsMode: vi.fn(),
  listCustomFields: vi.fn(),
  updateCustomField: vi.fn(),
  updateCustomFieldsMode: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});

vi.mock("@/lib/custom-fields-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/custom-fields-api")>();
  return {
    ...actual,
    createCustomField: mocks.createCustomField,
    deleteCustomField: mocks.deleteCustomField,
    getCustomFieldReferences: mocks.getCustomFieldReferences,
    getCustomFieldUsage: mocks.getCustomFieldUsage,
    getCustomFieldsMode: mocks.getCustomFieldsMode,
    listCustomFields: mocks.listCustomFields,
    updateCustomField: mocks.updateCustomField,
    updateCustomFieldsMode: mocks.updateCustomFieldsMode,
  };
});

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FIELD: CustomField = {
  id: "field-1",
  tenant_id: "tenant-1",
  key: "loyalty_tier",
  label: "Loyalty tier",
  type: "string",
  config: { pii_flag: false },
  created_at: "2026-08-20T00:00:00.000Z",
  updated_at: "2026-08-20T00:00:00.000Z",
};

const OWNER: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "local",
  email_verified: true,
  workspace_name: "Custom field matrix",
  workspace_slug: "demo",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function renderPage(): { client: QueryClient; root: Root } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CustomFieldsSettingsPage),
      ),
    );
  });
  return { client, root };
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function dialog(): HTMLElement {
  const match = document.querySelector('[role="dialog"]');
  if (!(match instanceof HTMLElement)) throw new Error("Dialog not found");
  return match;
}

function input(id: string): HTMLInputElement {
  const match = document.getElementById(id);
  if (!(match instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  return match;
}

function change(target: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
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

beforeEach(() => {
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.listCustomFields.mockResolvedValue([FIELD]);
  mocks.getCustomFieldsMode.mockResolvedValue({ custom_fields_mode: "auto" });
  mocks.getCustomFieldUsage.mockResolvedValue({
    total_subscribers: 10,
    fields: [{ key: FIELD.key, label: FIELD.label, filled: 4, rate: 0.4 }],
  });
  mocks.getCustomFieldReferences.mockResolvedValue({
    segments: [{ id: "segment-1", name: "VIP segment" }],
    flows: [],
    forms: [],
  });
  mocks.createCustomField.mockResolvedValue(FIELD);
  mocks.updateCustomField.mockResolvedValue(FIELD);
  mocks.deleteCustomField.mockResolvedValue({ ok: true });
  mocks.updateCustomFieldsMode.mockResolvedValue({
    custom_fields_mode: "strict",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("custom-field hidden mutation states", () => {
  it("pauses tenant reads and mutations until failed identity can be retried", async () => {
    mocks.whoami.mockRejectedValueOnce(new Error("Identity unavailable"));
    const { client, root } = renderPage();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Workspace identity could not be loaded",
        );
      });
      expect(mocks.listCustomFields).not.toHaveBeenCalled();
      expect(mocks.getCustomFieldsMode).not.toHaveBeenCalled();
      expect(mocks.getCustomFieldUsage).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Add field");
      expect(button("Retry identity").className).toContain("min-h-11");

      await act(async () => button("Retry identity").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain("loyalty_tier");
      });
      // The page imports its API module at the call site, so the best-effort
      // usage read can land a turn after the registry renders.
      await waitFor(() => {
        expect(mocks.listCustomFields).toHaveBeenCalledTimes(1);
        expect(mocks.getCustomFieldsMode).toHaveBeenCalledTimes(1);
        expect(mocks.getCustomFieldUsage).toHaveBeenCalledTimes(1);
      });
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keeps a registry read failure visible, mobile-sized, and retryable", async () => {
    mocks.listCustomFields.mockRejectedValueOnce(
      new Error("Registry temporarily unavailable"),
    );
    const { client, root } = renderPage();
    try {
      await waitFor(() => {
        const alert = document.querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain(
          "Registry temporarily unavailable",
        );
      });
      const retry = button("Retry");
      expect(retry.className).toContain("min-h-11");
      expect(
        document.querySelector('[role="alert"] .text-destructive-emphasis'),
      ).not.toBeNull();

      await act(async () => retry.click());
      await waitFor(() => {
        expect(document.body.textContent).toContain("loyalty_tier");
      });
      expect(mocks.listCustomFields).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keys reads by effective role and disables every mutation in viewer mode", async () => {
    mocks.whoami.mockResolvedValueOnce({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "owner@example.test",
      role: "owner",
      effective_role: "viewer",
      viewer_mode: true,
      auth_provider: "local",
      email_verified: true,
      workspace_name: "Custom field matrix",
      workspace_slug: "demo",
    });
    const { client, root } = renderPage();
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("loyalty_tier");
      });
      expect(button("Add field").disabled).toBe(true);
      expect(button("Edit").disabled).toBe(true);
      expect(button("Delete").disabled).toBe(true);
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
        ).every((radio) => radio.disabled),
      ).toBe(true);
      expect(
        client
          .getQueryCache()
          .getAll()
          .some((query) => query.queryKey.includes("viewer")),
      ).toBe(true);
      expect(mocks.createCustomField).not.toHaveBeenCalled();
      expect(mocks.updateCustomField).not.toHaveBeenCalled();
      expect(mocks.deleteCustomField).not.toHaveBeenCalled();
      expect(mocks.updateCustomFieldsMode).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("allows editor field CRUD while keeping validator mode admin-only", async () => {
    const editor: MeResponse = {
      ...OWNER,
      role: "editor",
      effective_role: "editor",
    };
    mocks.whoami.mockResolvedValue(editor);
    mocks.whoamiFresh.mockResolvedValue(editor);
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Edit")).toBeDefined());
      expect(button("Add field").disabled).toBe(false);
      expect(button("Edit").disabled).toBe(false);
      expect(button("Delete").disabled).toBe(false);
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
        ).every((radio) => radio.disabled),
      ).toBe(true);
      expect(document.body.textContent).toContain(
        "Editors can create, edit, and delete fields",
      );
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("clears drafts and old-principal cache on an authority downgrade", async () => {
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Add field")).toBeDefined());
      await act(async () => button("Add field").click());
      await act(async () => change(input("cf-label"), "Private draft"));
      expect(
        client
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              JSON.stringify(query.queryKey).includes(
                "custom-fields-authority",
              ) && query.queryKey.includes("owner"),
          ),
      ).toBe(true);

      await act(async () => {
        client.setQueryData(qk.authMe(), {
          ...OWNER,
          effective_role: "viewer",
          viewer_mode: true,
        });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(document.querySelector("#new-custom-field")).toBeNull(),
      );
      expect(
        client
          .getQueryCache()
          .getAll()
          .some(
            (query) =>
              JSON.stringify(query.queryKey).includes(
                "custom-fields-authority",
              ) && query.queryKey.includes("owner"),
          ),
      ).toBe(false);

      await act(async () => {
        client.setQueryData(qk.authMe(), OWNER);
        await Promise.resolve();
      });
      await waitFor(() => expect(button("Add field").disabled).toBe(false));
      await act(async () => button("Add field").click());
      expect(input("cf-label").value).toBe("");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("rechecks exact authority once and stops before create transport on mismatch", async () => {
    mocks.whoamiFresh.mockResolvedValue({
      ...OWNER,
      tenant_id: "tenant-2",
    });
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Add field")).toBeDefined());
      await act(async () => button("Add field").click());
      const form = document.querySelector("#new-custom-field form");
      if (!(form instanceof HTMLFormElement)) {
        throw new Error("Create form not found");
      }
      await act(async () => change(input("cf-key"), "member_level"));
      await act(async () => change(input("cf-label"), "Member level"));
      await act(async () => {
        submit(form);
        submit(form);
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "custom-field authority changed",
        );
      });
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.createCustomField).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("validates create inline, dedupes a pending write, and keeps failure retryable", async () => {
    const pending = deferred<CustomField>();
    const created = { ...FIELD, id: "field-created", key: "member_level" };
    mocks.createCustomField
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(created);
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Add field")).toBeDefined());
      await act(async () => button("Add field").click());
      const form = document.querySelector("#new-custom-field form");
      if (!(form instanceof HTMLFormElement)) {
        throw new Error("Create form not found");
      }
      await act(async () => change(input("cf-key"), "Bad key"));
      await act(async () => change(input("cf-label"), "Member level"));
      await act(async () => submit(form));
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "lowercase letters",
      );
      expect(mocks.createCustomField).not.toHaveBeenCalled();

      await act(async () => change(input("cf-key"), "member_level"));
      await act(async () => {
        submit(form);
        submit(form);
      });
      await waitFor(() =>
        expect(mocks.createCustomField).toHaveBeenCalledTimes(1),
      );
      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.createCustomField.mock.invocationCallOrder[0]!,
      );
      expect(input("cf-key").disabled).toBe(true);
      expect(button("Creating…").getAttribute("aria-busy")).toBe("true");

      await act(async () => pending.reject(new Error("Key already exists.")));
      await waitFor(() => {
        const alert = document.querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain("Key already exists");
        expect(document.activeElement).toBe(alert);
      });
      expect(document.querySelector("#new-custom-field")).not.toBeNull();

      await act(async () => submit(form));
      await waitFor(() =>
        expect(document.querySelector("#new-custom-field")).toBeNull(),
      );
      expect(mocks.createCustomField).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(button("Add field")).toBeDefined());
      expect(document.activeElement).toBe(button("Add field"));
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("freezes edit during a same-tick write and retries a focused inline error", async () => {
    const pending = deferred<CustomField>();
    const updated = { ...FIELD, label: "Member tier" };
    mocks.updateCustomField
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(updated);
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Edit")).toBeDefined());
      const trigger = button("Edit");
      await act(async () => trigger.click());
      expect(input("edit-label").value).toBe(FIELD.label);
      const piiTarget = Array.from(dialog().querySelectorAll("label")).find(
        (candidate) => candidate.textContent?.includes("personal data"),
      );
      expect(piiTarget?.className).toContain("min-h-11");
      expect(button("Save changes", dialog()).disabled).toBe(true);
      await act(async () => button("Cancel", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      await act(async () => trigger.click());
      await act(async () => change(input("edit-label"), "  Member tier  "));
      const form = dialog().querySelector("form");
      if (!(form instanceof HTMLFormElement)) {
        throw new Error("Edit form not found");
      }
      const cancel = button("Cancel", dialog());
      const close = button("Close", dialog());
      await act(async () => {
        submit(form);
        cancel.click();
        submit(form);
      });
      await waitFor(() =>
        expect(mocks.updateCustomField).toHaveBeenCalledTimes(1),
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateCustomField.mock.invocationCallOrder[0]!,
      );
      expect(mocks.updateCustomField).toHaveBeenCalledWith(
        FIELD.id,
        {
          label: "Member tier",
          config: { pii_flag: false },
        },
        expect.any(AbortSignal),
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(input("edit-label").disabled).toBe(true);
      expect(cancel.disabled).toBe(true);
      expect(close.disabled).toBe(true);
      expect(close.getAttribute("aria-disabled")).toBe("true");
      await act(async () => close.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () =>
        pending.reject(new Error("Field changed elsewhere.")),
      );
      await waitFor(() => {
        const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain("changed elsewhere");
        expect(document.activeElement).toBe(alert);
      });
      expect(input("edit-label").value).toBe("  Member tier  ");

      await act(async () => submit(form));
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.updateCustomField).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("shows delete references, rolls back failure, retries once, and focuses a safe survivor", async () => {
    const pending = deferred<unknown>();
    mocks.deleteCustomField
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ok: true });
    const { client, root } = renderPage();
    try {
      await waitFor(() => expect(button("Delete")).toBeDefined());
      await act(async () => button("Delete").click());
      await waitFor(() => {
        expect(dialog().textContent).toContain("1 object");
        expect(dialog().textContent).toContain("VIP segment");
      });
      await act(async () => {
        const confirm = button("Delete", dialog());
        confirm.click();
        confirm.click();
      });
      await waitFor(() =>
        expect(mocks.deleteCustomField).toHaveBeenCalledTimes(1),
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.deleteCustomField.mock.invocationCallOrder[0]!,
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => pending.reject(new Error("Reference changed.")));
      await waitFor(() => {
        const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain("Reference changed");
        expect(document.activeElement).toBe(alert);
      });

      mocks.listCustomFields.mockResolvedValue([]);
      await act(async () => button("Delete", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.deleteCustomField).toHaveBeenCalledTimes(2);
      const heading = Array.from(document.querySelectorAll("h2")).find(
        (candidate) => candidate.textContent === "Declared fields",
      );
      await waitFor(() => expect(document.activeElement).toBe(heading));
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("rolls back validator-mode failure and retries from the same confirmation", async () => {
    const pending = deferred<{ custom_fields_mode?: "strict" }>();
    mocks.updateCustomFieldsMode
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ custom_fields_mode: "strict" });
    const { client, root } = renderPage();
    try {
      await waitFor(() =>
        expect(document.querySelectorAll('[role="radio"]').length).toBe(3),
      );
      const strict = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).find((candidate) => candidate.textContent?.includes("Strict"));
      if (!strict) throw new Error("Strict mode radio not found");
      const auto = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).find((candidate) => candidate.textContent?.includes("Auto-register"));
      expect(auto?.className).toContain("border-primary");
      expect(auto?.className).not.toContain("border-accent");
      await act(async () => strict.click());
      expect(dialog().textContent).toContain("starts REJECTING");
      await act(async () => {
        const confirm = button("Switch mode", dialog());
        confirm.click();
        confirm.click();
      });
      await waitFor(() =>
        expect(mocks.updateCustomFieldsMode).toHaveBeenCalledTimes(1),
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.updateCustomFieldsMode.mock.invocationCallOrder[0]!,
      );
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(strict.disabled).toBe(true);

      await act(async () =>
        pending.reject(new Error("Mode update conflicted.")),
      );
      await waitFor(() => {
        const alert = dialog().querySelector<HTMLElement>('[role="alert"]');
        expect(alert?.textContent).toContain("update conflicted");
        expect(document.activeElement).toBe(alert);
      });
      expect(strict.getAttribute("aria-checked")).toBe("false");

      mocks.getCustomFieldsMode.mockResolvedValue({
        custom_fields_mode: "strict",
      });
      await act(async () => button("Switch mode", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      expect(mocks.updateCustomFieldsMode).toHaveBeenCalledTimes(2);
      expect(strict.getAttribute("aria-checked")).toBe("true");
      // The radio is enabled in the same commit that closes the dialog; the
      // dialog hands focus back on its close-autofocus tick, not before.
      expect(strict.disabled).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(strict));

      const off = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
      ).find((candidate) => candidate.textContent?.includes("Off"));
      if (!off) throw new Error("Off mode radio not found");
      await act(async () => off.click());
      expect(dialog().textContent).toContain("disables validation entirely");
      await act(async () => button("Cancel", dialog()).click());
      await waitFor(() =>
        expect(document.querySelector('[role="dialog"]')).toBeNull(),
      );
      await waitFor(() => expect(document.activeElement).toBe(off));
      expect(mocks.updateCustomFieldsMode).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});
