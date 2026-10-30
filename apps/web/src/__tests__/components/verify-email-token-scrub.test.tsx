// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: "",
  replace: vi.fn(),
  verifyEmail: vi.fn(),
  whoami: vi.fn(),
}));

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
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

vi.mock("@/lib/auth-api", () => ({
  sendVerificationEmail: vi.fn(),
  verifyEmail: mocks.verifyEmail,
  whoami: mocks.whoami,
}));

import VerifyEmailPage from "@/app/verify-email/page";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.query = "";
  mocks.verifyEmail.mockResolvedValue({ ok: true });
  mocks.whoami.mockRejectedValue(new Error("signed out"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderPage() {
  await act(async () => {
    root.render(createElement(VerifyEmailPage));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("verify-email token scrubbing", () => {
  it("scrubs an over-limit token even though it is rejected before consume", async () => {
    mocks.query = `token=${"x".repeat(2049)}`;

    await renderPage();

    expect(mocks.verifyEmail).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledWith("/verify-email", {
      scroll: false,
    });
    expect(container.textContent).toContain("Verification failed");
  });

  it("consumes and scrubs a valid token but leaves a tokenless route alone", async () => {
    mocks.query = "token=valid-token";
    await renderPage();

    expect(mocks.verifyEmail).toHaveBeenCalledWith("valid-token");
    expect(mocks.replace).toHaveBeenCalledWith("/verify-email", {
      scroll: false,
    });

    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    mocks.query = "";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await renderPage();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
