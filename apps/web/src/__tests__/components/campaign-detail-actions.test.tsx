// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CampaignDetailActions } from "@/app/(dashboard)/app/campaigns/[id]/campaign-detail-actions";
import type { Campaign } from "@/lib/campaigns-api";
import type { MeResponse } from "@/lib/auth-api";

const apiMocks = vi.hoisted(() => ({
  fetchTextAuthed: vi.fn(),
  resendUnopened: vi.fn(),
  saveCampaignAsTemplate: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, whoamiFresh: apiMocks.whoamiFresh };
});

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return { ...actual, fetchTextAuthed: apiMocks.fetchTextAuthed };
});

vi.mock("@/lib/campaigns-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/campaigns-api")>(
    "@/lib/campaigns-api",
  );
  return {
    ...actual,
    resendUnopened: apiMocks.resendUnopened,
    saveCampaignAsTemplate: apiMocks.saveCampaignAsTemplate,
  };
});

vi.mock("@/lib/download", () => ({ downloadTextFile: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const CAMPAIGN = {
  id: "campaign-actions",
  tenant_id: "tenant-1",
  name: "Delivered weekly signal",
  subject: "The first subject",
  status: "sent",
  body_html: "<h1>Delivered</h1>",
  created_at: "2026-08-20T09:00:00Z",
  updated_at: "2026-08-21T09:00:00Z",
} as Campaign;

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "editor@example.test",
  role: "editor",
  effective_role: "editor",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Workspace",
  workspace_slug: "workspace",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function button(text: string, scope: ParentNode = document) {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

function dialog() {
  const match = document.querySelector('[role="dialog"]');
  if (!(match instanceof HTMLElement)) throw new Error("Dialog not found");
  return match;
}

function input(id: string) {
  const match = document.getElementById(id);
  if (!(match instanceof HTMLInputElement))
    throw new Error(`Input not found: ${id}`);
  return match;
}

function change(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function render(identity: MeResponse = IDENTITY): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      createElement(CampaignDetailActions, {
        campaign: CAMPAIGN,
        identity,
      }),
    ),
  );
  return root;
}

beforeEach(() => {
  apiMocks.fetchTextAuthed.mockResolvedValue("recipient,status\n");
  apiMocks.resendUnopened.mockResolvedValue({ status: "scheduled" });
  apiMocks.saveCampaignAsTemplate.mockResolvedValue({ slug: "weekly" });
  apiMocks.whoamiFresh.mockResolvedValue(IDENTITY);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("campaign detail actions", () => {
  it("guards save-as-template, freezes intent, retains the dialog, and retries after an inline failure", async () => {
    const pending = deferred<{ slug: string }>();
    apiMocks.saveCampaignAsTemplate
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ slug: "recovered-template" });
    const root = render();
    try {
      act(() => button("Save as template").click());
      await act(async () => {
        change(input("tpl-name"), "Recovered template");
        const submit = button("Save template", dialog());
        submit.click();
        submit.click();
        await Promise.resolve();
      });
      expect(apiMocks.saveCampaignAsTemplate).toHaveBeenCalledTimes(1);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(input("tpl-name").disabled).toBe(true);
      expect(input("tpl-slug").disabled).toBe(true);
      expect(button("Cancel", dialog()).disabled).toBe(true);
      expect(button("Close", dialog()).disabled).toBe(true);

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(dialog()).toBeTruthy();
      await act(async () =>
        pending.reject(new Error("Template transport failed.")),
      );
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Template transport failed.");
      expect(document.activeElement).toBe(alert);

      await act(async () => button("Save template", dialog()).click());
      expect(apiMocks.saveCampaignAsTemplate).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("guards resend, freezes the subject, and retries from its focused inline error", async () => {
    const pending = deferred<{ status: string }>();
    apiMocks.resendUnopened
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ status: "scheduled" });
    const root = render();
    try {
      act(() => button("Resend to non-openers").click());
      await act(async () => {
        change(input("resend-subject"), "A fresh subject");
        const submit = button("Schedule resend", dialog());
        submit.click();
        submit.click();
        await Promise.resolve();
      });
      expect(apiMocks.resendUnopened).toHaveBeenCalledTimes(1);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(input("resend-subject").disabled).toBe(true);
      expect(button("Cancel", dialog()).disabled).toBe(true);
      expect(button("Close", dialog()).disabled).toBe(true);
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(dialog()).toBeTruthy();

      await act(async () =>
        pending.reject(new Error("Resend transport failed.")),
      );
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Resend transport failed.");
      expect(document.activeElement).toBe(alert);
      await act(async () => button("Schedule resend", dialog()).click());
      expect(apiMocks.resendUnopened).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("removes campaign mutations for viewers while retaining the read-only export", () => {
    const root = render({
      ...IDENTITY,
      role: "viewer",
      effective_role: "viewer",
    });
    try {
      expect(document.body.textContent).not.toContain("Save as template");
      expect(document.body.textContent).not.toContain("Resend to non-openers");
      expect(button("Export CSV")).toBeTruthy();
      expect(apiMocks.whoamiFresh).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("revalidates authority before transport and fails closed after a viewer-mode transition", async () => {
    apiMocks.whoamiFresh.mockResolvedValueOnce({
      ...IDENTITY,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const root = render();
    try {
      act(() => button("Save as template").click());
      await act(async () => {
        button("Save template", dialog()).click();
        await Promise.resolve();
      });
      expect(apiMocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(apiMocks.saveCampaignAsTemplate).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
