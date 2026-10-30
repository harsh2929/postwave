// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// ECO-01: the prompt raised in place of a logout. Covers the half the
// transport test cannot see — that the ACTION from the header and the SERVER's
// reason reach the screen, that a code goes to the endpoint which actually
// refreshes mfa_satisfied_at (/totp/verify, not /totp/challenge), and that
// every way of closing the dialog answers the waiting request.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  totpVerify: vi.fn(),
}));

vi.mock("@/lib/auth-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return { ...actual, totpVerify: authMocks.totpVerify };
});

import { StepUpPrompt } from "@/components/auth/step-up-prompt";
import { ApiError } from "@/lib/api";
import { requestStepUpProof, resetStepUpState } from "@/lib/step-up";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render(): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(StepUpPrompt)));
  return root;
}

function codeInput(): HTMLInputElement {
  const node = document.getElementById("step-up-code");
  if (!(node instanceof HTMLInputElement)) {
    throw new Error("step-up code input not found");
  }
  return node;
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

function buttonByText(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${text}`);
  }
  return match;
}

const EXPORT_CHALLENGE = {
  action: "subscribers.export",
  reason: "Confirm it's you before exporting subscriber data.",
  maxAgeSeconds: 900,
};

beforeEach(() => {
  resetStepUpState();
  authMocks.totpVerify.mockReset();
  authMocks.totpVerify.mockResolvedValue({
    verified: true,
    mfa_satisfied: true,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  resetStepUpState();
});

describe("StepUpPrompt (ECO-01)", () => {
  it("renders nothing until a challenge arrives", () => {
    const root = render();
    try {
      expect(document.getElementById("step-up-code")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("names the action and shows the server's reason, not invented copy", async () => {
    const root = render();
    try {
      let proof: Promise<boolean> | null = null;
      act(() => {
        proof = requestStepUpProof(EXPORT_CHALLENGE);
      });
      const text = document.body.textContent ?? "";
      expect(text).toContain("Confirm it's you before exporting subscriber data.");
      // The action id from X-Postwave-Step-Up, made legible.
      expect(text).toContain("Subscribers · export");
      // And it must not read as a session loss.
      expect(text).toContain("You're still signed in.");

      act(() => {
        buttonByText("Cancel").click();
      });
      await expect(proof).resolves.toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("verifies through /totp/verify and answers the waiting request", async () => {
    const root = render();
    try {
      let proof: Promise<boolean> | null = null;
      act(() => {
        proof = requestStepUpProof(EXPORT_CHALLENGE);
      });
      // Auto-submit on a complete 6-digit code, matching the TOTP page.
      await act(async () => {
        changeInput(codeInput(), "123456");
      });
      expect(authMocks.totpVerify).toHaveBeenCalledTimes(1);
      expect(authMocks.totpVerify).toHaveBeenCalledWith("123456");
      await expect(proof).resolves.toBe(true);
      // Closed, so a later challenge starts from a clean field.
      expect(document.getElementById("step-up-code")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the prompt open on a wrong code and does not answer yet", async () => {
    authMocks.totpVerify.mockRejectedValue(
      new ApiError("invalid", 401, undefined, { code: "invalid_code" }),
    );
    const root = render();
    try {
      let settled: boolean | null = null;
      act(() => {
        void requestStepUpProof(EXPORT_CHALLENGE).then((v) => {
          settled = v;
        });
      });
      await act(async () => {
        changeInput(codeInput(), "000000");
      });
      expect(document.body.textContent).toContain("That code didn't work.");
      expect(document.getElementById("step-up-code")).not.toBeNull();
      expect(settled).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("explains the dead end when the account has no authenticator", async () => {
    authMocks.totpVerify.mockRejectedValue(
      new ApiError("not enrolled", 400, undefined, { code: "not_enrolled" }),
    );
    const root = render();
    try {
      act(() => {
        void requestStepUpProof(EXPORT_CHALLENGE);
      });
      await act(async () => {
        changeInput(codeInput(), "123456");
      });
      expect(document.body.textContent).toContain(
        "isn't set up on your account",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("unmounting mid-prompt answers 'no' instead of hanging the request", async () => {
    const root = render();
    let proof: Promise<boolean> | null = null;
    act(() => {
      proof = requestStepUpProof(EXPORT_CHALLENGE);
    });
    expect(document.getElementById("step-up-code")).not.toBeNull();
    act(() => root.unmount());
    await expect(proof).resolves.toBe(false);
  });
});
