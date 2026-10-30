// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const apiMocks = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getPolicy: vi.fn(),
  listJobs: vi.fn(),
  getJob: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  savePolicy: vi.fn(),
  cancelJob: vi.fn(),
}));
const authorityMocks = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock("@/lib/verification-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verification-api")>()),
  getVerificationProviders: apiMocks.getProviders,
  getVerificationPolicy: apiMocks.getPolicy,
  listVerificationJobs: apiMocks.listJobs,
  getVerificationJob: apiMocks.getJob,
  saveVerificationProvider: apiMocks.saveProvider,
  deleteVerificationProvider: apiMocks.deleteProvider,
  saveVerificationPolicy: apiMocks.savePolicy,
  cancelVerificationJob: apiMocks.cancelJob,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: authorityMocks.verify,
}));

const PROVIDERS = {
  available: ["zerobounce", "kickbox"] as const,
  providers: [],
};
const POLICY = {
  modes: ["off", "local", "full"] as const,
  rejectable_statuses: [
    "invalid",
    "spamtrap",
    "abuse",
    "do_not_mail",
    "catch_all",
    "unknown",
  ] as const,
  policy: {
    forms_mode: "off" as const,
    forms_reject_statuses: [
      "invalid" as const,
      "spamtrap" as const,
      "abuse" as const,
      "do_not_mail" as const,
    ],
    forms_suggest_typos: true,
    import_mode: "off" as const,
    updated_at: "2026-08-29T00:00:00Z",
  },
};
const JOB = {
  id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
  status: "running" as const,
  source: "inline" as const,
  execution_mode: "full" as const,
  total: 10,
  processed: 3,
  cache_hits: 1,
  local_filtered: 1,
  vendor_verified: 1,
  credits_spent: 1,
  duplicates: 0,
  ambiguous: 0,
  attempts: 1,
  has_error: false,
  created_at: "2026-08-29T00:00:00Z",
  started_at: "2026-08-29T00:00:01Z",
};

beforeEach(() => {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  authorityMocks.verify.mockReset();
  authorityMocks.verify.mockResolvedValue(WHOAMI);
  apiMocks.getProviders.mockResolvedValue(PROVIDERS);
  apiMocks.getPolicy.mockResolvedValue(POLICY);
  apiMocks.listJobs.mockResolvedValue([JOB]);
  apiMocks.getJob.mockResolvedValue({
    job: JOB,
    summary: { valid: 2, unknown: 1 },
    credits_saved: 2,
    credits_spent: 1,
    is_terminal: false,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("verification admin controls", () => {
  it("never requests admin provider or policy state for a viewer", async () => {
    const { VerificationAdminPanel } =
      await import("@/app/(dashboard)/app/verification/verification-admin-panel");
    const { container, root } = await renderPage(VerificationAdminPanel, {
      identity: {
        ...WHOAMI,
        role: "viewer",
        effective_role: "viewer",
      },
      queryKeyBase: ["verification", WHOAMI.tenant_id, "viewer"],
    });
    try {
      expect(container.textContent).toContain(
        "Admin-only. Provider configuration is hidden",
      );
      expect(container.textContent).toContain(
        "Admin-only. Verification enforcement policy is hidden",
      );
      expect(apiMocks.getProviders).not.toHaveBeenCalled();
      expect(apiMocks.getPolicy).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("requires an opaque credential reference and opens an explicit probe confirmation", async () => {
    const { VerificationAdminPanel } =
      await import("@/app/(dashboard)/app/verification/verification-admin-panel");
    const { container, root } = await renderPage(VerificationAdminPanel, {
      identity: WHOAMI,
      queryKeyBase: ["verification", WHOAMI.tenant_id, "owner"],
    });
    try {
      const input = container.querySelector<HTMLInputElement>(
        'input[placeholder="verification-prod"]',
      );
      expect(input).not.toBeNull();
      const save = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Configure provider");
      expect(save?.disabled).toBe(true);
      await act(async () => {
        if (input) {
          Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            "value",
          )?.set?.call(input, "verification-prod");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(save?.disabled).toBe(false);
      await act(async () => {
        save?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain(
        "Save verification provider?",
      );
      expect(document.body.textContent).toContain("live balance request");
      expect(document.body.textContent).not.toContain("API key:");
      expect(apiMocks.saveProvider).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});

describe("verification job controls", () => {
  it("loads URL-bound detail and consequence-gates cancellation", async () => {
    const { VerificationJobsPanel } =
      await import("@/app/(dashboard)/app/verification/verification-jobs-panel");
    const { container, root } = await renderPage(VerificationJobsPanel, {
      identity: WHOAMI,
      queryKeyBase: ["verification", WHOAMI.tenant_id, "owner"],
    });
    try {
      const jobButton = container.querySelector<HTMLButtonElement>(
        `button[aria-pressed="false"]`,
      );
      await act(async () => {
        jobButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(apiMocks.getJob).toHaveBeenCalledWith(
        JOB.id,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(container.textContent).toContain("Credits spent");
      const cancel = [
        ...container.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.trim() === "Cancel run");
      expect(cancel).toBeDefined();
      await act(async () => {
        cancel?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.body.textContent).toContain("Cancel verification run?");
      expect(document.body.textContent).toContain(
        "already dispatched can finish after cancellation",
      );
      expect(document.body.textContent).toContain("CANCEL RUN");
      expect(apiMocks.cancelJob).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });
});
