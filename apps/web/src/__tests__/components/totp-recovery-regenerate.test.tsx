// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETC-035: an already-enrolled user can regenerate recovery codes. The flow
// must step up (a fresh TOTP code) BEFORE regenerating, and show the new codes
// once.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  totpChallenge: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  getRecoveryCodesStatus: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (identity: { effective_role?: string; role: string }) =>
    identity.effective_role ?? identity.role,
  totpEnroll: vi.fn(),
  totpVerify: vi.fn(),
  totpDisable: vi.fn(),
  totpChallenge: mocks.totpChallenge,
  regenerateRecoveryCodes: mocks.regenerateRecoveryCodes,
  getRecoveryCodesStatus: mocks.getRecoveryCodesStatus,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { TotpEnrollmentCard } from "@/app/(dashboard)/app/settings/security/totp-enrollment-card";

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => root.render(createElement(QueryClientProvider, { client }, ui)));
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 25; i += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await flush();
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("SETC-035 regenerate recovery codes", () => {
  it("steps up then regenerates and shows the new codes once", async () => {
    const identity = {
      user_id: "usr_1",
      tenant_id: "tnt_1",
      email: "ada@example.com",
      role: "owner" as const,
      effective_role: "owner" as const,
      viewer_mode: false,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Acme",
      workspace_slug: "acme",
      totp_enabled: true,
    };
    mocks.whoami.mockResolvedValue(identity);
    mocks.whoamiFresh.mockResolvedValue(identity);
    mocks.getRecoveryCodesStatus.mockResolvedValue({
      enrolled: true,
      remaining: 1,
      total: 8,
      low: true,
    });
    mocks.totpChallenge.mockResolvedValue({ mfa_satisfied: true });
    mocks.regenerateRecoveryCodes.mockResolvedValue({
      recovery_codes: ["AAAA-1111", "BBBB-2222"],
      remaining: 8,
      total: 8,
    });

    render(createElement(TotpEnrollmentCard));

    // Active-2FA state surfaces the low-codes warning + a regenerate button.
    await waitFor(() => {
      if (!button("Regenerate codes")) throw new Error("no regen button");
    });
    await waitFor(() => {
      if (!document.body.textContent?.includes("1 of 8 unused"))
        throw new Error("recovery status not shown");
    });
    expect(document.body.textContent).toContain("Running low");

    act(() => button("Regenerate codes")!.click());
    await waitFor(() => {
      if (!document.body.querySelector("#regen-totp-code"))
        throw new Error("dialog not open");
    });

    // Enter a code and submit.
    const input = document.body.querySelector(
      "#regen-totp-code",
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await waitFor(() => {
      const b = button("Regenerate codes");
      // the dialog's submit button ("Regenerate codes") must become enabled
      if (!b || b.disabled) throw new Error("submit not enabled");
    });
    // Click the dialog submit (last matching button).
    const submitBtns = [...document.body.querySelectorAll("button")].filter(
      (b) => b.textContent?.includes("Regenerate codes"),
    );
    act(() => (submitBtns[submitBtns.length - 1] as HTMLButtonElement).click());

    // Regeneration verifies the fresh code server-side — it is sent the exact
    // code the user typed (no separate step-up call whose short-circuit would
    // make the prompt theater).
    await waitFor(() => {
      if (mocks.regenerateRecoveryCodes.mock.calls.length === 0)
        throw new Error("regenerate not called");
    });
    expect(mocks.regenerateRecoveryCodes).toHaveBeenCalledWith(
      "123456",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        idempotencyKey: expect.any(String),
      }),
    );
    expect(mocks.totpChallenge).not.toHaveBeenCalled();
    // The new codes are shown once.
    await waitFor(() => {
      if (!document.body.textContent?.includes("AAAA-1111"))
        throw new Error("new codes not shown");
    });
    expect(document.body.textContent).toContain("BBBB-2222");
  });
});
