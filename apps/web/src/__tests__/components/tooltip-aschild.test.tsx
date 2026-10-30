// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression guard (audit SUB-044 MUST-FIX): the shared <Tooltip> is an
// asChild-style wrapper. A parent (e.g. Radix DialogTrigger asChild) clones the
// Tooltip element and injects onClick/ref/aria onto it; Tooltip MUST forward
// those onto the real trigger child. The previous version destructured only
// {label,children,side,className} and dropped them, silently breaking every
// trigger wrapped in a Tooltip (dead row-delete button).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tooltip } from "@/components/ui/tooltip";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Tooltip asChild prop forwarding", () => {
  it("forwards a parent-injected onClick onto the trigger child", () => {
    const injected = vi.fn();
    // Simulates what Radix DialogTrigger asChild does: put onClick on <Tooltip>.
    act(() => {
      root.render(
        <Tooltip label="Delete" onClick={injected}>
          <button type="button">Delete</button>
        </Tooltip>,
      );
    });
    click(container.querySelector("button")!);
    expect(injected).toHaveBeenCalledTimes(1);
  });

  it("preserves the child's own onClick alongside the injected one", () => {
    const injected = vi.fn();
    const own = vi.fn();
    act(() => {
      root.render(
        <Tooltip label="Delete" onClick={injected}>
          <button type="button" onClick={own}>
            Delete
          </button>
        </Tooltip>,
      );
    });
    click(container.querySelector("button")!);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("forwards a ref to the underlying DOM node", () => {
    let node: HTMLElement | null = null;
    act(() => {
      root.render(
        <Tooltip
          label="Delete"
          ref={(n) => {
            node = n;
          }}
        >
          <button type="button">Delete</button>
        </Tooltip>,
      );
    });
    expect(node).not.toBeNull();
    expect((node as unknown as HTMLElement).tagName).toBe("BUTTON");
  });

  it("mounts tooltip content only while the trigger is focused and dismisses on Escape", async () => {
    act(() => {
      root.render(
        <Tooltip label="A deliberately long contextual explanation">
          <button type="button">More information</button>
        </Tooltip>,
      );
    });
    const button = container.querySelector("button")!;
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      button.focus();
    });
    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toBe(
      "A deliberately long contextual explanation",
    );
    expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);

    await act(async () => {
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });
});
