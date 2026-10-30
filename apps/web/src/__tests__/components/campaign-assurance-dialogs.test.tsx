// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApplyPatchDialog,
  OverrideDialog,
} from "@/app/(dashboard)/app/campaigns/[id]/campaign-assurance-panel";
import type { CampaignAssuranceFinding } from "@/lib/campaign-assurance-api";
import type { MeResponse } from "@/lib/auth-api";

const assuranceMocks = vi.hoisted(() => ({
  applyCampaignAssuranceFinding: vi.fn(),
  overrideCampaignAssuranceFinding: vi.fn(),
  confirmAdmin: vi.fn(),
  confirmWrite: vi.fn(),
}));

vi.mock("@/lib/campaign-write-authority", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-write-authority")>()),
  confirmFreshCampaignAdminAuthority: assuranceMocks.confirmAdmin,
  confirmFreshCampaignWriteAuthority: assuranceMocks.confirmWrite,
}));

vi.mock("@/lib/campaign-assurance-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/campaign-assurance-api")
  >("@/lib/campaign-assurance-api");
  return {
    ...actual,
    applyCampaignAssuranceFinding: assuranceMocks.applyCampaignAssuranceFinding,
    overrideCampaignAssuranceFinding:
      assuranceMocks.overrideCampaignAssuranceFinding,
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const FINDING: CampaignAssuranceFinding = {
  id: "finding-1",
  receipt_hash: "receipt-1",
  code: "HEADING_LEVEL_SKIP",
  source_class: "deterministic",
  severity: "high",
  blocking: true,
  overridable: true,
  dimension: "accessibility",
  explanation: "A heading level is skipped.",
  remediation: { summary: "Repair the heading outline." },
  typed_patch: { version: "TypedPatchV1" },
  created_at: "2026-08-20T09:00:00Z",
};

const IDENTITY: MeResponse = {
  user_id: "user-1",
  tenant_id: "tenant-1",
  email: "admin@example.test",
  role: "admin",
  effective_role: "admin",
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

function textarea() {
  const match = document.querySelector("textarea");
  if (!(match instanceof HTMLTextAreaElement)) {
    throw new Error("Textarea not found");
  }
  return match;
}

function changeTextarea(node: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

function render(node: React.ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return root;
}

beforeEach(() => {
  assuranceMocks.confirmAdmin.mockResolvedValue(undefined);
  assuranceMocks.confirmWrite.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("campaign assurance mutation dialogs", () => {
  it("freezes and retains deterministic repair intent, dedupes, and retries a focused inline failure", async () => {
    const pending = deferred<unknown>();
    assuranceMocks.applyCampaignAssuranceFinding
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({
        receipt: {
          data: {
            originating_run_state: "stale",
            rerun_required: true,
            revision: { id: "revision-2" },
          },
        },
      });
    const onOpenChange = vi.fn();
    const onApplied = vi.fn();
    const root = render(
      createElement(ApplyPatchDialog, {
        open: true,
        onOpenChange,
        campaignId: "campaign-1",
        runId: "run-1",
        finding: FINDING,
        campaignETag: '"campaign-v1"',
        identity: IDENTITY,
        onApplied,
      }),
    );
    try {
      await act(async () => {
        const submit = button("Create repaired revision", dialog());
        submit.click();
        submit.click();
        await Promise.resolve();
      });
      expect(
        assuranceMocks.applyCampaignAssuranceFinding,
      ).toHaveBeenCalledTimes(1);
      expect(assuranceMocks.confirmWrite).toHaveBeenCalledTimes(1);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(button("Cancel", dialog()).disabled).toBe(true);

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(dialog()).toBeTruthy();

      await act(async () =>
        pending.reject(new Error("Repair transport failed.")),
      );
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Repair transport failed.");
      expect(document.activeElement).toBe(alert);

      await act(async () =>
        button("Create repaired revision", dialog()).click(),
      );
      expect(
        assuranceMocks.applyCampaignAssuranceFinding,
      ).toHaveBeenCalledTimes(2);
      expect(onApplied).toHaveBeenCalledWith("revision-2");
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("freezes a governed rationale, dedupes, and retries without losing the draft", async () => {
    const pending = deferred<unknown>();
    assuranceMocks.overrideCampaignAssuranceFinding
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ data: { id: "override-1" } });
    const onOpenChange = vi.fn();
    const onChanged = vi.fn();
    const root = render(
      createElement(OverrideDialog, {
        open: true,
        onOpenChange,
        campaignId: "campaign-1",
        runId: "run-1",
        finding: FINDING,
        identity: IDENTITY,
        onChanged,
      }),
    );
    try {
      act(() => changeTextarea(textarea(), "Reviewed exact frozen evidence."));
      await act(async () => {
        const submit = button("Record decision", dialog());
        submit.click();
        submit.click();
        await Promise.resolve();
      });
      expect(
        assuranceMocks.overrideCampaignAssuranceFinding,
      ).toHaveBeenCalledTimes(1);
      expect(assuranceMocks.confirmAdmin).toHaveBeenCalledTimes(1);
      expect(dialog().getAttribute("aria-busy")).toBe("true");
      expect(textarea().disabled).toBe(true);
      expect(dialog().querySelector("select")?.hasAttribute("disabled")).toBe(
        true,
      );
      expect(button("Cancel", dialog()).disabled).toBe(true);

      act(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
        );
      });
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(dialog()).toBeTruthy();

      await act(async () =>
        pending.reject(new Error("Governance transport failed.")),
      );
      const alert = dialog().querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Governance transport failed.");
      expect(document.activeElement).toBe(alert);
      expect(textarea().value).toBe("Reviewed exact frozen evidence.");

      await act(async () => button("Record decision", dialog()).click());
      expect(
        assuranceMocks.overrideCampaignAssuranceFinding,
      ).toHaveBeenCalledTimes(2);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });
});
