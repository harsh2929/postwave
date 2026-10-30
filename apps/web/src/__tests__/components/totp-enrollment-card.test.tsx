// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TotpEnrollmentCard } from "@/app/(dashboard)/app/settings/security/totp-enrollment-card";
import { ApiError } from "@/lib/api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  totpEnroll: vi.fn(),
  totpVerify: vi.fn(),
  totpChallenge: vi.fn(),
  totpDisable: vi.fn(),
  getRecoveryCodesStatus: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  totpEnroll: mocks.totpEnroll,
  totpVerify: mocks.totpVerify,
  totpChallenge: mocks.totpChallenge,
  totpDisable: mocks.totpDisable,
  getRecoveryCodesStatus: mocks.getRecoveryCodesStatus,
  regenerateRecoveryCodes: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    warning: mocks.toastWarning,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function me(totpEnabled: boolean) {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "ada@example.com",
    role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    totp_enabled: totpEnabled,
    mfa_satisfied: false,
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
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
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await flush();
      });
    }
  }
  throw lastError;
}

function buttonByText(text: string, occurrence = 0): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === text,
  );
  const button = buttons[occurrence];
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("TotpEnrollmentCard", () => {
  it("enrolls, sanitizes the verification code, and keeps invalid-code feedback visible", async () => {
    mocks.whoami.mockResolvedValue(me(false));
    mocks.whoamiFresh.mockResolvedValue(me(false));
    mocks.totpEnroll.mockResolvedValue({
      otpauth_uri: "otpauth://totp/Moosewave:ada@example.com",
      recovery_codes: ["rec-111", "rec-222"],
    });
    mocks.totpVerify.mockRejectedValue(new ApiError("Invalid code", 400));

    const root = render(createElement(TotpEnrollmentCard));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Not enrolled");
      });

      await act(async () => {
        buttonByText("Enable 2FA").click();
        await flush();
      });
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "otpauth://totp/Moosewave:ada@example.com",
        );
        expect(document.body.textContent).toContain("rec-111");
      });

      const codeInput = document.querySelector(
        "#totp-code",
      ) as HTMLInputElement;
      act(() => {
        changeInput(codeInput, "12a345678");
      });
      expect(codeInput.value).toBe("123456");

      await act(async () => {
        buttonByText("Verify and activate").click();
        await flush();
      });

      await waitFor(() => {
        expect(mocks.totpVerify).toHaveBeenCalledWith(
          "123456",
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            idempotencyKey: expect.any(String),
          }),
        );
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "That code didn't match. Try again.",
        );
        expect(document.body.textContent).toContain(
          "otpauth://totp/Moosewave:ada@example.com",
        );
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("requires a fresh code (step-up) before disabling 2FA", async () => {
    mocks.whoami.mockResolvedValue(me(true));
    mocks.whoamiFresh
      .mockResolvedValueOnce(me(true))
      .mockResolvedValueOnce(me(true))
      .mockResolvedValueOnce(me(false));
    mocks.getRecoveryCodesStatus.mockResolvedValue({
      enrolled: true,
      remaining: 8,
      total: 8,
      low: false,
    });
    mocks.totpChallenge.mockResolvedValue({ mfa_satisfied: true });
    mocks.totpDisable.mockResolvedValue(undefined);

    const root = render(createElement(TotpEnrollmentCard));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("2FA is active");
      });

      // Open the disable dialog.
      await act(async () => {
        buttonByText("Disable 2FA").click();
        await flush();
      });

      // The confirm button is disabled until a 6-digit code is entered — a
      // step-up gate (SETC-020), not just a confirm click.
      const codeInput = document.querySelector(
        "#disable-totp-code",
      ) as HTMLInputElement;
      expect(codeInput).toBeTruthy();
      act(() => {
        changeInput(codeInput, "654321");
      });

      await act(async () => {
        buttonByText("Disable 2FA", 1).click();
        await flush();
      });

      await waitFor(() => {
        // Step-up challenge runs first, then the disable.
        expect(mocks.totpChallenge).toHaveBeenCalledWith(
          { code: "654321" },
          expect.objectContaining({
            signal: expect.any(AbortSignal),
            idempotencyKey: expect.any(String),
          }),
        );
        expect(mocks.totpDisable).toHaveBeenCalledTimes(1);
        expect(mocks.toastSuccess).toHaveBeenCalledWith(
          "Two-factor authentication disabled.",
        );
        expect(document.body.textContent).toContain("Not enrolled");
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("blocks the disable when the step-up code is wrong", async () => {
    mocks.whoami.mockResolvedValue(me(true));
    mocks.whoamiFresh.mockResolvedValue(me(true));
    mocks.getRecoveryCodesStatus.mockResolvedValue({
      enrolled: true,
      remaining: 8,
      total: 8,
      low: false,
    });
    mocks.totpChallenge.mockRejectedValue(new ApiError("Invalid code", 401));

    const root = render(createElement(TotpEnrollmentCard));

    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("2FA is active");
      });
      await act(async () => {
        buttonByText("Disable 2FA").click();
        await flush();
      });
      const codeInput = document.querySelector(
        "#disable-totp-code",
      ) as HTMLInputElement;
      act(() => {
        changeInput(codeInput, "000000");
      });
      await act(async () => {
        buttonByText("Disable 2FA", 1).click();
        await flush();
      });
      await waitFor(() => {
        expect(mocks.totpChallenge).toHaveBeenCalled();
        expect(mocks.totpDisable).not.toHaveBeenCalled();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "That code didn't match. Try again.",
        );
      });
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });
});
