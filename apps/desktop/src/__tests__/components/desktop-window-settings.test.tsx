// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DesktopWindowSettings } from "../../components/settings/DesktopWindowSettings";
import {
  getDesktopWindowLifecycleState,
  resetDesktopWindowLifecycleForTests,
} from "../../lib/desktop-window-lifecycle";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  window.localStorage.clear();
  resetDesktopWindowLifecycleForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("DesktopWindowSettings", () => {
  it("exposes all close behaviors with durable radio semantics", () => {
    render(<DesktopWindowSettings />);
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(radios.map((radio) => radio.value)).toEqual(["ask", "hide", "quit"]);
    expect(radios[0]?.checked).toBe(true);

    act(() => radios[1]?.click());

    expect(getDesktopWindowLifecycleState().closeBehavior).toBe("hide");
    expect(radios[1]?.checked).toBe(true);
    expect(document.body.textContent).toContain("Window size and position");
  });
});
