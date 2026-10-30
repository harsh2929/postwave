// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The close callback HeaderMenu publishes must keep its identity across
// re-renders (WEB-RENDER-10).
//
// It was the last unmemoised context value in apps/web — the other five
// providers all pass a useMemo'd value, and command-registry.tsx carries a
// comment explaining why. An inline `value={() => setOpen(false)}` mints a new
// function on every HeaderMenu render, and React then re-renders every item
// that reads the callback even though the panel's `children` is literally the
// same element object it already rendered.
import { act, useContext } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HeaderMenu,
  HeaderMenuButton,
  HeaderMenuCloseContext,
  type HeaderMenuRenderProps,
} from "@/components/ui/header-menu";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

function trigger({ toggle, triggerRef }: HeaderMenuRenderProps): ReactNode {
  return (
    <button ref={triggerRef} onClick={toggle}>
      Account
    </button>
  );
}

function mount(element: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

describe("HeaderMenu close context", () => {
  it("publishes one callback instance, not one per render", () => {
    // Every value the item was ever handed. One instance means the item was
    // not re-rendered on the menu's account at all.
    const seen: (() => void)[] = [];
    function Item(): ReactNode {
      seen.push(useContext(HeaderMenuCloseContext));
      return (
        <button type="button" data-header-menu-item>
          Sign out
        </button>
      );
    }

    // Held outside render so the panel receives the SAME element object on the
    // second pass: anything React walks past this point, it walked because the
    // context value changed, not because the tree did.
    const items = <Item />;

    function Harness({ label }: { label: string }): ReactNode {
      return (
        <HeaderMenu label={label} trigger={trigger}>
          {items}
        </HeaderMenu>
      );
    }

    const container = mount(<Harness label="Account menu" />);
    act(() => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector("nav")).not.toBeNull();
    expect(seen).toHaveLength(1);

    // An unrelated prop change: it re-renders HeaderMenu and nothing else.
    act(() => {
      root!.render(<Harness label="Account" />);
    });
    expect(container.querySelector("nav")!.getAttribute("aria-label")).toBe(
      "Account",
    );
    expect(new Set(seen).size).toBe(1);
  });

  it("closes after a button action and restores focus to its trigger", async () => {
    // The identity fix must not cost the behaviour the context exists for.
    const onClick = vi.fn();
    const container = mount(
      <HeaderMenu label="Account menu" trigger={trigger}>
        <HeaderMenuButton onClick={onClick}>Sign out</HeaderMenuButton>
      </HeaderMenu>,
    );
    const opener = container.querySelector<HTMLButtonElement>("button")!;
    act(() => {
      opener.click();
    });
    const item = container.querySelector<HTMLButtonElement>(
      "[data-header-menu-item]",
    )!;
    item.focus();
    await act(async () => {
      item.click();
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector("nav")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
