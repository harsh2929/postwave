// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loginWithPasskey: vi.fn(),
  passkeySupported: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("@/lib/auth-api", () => ({
  login: vi.fn(),
  oauthStartUrl: () => "/api/v1/auth/oauth/google/start",
}));

vi.mock("@/lib/auth-passkey", () => ({
  loginWithPasskey: mocks.loginWithPasskey,
  passkeySupported: mocks.passkeySupported,
}));

vi.mock("@/components/auth/device-sign-in", () => ({
  DeviceSignIn: ({
    onBack,
    onComplete,
  }: {
    onBack: () => void;
    onComplete: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": "device-stage" },
      createElement("button", { onClick: onComplete }, "Finish device sign-in"),
      createElement("button", { onClick: onBack }, "Back from device sign-in"),
    ),
}));

import LoginPage from "@/app/login/page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.passkeySupported.mockReturnValue(false);
  window.history.replaceState({}, "", "/login?next=%2Fapp%2Fcampaigns");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(label: string) {
  const target = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!target) throw new Error(`button not found: ${label}`);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("/login device stage", () => {
  it("is an explicit sign-in method and preserves the validated next route", async () => {
    await act(async () => {
      root.render(createElement(LoginPage));
      await Promise.resolve();
    });

    await act(async () => click("Sign in with another device"));
    expect(
      container.querySelector('[data-testid="device-stage"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Approve this browser");
    expect(container.querySelector("h1")?.textContent).toBe(
      "Sign in with another device",
    );
    expect(document.activeElement).toBe(container.querySelector("h1"));

    await act(async () => click("Finish device sign-in"));
    expect(mocks.push).toHaveBeenCalledWith("/app/campaigns");
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("quietly restores the passkey trigger after a native cancellation", async () => {
    mocks.passkeySupported.mockReturnValue(true);
    let rejectPrompt: ((reason: DOMException) => void) | undefined;
    mocks.loginWithPasskey.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    );

    await act(async () => {
      root.render(createElement(LoginPage));
      await Promise.resolve();
    });

    const passkey = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Sign in with a passkey",
    );
    if (!passkey) throw new Error("passkey button not found");
    passkey.focus();
    await act(async () => {
      passkey.click();
      await Promise.resolve();
    });
    expect(passkey.disabled).toBe(true);

    // Chromium drops focus while the WebAuthn invoker is disabled. Model that
    // browser behavior explicitly because happy-dom retains it by default.
    const temporaryTarget = document.createElement("button");
    document.body.append(temporaryTarget);
    temporaryTarget.focus();
    await act(async () => {
      rejectPrompt?.(
        new DOMException("The request was cancelled.", "NotAllowedError"),
      );
      await Promise.resolve();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    expect(passkey.disabled).toBe(false);
    expect(document.activeElement).toBe(passkey);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    temporaryTarget.remove();
  });
});
