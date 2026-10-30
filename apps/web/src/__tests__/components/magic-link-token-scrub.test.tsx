// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MagicLinkPage from "@/app/magic-link/page";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const SIGNATURE = "A".repeat(43);

const mocks = vi.hoisted(() => ({
  pathname: "/magic-link",
  search: new URLSearchParams(),
  consume: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: vi.fn(), push: mocks.push, back: vi.fn() }),
  useSearchParams: () => mocks.search,
}));

vi.mock("@/lib/auth-api", () => ({
  magicLinkConsume: mocks.consume,
  magicLinkStart: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function proofQuery() {
  return new URLSearchParams({
    token: "magic-proof-token",
    v: "1",
    flow: "magic",
    aud: "web",
    sig: SIGNATURE,
  });
}

beforeEach(() => {
  mocks.pathname = "/magic-link";
  mocks.search = proofQuery();
  mocks.consume.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.push.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("magic-link proof scrubbing", () => {
  it("scrubs a browser alias without changing its app-link-safe pathname", () => {
    mocks.pathname = "/browser-auth/magic";
    window.history.replaceState(
      { __NA: true, proof: "preserve-next-state" },
      "",
      `/browser-auth/magic?${mocks.search.toString()}#consume`,
    );

    act(() => {
      root.render(createElement(MagicLinkPage));
    });

    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/browser-auth/magic");
    expect(window.history.state).toEqual({
      __NA: true,
      proof: "preserve-next-state",
    });
    expect(mocks.consume).toHaveBeenCalledWith({
      token: "magic-proof-token",
      link_version: 1,
      link_flow: "magic",
      link_audience: "web",
      link_signature: SIGNATURE,
    });
  });

  it("scrubs malformed credentials without attempting to consume them", () => {
    mocks.search = new URLSearchParams("token=altered&sig=short");
    window.history.replaceState(
      { __NA: true },
      "",
      "/magic-link?token=altered&sig=short#invalid",
    );

    act(() => {
      root.render(createElement(MagicLinkPage));
    });

    expect(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    ).toBe("/magic-link");
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Sign-in link didn’t work");
  });
});
