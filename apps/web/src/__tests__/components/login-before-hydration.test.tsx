// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Staging: pressing Enter on /login before the page hydrated did a plain GET
// back to /login and silently reset the form. The server HTML had the
// "Sign in" button disabled, but it was still the form's submit button, and
// disabling the default button does not stop every browser's Enter-key
// (implicit) submission. With no JS handler attached yet, that is a native
// GET of the form's own URL.
//
// The page now renders no submit button until it hydrates. The HTML
// standard's implicit-submission algorithm then does nothing for a form with
// no submit button and more than one field that blocks implicit submission
// (email + password) — whether or not a browser honours `disabled` on a
// default button. happy-dom does not implement implicit submission, so the
// algorithm is transcribed below from the standard (4.10.21.2), with the
// "disabled default button" clause switchable to model the browsers that
// ignore it. The fields must still carry no `name`, so even a forced native
// submission sends no credentials.
//
// Found while writing this: what was typed (or autofilled) before hydration
// was wiped anyway. Hydration keeps the DOM value, but the fields are
// controlled, so the re-render that flips `hydrated` wrote the empty state
// back over them. The page now adopts those values first.
import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("@/lib/auth-api", () => ({
  login: mocks.login,
  oauthStartUrl: () => "/api/v1/auth/oauth/google/start",
}));

vi.mock("@/lib/auth-passkey", () => ({
  loginWithPasskey: vi.fn(),
  passkeySupported: () => false,
}));

vi.mock("@/components/auth/device-sign-in", () => ({
  DeviceSignIn: () => createElement("div", null, "Device sign-in"),
}));

import LoginPage from "@/app/login/page";

// Input types that "block implicit submission" (HTML 4.10.21.2).
const BLOCKING_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  "number",
]);

function isSubmitButton(el: Element): boolean {
  if (el instanceof HTMLButtonElement) {
    return (el.getAttribute("type") ?? "submit").toLowerCase() === "submit";
  }
  return (
    el instanceof HTMLInputElement &&
    ["submit", "image"].includes(el.type.toLowerCase())
  );
}

/**
 * Would pressing Enter in one of this form's text fields submit it?
 * `honoursDisabledDefault: false` models a browser that clicks a disabled
 * default button anyway — the behaviour staging exhibited.
 */
function implicitSubmissionSubmits(
  form: HTMLFormElement,
  { honoursDisabledDefault }: { honoursDisabledDefault: boolean },
): boolean {
  const controls = [...form.querySelectorAll("button, input")];
  const defaultButton = controls.find(isSubmitButton);
  if (defaultButton) {
    return !(
      honoursDisabledDefault && (defaultButton as HTMLButtonElement).disabled
    );
  }
  const blocking = controls.filter(
    (el) =>
      el instanceof HTMLInputElement &&
      BLOCKING_TYPES.has(el.type.toLowerCase()),
  );
  return blocking.length <= 1;
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/login");
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container.remove();
});

/** The server's HTML for /login, in the DOM with no React attached. */
function serverRenderedLogin(): HTMLFormElement {
  // The markup React's own server renderer produces for this page — the
  // only content, test-controlled.
  container.innerHTML = renderToString(createElement(LoginPage));
  const form = container.querySelector("form");
  if (!form) throw new Error("login form not server-rendered");
  return form;
}

function type(field: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("/login before hydration", () => {
  it("cannot be submitted natively, in any browser, before the page hydrates", () => {
    const form = serverRenderedLogin();

    expect(
      implicitSubmissionSubmits(form, { honoursDisabledDefault: true }),
    ).toBe(false);
    // The staging symptom: a browser that ignores `disabled` on the default
    // button. With no submit button at all, it has nothing to click.
    expect(
      implicitSubmissionSubmits(form, { honoursDisabledDefault: false }),
    ).toBe(false);
  });

  it("says it is getting ready instead of showing a dead Sign in button", () => {
    const form = serverRenderedLogin();
    const primary = [...form.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("sign-in"),
    );
    expect(primary?.textContent?.trim()).toBe("Preparing sign-in…");
    expect(primary?.disabled).toBe(true);
    expect(primary?.getAttribute("type")).toBe("button");
  });

  it("keeps credentials out of any native submission: the fields have no name", () => {
    const form = serverRenderedLogin();
    const email = form.querySelector<HTMLInputElement>("#email");
    const password = form.querySelector<HTMLInputElement>("#password");
    expect(email).not.toBeNull();
    expect(password).not.toBeNull();
    expect(email?.hasAttribute("name")).toBe(false);
    expect(password?.hasAttribute("name")).toBe(false);
  });

  it("becomes a real sign-in form once hydrated, keeping what was typed", async () => {
    const form = serverRenderedLogin();
    const email = form.querySelector<HTMLInputElement>("#email")!;
    const password = form.querySelector<HTMLInputElement>("#password")!;
    // Typed while the JS was still loading.
    type(email, "ada@example.com");
    type(password, "correct horse");

    mocks.login.mockResolvedValue({ ok: true });
    await act(async () => {
      root = hydrateRoot(container, createElement(LoginPage));
    });

    const submit = container.querySelector<HTMLButtonElement>(
      "button[type='submit']",
    );
    expect(submit?.textContent?.trim()).toBe("Sign in");
    expect(submit?.disabled).toBe(false);
    expect(email.value).toBe("ada@example.com");
    expect(
      implicitSubmissionSubmits(container.querySelector("form")!, {
        honoursDisabledDefault: true,
      }),
    ).toBe(true);

    await act(async () => {
      submit?.click();
    });
    expect(mocks.login).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct horse",
      remember: false,
    });
  });
});
