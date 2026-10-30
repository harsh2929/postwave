// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Regression: ActionMenu — the shared per-row "kebab" menu — moved focus INTO
// the popover on open (correct) but never moved it back on close. Escape and
// selecting an item both just unmounted the menu, so `document.activeElement`
// fell back to <body>: a keyboard user tabbing a list of forms lost their place
// entirely after every action and had to tab in from the top of the document.
//
// The rest of the app already does this — header-menu restores with
// `requestAnimationFrame(() => triggerRef.current?.focus())`, and the command
// palette / docs search / cookie banner all carry a `restoreFocus`. This
// primitive was the outlier, and it was untested.
//
// Outside-click deliberately does NOT restore: the user has already moved
// their attention elsewhere, and yanking focus back would fight them.
import { act, createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionMenu } from "@/components/ui/action-menu";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

async function mount(
  onSelect = vi.fn(),
  externalTriggerRef?: RefObject<HTMLButtonElement | null>,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ActionMenu
        label="Actions for Newsletter"
        triggerRef={externalTriggerRef}
        items={[
          { label: "Edit", onSelect },
          { label: "Delete", onSelect: vi.fn(), destructive: true },
        ]}
      />,
    );
  });
  return { onSelect };
}

const trigger = () =>
  host!.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
const menuItems = () => [
  ...host!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
];

async function open() {
  await act(async () => {
    trigger().click();
  });
}

/** requestAnimationFrame-deferred focus needs a tick to land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("ActionMenu focus management", () => {
  it("exposes the stable trigger for follow-on dialog focus restoration", async () => {
    const externalTriggerRef = createRef<HTMLButtonElement>();
    await mount(vi.fn(), externalTriggerRef);

    expect(externalTriggerRef.current).toBe(trigger());
  });

  it("moves focus into the menu on open", async () => {
    await mount();
    await open();
    expect(menuItems()).toHaveLength(2);
    expect(document.activeElement).toBe(menuItems()[0]);
  });

  it("returns focus to the trigger on Escape", async () => {
    await mount();
    await open();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();

    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("returns focus to the trigger after choosing an item", async () => {
    const { onSelect } = await mount();
    await open();

    await act(async () => {
      menuItems()[0]!.click();
    });
    await settle();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it("does NOT steal focus back on an outside click", async () => {
    await mount();
    await open();

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    await act(async () => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();

    expect(menuItems()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
