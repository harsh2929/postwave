// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SignupPage from "@/app/signup/page";
import { ApiError } from "@/lib/api";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  complete: vi.fn(),
  signup: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/lib/auth-api", () => ({
  googleSignupInfo: mocks.info,
  completeGoogleSignup: mocks.complete,
  signup: mocks.signup,
  oauthStartUrl: () => "/api/v1/auth/oauth/google/start?redirect_to=%2Fapp",
  checkWorkspaceSlug: async () => ({ available: true }),
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let root: Root | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(
    {},
    "",
    "/signup?from=oauth&provider=google&email=forged@example.test",
  );
  mocks.info.mockResolvedValue({
    provider: "google",
    email: "verified@example.test",
    csrf_token: "proof-csrf",
  });
  mocks.complete.mockResolvedValue({ user_id: "user", tenant_id: "tenant" });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});
async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SignupPage />));
  return container;
}
async function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  if (!input) throw new Error(`Missing ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit(container: HTMLElement) {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("Google workspace creation", () => {
  it("uses the server identity, hides password and the repeated Google button, and creates the workspace directly", async () => {
    const container = await render();
    const email = container.querySelector<HTMLInputElement>("#email")!;
    expect(email.value).toBe("verified@example.test");
    expect(email.readOnly).toBe(true);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).not.toContain("Continue with Google");
    await type("workspace-name", "My newsletter");
    await submit(container);
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      workspace_name: "My newsletter",
      workspace_slug: "my-newsletter",
      csrf_token: "proof-csrf",
    });
    expect(mocks.signup).not.toHaveBeenCalled();
    expect(mocks.push).toHaveBeenCalledWith("/app");
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("does not trust email/provider query parameters when the proof is missing or expired", async () => {
    mocks.info.mockRejectedValue(new ApiError("expired", 401));
    const container = await render();
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Continue with Google again");
    expect(container.textContent).not.toContain("forged@example.test");
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps workspace details and Google proof after a slug collision so it can retry", async () => {
    mocks.complete.mockRejectedValueOnce(
      new ApiError("taken", 409, undefined, { code: "workspace_slug_taken" }),
    );
    const container = await render();
    await type("workspace-name", "My newsletter");
    await submit(container);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "slug is taken",
    );
    expect(
      (container.querySelector("#workspace-name") as HTMLInputElement).value,
    ).toBe("My newsletter");
    await type("workspace-slug", "another-slug");
    await submit(container);
    expect(mocks.complete).toHaveBeenLastCalledWith({
      workspace_name: "My newsletter",
      workspace_slug: "another-slug",
      csrf_token: "proof-csrf",
    });
    expect(mocks.push).toHaveBeenCalledWith("/app");
  });

  it("offers a fresh Google sign-in if the proof expires during workspace entry", async () => {
    mocks.complete.mockRejectedValue(new ApiError("expired", 401));
    const container = await render();
    await type("workspace-name", "My newsletter");
    await submit(container);
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Continue with Google again");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("keeps password signup available when the user chooses that flow", async () => {
    window.history.replaceState({}, "", "/signup");
    const container = await render();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.textContent).toContain("Continue with Google");
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
