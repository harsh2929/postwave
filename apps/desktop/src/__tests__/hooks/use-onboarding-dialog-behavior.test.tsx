// @vitest-environment happy-dom

import { act, type ReactElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useOnboardingDialogBehavior } from "../../hooks/useOnboardingDialogBehavior";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function Harness({ onEscape }: { onEscape: () => void }): ReactElement {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useOnboardingDialogBehavior({
    open: true,
    suspended: false,
    ownerId: "test:onboarding-dialog",
    dialogRef,
    initialFocusRef: dialogRef,
    onEscape,
  });
  return (
    <div ref={dialogRef} role="dialog" aria-label="Setup" tabIndex={-1}>
      Waiting for workspace state
    </div>
  );
}

function render(onEscape: () => void): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness onEscape={onEscape} />));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error("Missing dialog");
  return dialog;
}

function key(value: string, options: KeyboardEventInit = {}): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: value,
        ...options,
      }),
    );
  });
}

describe("useOnboardingDialogBehavior", () => {
  it("keeps composing Escape inert and routes real Escape once", () => {
    const onEscape = vi.fn();
    render(onEscape);
    key("Escape", { isComposing: true });
    expect(onEscape).not.toHaveBeenCalled();
    key("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("retains focus when a suspended-state handoff leaves no enabled control", () => {
    const dialog = render(vi.fn());
    expect(document.activeElement).toBe(dialog);
    key("Tab");
    expect(document.activeElement).toBe(dialog);
  });
});
