// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import TotpChallengePage from "@/app/totp-challenge/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => {
  const push = vi.fn();
  const replace = vi.fn();
  const refresh = vi.fn();
  return {
    whoami: vi.fn(),
    totpEnroll: vi.fn(),
    totpVerify: vi.fn(),
    totpChallenge: vi.fn(),
    push,
    replace,
    refresh,
    router: { push, replace, refresh },
  };
});

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => createElement("a", { href, ...props }, children),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
  useSearchParams: () => new URLSearchParams("next=%2Fapp"),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  totpEnroll: mocks.totpEnroll,
  totpVerify: mocks.totpVerify,
  totpChallenge: mocks.totpChallenge,
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
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

describe("TOTP policy challenge", () => {
  it("lets a policy-locked user complete first-time enrollment outside the dashboard", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "user_1",
      tenant_id: "tenant_1",
      role: "owner",
      mfa_required: true,
      mfa_satisfied: false,
      totp_enabled: false,
    });
    mocks.totpEnroll.mockResolvedValue({
      otpauth_uri: "otpauth://totp/Moosewave:owner@example.com",
      recovery_codes: ["recovery-1", "recovery-2"],
    });
    mocks.totpVerify.mockResolvedValue({
      verified: true,
      mfa_satisfied: true,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TotpChallengePage));
    });

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Set up two-factor authentication",
      );
    });
    const setupButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Set up two-factor"),
    );
    expect(setupButton).toBeTruthy();
    await act(async () => {
      setupButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(mocks.totpEnroll).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(container.textContent).toContain(
        "otpauth://totp/Moosewave:owner@example.com",
      );
      expect(container.textContent).toContain("recovery-1");
    });

    // Enrollment renders a scannable QR (AUTH-002).
    expect(container.querySelector('[role="img"]')).toBeTruthy();

    // The one-time recovery bundle must stay usable at the 320px auth-card
    // width: actions stack, codes can wrap, and the acknowledgment remains a
    // full touch target.
    const recoveryLabel = Array.from(container.querySelectorAll("label")).find(
      (label) => label.textContent?.trim() === "Recovery codes",
    );
    expect(recoveryLabel?.parentElement?.className).toContain("flex-col");
    const recoveryCode = Array.from(container.querySelectorAll("code")).find(
      (candidate) => candidate.textContent === "recovery-1",
    );
    expect(recoveryCode?.className).toContain("break-all");
    expect(recoveryCode?.parentElement?.className).toContain("grid-cols-1");

    const code = container.querySelector("#code") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(code, "123456");
      code.dispatchEvent(new Event("input", { bubbles: true }));
      code.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // Verify is gated behind the "saved my recovery codes" acknowledgment
    // (AUTH-001): it stays disabled until the box is checked.
    const verifyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Verify",
    ) as HTMLButtonElement | undefined;
    expect(verifyButton).toBeTruthy();
    expect(verifyButton?.disabled).toBe(true);

    const ack = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    expect(ack).toBeTruthy();
    expect(ack.closest("label")?.className).toContain("min-h-11");
    await act(async () => {
      ack.click();
      await Promise.resolve();
    });
    expect(verifyButton?.disabled).toBe(false);

    await act(async () => {
      verifyButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mocks.totpVerify).toHaveBeenCalledWith("123456");
      expect(mocks.push).toHaveBeenCalledWith("/app");
      expect(mocks.refresh).toHaveBeenCalled();
    });
    expect(mocks.totpChallenge).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("switches challenge methods with focus, touch, and secret-clearing contracts", async () => {
    mocks.whoami.mockResolvedValue({
      user_id: "user_1",
      tenant_id: "tenant_1",
      role: "owner",
      mfa_required: true,
      mfa_satisfied: false,
      totp_enabled: true,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TotpChallengePage));
    });

    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Use a recovery code instead");
      });
      const code = container.querySelector("#code") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        setter?.call(code, "123");
        code.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const recoveryToggle = Array.from(
        container.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("recovery code"));
      expect(recoveryToggle?.className).toContain("min-h-11");
      await act(async () => recoveryToggle?.click());

      const recovery = container.querySelector("#recovery") as HTMLInputElement;
      expect(document.activeElement).toBe(recovery);
      await act(async () => {
        setter?.call(recovery, "saved-recovery-secret");
        recovery.dispatchEvent(new Event("input", { bubbles: true }));
      });

      const authenticatorToggle = Array.from(
        container.querySelectorAll("button"),
      ).find((button) => button.textContent?.includes("authenticator app"));
      await act(async () => authenticatorToggle?.click());

      const freshCode = container.querySelector("#code") as HTMLInputElement;
      expect(document.activeElement).toBe(freshCode);
      expect(freshCode.value).toBe("");

      const toggleAgain = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("recovery code"),
      );
      await act(async () => toggleAgain?.click());
      expect(
        (container.querySelector("#recovery") as HTMLInputElement).value,
      ).toBe("");
      expect(container.textContent).not.toContain("saved-recovery-secret");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
