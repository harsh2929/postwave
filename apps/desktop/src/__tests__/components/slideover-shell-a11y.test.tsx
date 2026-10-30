// @vitest-environment happy-dom

import { act, type ReactElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "../../components/ConfirmModal";
import { SlideoverShell } from "../../components/SlideoverShell";

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
  if (root) {
    const currentRoot = root;
    act(() => {
      currentRoot.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  const nextRoot = createRoot(container);
  root = nextRoot;
  act(() => {
    nextRoot.render(node);
  });
}

function dispatchKey(
  key: string,
  init: Omit<KeyboardEventInit, "key"> = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
    key,
  });
  window.dispatchEvent(event);
  return event;
}

describe("SlideoverShell accessibility", () => {
  it("generates unique title ids for each slideover instance", () => {
    render(
      <>
        <SlideoverShell open={true} onClose={vi.fn()} title="First">
          <button type="button">First body</button>
        </SlideoverShell>
        <SlideoverShell open={true} onClose={vi.fn()} title="Second">
          <button type="button">Second body</button>
        </SlideoverShell>
      </>,
    );

    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('aside[role="dialog"]'),
    );
    expect(dialogs).toHaveLength(2);

    const firstTitleId = dialogs[0]?.getAttribute("aria-labelledby");
    const secondTitleId = dialogs[1]?.getAttribute("aria-labelledby");
    expect(firstTitleId).toBeTruthy();
    expect(secondTitleId).toBeTruthy();
    expect(firstTitleId).not.toBe(secondTitleId);
    expect(firstTitleId).not.toBe("slideover-title");
    expect(secondTitleId).not.toBe("slideover-title");

    if (!firstTitleId || !secondTitleId) {
      throw new Error("Expected both slideovers to have title ids");
    }
    expect(document.getElementById(firstTitleId)?.textContent).toBe("First");
    expect(document.getElementById(secondTitleId)?.textContent).toBe("Second");
    const bodyRegions = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.slideover-body[role="region"][tabindex="0"]',
      ),
    );
    expect(bodyRegions).toHaveLength(2);
    expect(bodyRegions[0]?.getAttribute("aria-labelledby")).toBe(firstTitleId);
    expect(bodyRegions[1]?.getAttribute("aria-labelledby")).toBe(secondTitleId);
    expect(
      document.getElementById(
        bodyRegions[0]?.getAttribute("aria-labelledby") ?? "",
      )?.textContent,
    ).toBe("First");
    expect(
      document.getElementById(
        bodyRegions[1]?.getAttribute("aria-labelledby") ?? "",
      )?.textContent,
    ).toBe("Second");
  });

  it("traps Tab and Shift+Tab focus inside the top slideover", () => {
    render(
      <>
        <button type="button" id="outside-before">
          Before
        </button>
        <SlideoverShell
          open={true}
          onClose={vi.fn()}
          title="Focus test"
          footer={
            <button type="button" id="footer-action">
              Done
            </button>
          }
        >
          <button type="button" id="body-action">
            Body action
          </button>
          <input id="body-input" aria-label="Name" />
        </SlideoverShell>
        <button type="button" id="outside-after">
          After
        </button>
      </>,
    );

    const closeButton =
      document.querySelector<HTMLButtonElement>(".slideover-close");
    const bodyAction = document.getElementById("body-action");
    const footerAction = document.getElementById("footer-action");
    const outsideAfter = document.getElementById("outside-after");

    expect(closeButton).not.toBeNull();
    expect(bodyAction).not.toBeNull();
    expect(footerAction).not.toBeNull();
    expect(outsideAfter).not.toBeNull();
    if (!closeButton || !bodyAction || !footerAction || !outsideAfter) {
      throw new Error("Expected slideover focus targets to render");
    }

    expect(document.activeElement).toBe(bodyAction);

    act(() => {
      footerAction.focus();
      dispatchKey("Tab");
    });
    expect(document.activeElement).toBe(closeButton);

    act(() => {
      closeButton.focus();
      dispatchKey("Tab", { shiftKey: true });
    });
    expect(document.activeElement).toBe(footerAction);

    act(() => {
      outsideAfter.focus();
      dispatchKey("Tab");
    });
    expect(document.activeElement).toBe(closeButton);
  });

  it("keeps Escape close, scroll lock, and focus restoration behavior", async () => {
    function StatefulShell(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" id="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <SlideoverShell
            open={open}
            onClose={() => setOpen(false)}
            title="Restoration test"
          >
            <button type="button" id="inside-action">
              Inside
            </button>
          </SlideoverShell>
        </>
      );
    }

    render(<StatefulShell />);

    const trigger = document.getElementById("trigger");
    expect(trigger).not.toBeNull();
    if (!trigger) throw new Error("Expected trigger to render");

    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      trigger.click();
    });

    expect(document.body.style.overflow).toBe("hidden");
    expect(document.activeElement).toBe(
      document.getElementById("inside-action"),
    );
    expect(trigger.inert).toBe(true);
    expect(trigger.getAttribute("aria-hidden")).toBe("true");
    expect(
      document.querySelector<HTMLElement>(".slideover-overlay")?.inert,
    ).toBe(false);

    await act(async () => {
      dispatchKey("Escape");
    });
    await Promise.resolve();

    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute("aria-hidden")).toBe(false);
  });

  it("prevents backdrop pointer focus theft and restores the explicit opener", async () => {
    function BackdropHarness(): ReactElement {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      return (
        <>
          <button
            ref={triggerRef}
            type="button"
            id="backdrop-trigger"
            onClick={() => setOpen(true)}
          >
            Inspect
          </button>
          <SlideoverShell
            open={open}
            onClose={() => setOpen(false)}
            returnFocusRef={triggerRef}
            title="Backdrop restoration"
          >
            <button type="button">Inside</button>
          </SlideoverShell>
        </>
      );
    }

    render(<BackdropHarness />);
    const trigger =
      document.querySelector<HTMLButtonElement>("#backdrop-trigger");
    if (!trigger) throw new Error("Expected backdrop trigger");
    act(() => {
      trigger.focus();
      trigger.click();
    });

    const overlay = document.querySelector<HTMLElement>(
      ".slideover-overlay-v2",
    );
    if (!overlay) throw new Error("Expected slideover backdrop");
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      overlay.dispatchEvent(pointerDown);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(document.querySelector('aside[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("can lock backdrop, Escape, and close controls while busy", () => {
    const onClose = vi.fn();
    render(
      <SlideoverShell
        open={true}
        onClose={onClose}
        title="Busy task"
        subtitle="Upload in progress"
        closeOnBackdrop={false}
        busy
      >
        <button type="button">Cancel upload</button>
      </SlideoverShell>,
    );

    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    const close = document.querySelector<HTMLButtonElement>(".slideover-close");
    const overlay = document.querySelector<HTMLElement>(".slideover-overlay");
    expect(dialog?.getAttribute("aria-busy")).toBe("true");
    expect(dialog?.getAttribute("aria-describedby")).toBeTruthy();
    expect(close?.disabled).toBe(true);

    act(() => {
      overlay?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
      dispatchKey("Escape");
      close?.click();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps composing Escape inert and traps focus with no enabled action", () => {
    const onClose = vi.fn();
    render(
      <SlideoverShell open onClose={onClose} title="Waiting" busy>
        <button type="button" disabled>
          Waiting
        </button>
      </SlideoverShell>,
    );
    const dialog = document.querySelector<HTMLElement>('aside[role="dialog"]');
    act(() => {
      dispatchKey("Escape", { isComposing: true });
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      dispatchKey("Tab");
    });
    expect(document.activeElement).toBe(
      document.querySelector<HTMLElement>(
        '.slideover-body[role="region"][tabindex="0"]',
      ),
    );
    expect(dialog?.contains(document.activeElement)).toBe(true);
  });

  it("releases nested isolation and the original scroll state when both owners close together", async () => {
    function NestedHarness(): ReactElement {
      const [open, setOpen] = useState(false);
      const [confirmOpen, setConfirmOpen] = useState(false);
      return (
        <>
          <button
            id="nested-trigger"
            type="button"
            onClick={() => setOpen(true)}
          >
            Open nested flow
          </button>
          <SlideoverShell
            open={open}
            onClose={() => setOpen(false)}
            title="Outer task"
          >
            <button
              id="nested-decision-trigger"
              type="button"
              onClick={() => setConfirmOpen(true)}
            >
              Open decision
            </button>
          </SlideoverShell>
          <ConfirmModal
            open={confirmOpen}
            title="Finish the task?"
            description="This closes both overlay owners in one update."
            confirmLabel="Finish"
            danger
            onClose={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              setOpen(false);
            }}
          />
        </>
      );
    }

    document.body.style.overflow = "clip";
    render(<NestedHarness />);
    const trigger = document.getElementById("nested-trigger")!;
    act(() => {
      trigger.focus();
      trigger.click();
    });
    act(() => document.getElementById("nested-decision-trigger")?.click());
    expect(
      document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
    ).toHaveLength(2);
    expect(trigger.inert).toBe(true);
    expect(trigger.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      const finish = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent?.trim() === "Finish");
      finish?.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[role="dialog"], [role="alertdialog"]'),
    ).toBeNull();
    expect(trigger.inert).toBe(false);
    expect(trigger.hasAttribute("aria-hidden")).toBe(false);
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(trigger);
  });
});
