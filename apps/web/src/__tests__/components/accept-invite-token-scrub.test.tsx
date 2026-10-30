// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /accept-invite carries a single-use bearer token in its query string. It is
// the same shape as /reset-password (token in URL -> pick a password ->
// submit), so it must scrub the token out of the URL the moment it is held in
// state — otherwise the unconsumed credential sits in the address bar, the
// history entry and analytics' $current_url for the whole password step.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AcceptInvitePage from "@/app/accept-invite/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "invite-token-0123456789abcdef";

const mocks = vi.hoisted(() => ({
  acceptInvite: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/accept-invite",
  useSearchParams: () => mocks.search,
}));

vi.mock("@/lib/auth-api", () => ({
  acceptInvite: mocks.acceptInvite,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.acceptInvite.mockReset().mockResolvedValue(undefined);
  mocks.search = new URLSearchParams(`token=${TOKEN}`);
  window.history.replaceState(
    { __NA: true, proof: "preserve-next-state" },
    "",
    `/accept-invite?token=${TOKEN}#join`,
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("accept-invite token scrubbing", () => {
  it("immediately replaces the visible URL while preserving Next history state", () => {
    act(() => {
      root.render(createElement(AcceptInvitePage));
    });
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/accept-invite");
    expect(window.history.state).toEqual({
      __NA: true,
      proof: "preserve-next-state",
    });
  });

  it("still submits the captured token after the URL is scrubbed", async () => {
    act(() => {
      root.render(createElement(AcceptInvitePage));
    });

    const [password, confirm] = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='password']"),
    );
    expect(password).toBeDefined();
    expect(confirm).toBeDefined();
    for (const field of [password, confirm]) {
      if (!field) continue;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(field, "correct horse battery staple");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(mocks.acceptInvite).toHaveBeenCalledWith(
      TOKEN,
      "correct horse battery staple",
    );
  });

  it("does not scrub when there is no token to hide", () => {
    mocks.search = new URLSearchParams();
    window.history.replaceState(
      { __NA: true },
      "",
      "/accept-invite?campaign=welcome#join",
    );
    act(() => {
      root.render(createElement(AcceptInvitePage));
    });
    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/accept-invite?campaign=welcome#join");
  });

  it("keeps both missing-invite recovery actions at a 44px minimum", () => {
    mocks.search = new URLSearchParams();
    act(() => {
      root.render(createElement(AcceptInvitePage));
    });

    const recoveryActions = Array.from(
      container.querySelectorAll<HTMLElement>("[data-slot='button']"),
    );
    expect(recoveryActions.map((action) => action.textContent?.trim())).toEqual(
      ["Go to sign in", "Back to Moosewave"],
    );
    for (const action of recoveryActions) {
      expect(action.classList.contains("min-h-11")).toBe(true);
    }
  });
});
