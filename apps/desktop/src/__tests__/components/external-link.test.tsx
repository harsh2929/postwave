// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ExternalLink } from "../../components/ExternalLink";
import { tauriApi } from "../../lib/tauri";

let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderLink(href: string): HTMLAnchorElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ExternalLink href={href}>Open docs</ExternalLink>));
  const link = container.querySelector("a");
  if (!link) throw new Error("Missing external link");
  return link;
}

describe("ExternalLink", () => {
  it("routes safe activation through the guarded native/web opener", () => {
    const open = vi.spyOn(tauriApi, "openUrl").mockResolvedValue(undefined);
    const link = renderLink("https://docs.moosewave.com/setup#private-fragment");

    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    act(() => link.click());

    expect(open).toHaveBeenCalledWith("https://docs.moosewave.com/setup");
  });

  it("fails closed for unsafe schemes before browser or native activation", () => {
    const open = vi.spyOn(tauriApi, "openUrl").mockResolvedValue(undefined);
    const link = renderLink("javascript:alert(document.domain)");

    expect(link.hasAttribute("href")).toBe(false);
    expect(link.getAttribute("aria-disabled")).toBe("true");
    act(() => link.click());
    expect(open).not.toHaveBeenCalled();
  });
});
