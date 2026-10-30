// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/login");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function input(id: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`input not found: ${id}`);
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

describe("/login workspace stage", () => {
  it("scrubs a rejected cross-origin next target while keeping safe context", async () => {
    window.history.replaceState(
      {},
      "",
      "/login?next=https%3A%2F%2Fevil.example%2Fsteal&reason=continue",
    );

    await act(async () => {
      root.render(createElement(LoginPage));
      await Promise.resolve();
    });

    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe("?reason=continue");
    expect(container.textContent).toContain("Sign in to continue to /app.");
  });

  it("announces the stage, handles an empty search, and cannot submit a hidden selection", async () => {
    const workspaces = Array.from({ length: 8 }, (_, index) => ({
      id: `workspace-${index + 1}`,
      name: index === 7 ? "North Star Studio" : `Workspace ${index + 1}`,
      slug: index === 7 ? "north-star" : `workspace-${index + 1}`,
    }));
    mocks.login
      .mockResolvedValueOnce({ needs_workspace: true, workspaces })
      .mockResolvedValueOnce({
        needs_workspace: false,
        user_id: "user-1",
        tenant_id: "workspace-8",
      });

    await act(async () => {
      root.render(createElement(LoginPage));
      await Promise.resolve();
    });

    await act(async () => {
      input("email", "sender@example.com");
      input("password", "correct horse battery staple");
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
      await Promise.resolve();
    });

    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Choose a workspace");
    expect(document.activeElement).toBe(heading);
    expect(button("Continue").disabled).toBe(false);

    await act(async () => input("workspace-search", "nothing matches"));
    expect(container.textContent).toContain("No matching workspaces");
    expect(button("Continue").disabled).toBe(true);

    await act(async () => button("Clear search").click());
    expect(button("Continue").disabled).toBe(false);

    const northStar = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="workspace"]'),
    ).at(-1)!;
    await act(async () => northStar.click());

    await act(async () => {
      button("Continue").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.login).toHaveBeenNthCalledWith(2, {
      email: "sender@example.com",
      password: "correct horse battery staple",
      workspace_id: "workspace-8",
      remember: false,
    });
    expect(mocks.push).toHaveBeenCalledWith("/app");
  });
});
