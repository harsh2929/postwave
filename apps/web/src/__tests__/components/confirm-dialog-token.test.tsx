// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function render(node: React.ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return root;
}

function confirmButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Yes, roll back everything",
  ) as HTMLButtonElement | undefined;
}

describe("ConfirmDialog typed-confirmation gate (MIGR-001)", () => {
  it("returns focus to an explicit trigger for a controlled dialog", async () => {
    function ControlledDialog() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Archive form
          </button>
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={triggerRef}
            title="Archive form?"
            description="The form becomes read-only."
            confirmLabel="Archive"
            onConfirm={() => undefined}
          />
        </>
      );
    }

    const root = render(<ControlledDialog />);
    try {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Archive form",
      );
      act(() => trigger?.click());
      const cancel = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Cancel",
      );
      cancel?.focus();
      await act(async () => {
        cancel?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(document.activeElement).toBe(trigger);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps the destructive button disabled until the token is typed", () => {
    const onConfirm = vi.fn();
    const root = render(
      createElement(ConfirmDialog, {
        open: true,
        onOpenChange: () => {},
        title: "Roll back this migration?",
        description: "This cannot be undone.",
        confirmLabel: "Yes, roll back everything",
        confirmationToken: "DELETE",
        onConfirm,
      }),
    );

    try {
      const btn = confirmButton();
      expect(btn?.disabled).toBe(true);

      const input = document.querySelector(
        'input[placeholder="DELETE"]',
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();

      // Wrong token → still disabled, clicking does nothing.
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "delete");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(confirmButton()?.disabled).toBe(true);

      // Exact token → enabled, clicking fires onConfirm.
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(input, "DELETE");
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(confirmButton()?.disabled).toBe(false);
      act(() => confirmButton()?.click());
      expect(onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("dedupes synchronously, cannot dismiss while pending, and focuses a retryable failure", async () => {
    let rejectFirst: ((reason: Error) => void) | undefined;
    const onConfirm = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    const root = render(
      createElement(ConfirmDialog, {
        open: true,
        onOpenChange,
        title: "Delete this thing?",
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        onConfirm,
      }),
    );

    try {
      const confirm = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete",
      );
      const cancel = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Cancel",
      );
      const close = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Close",
      );
      await act(async () => {
        confirm?.click();
        cancel?.click();
        confirm?.click();
        await Promise.resolve();
      });
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(
        document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(close?.disabled).toBe(true);
      expect(close?.getAttribute("aria-disabled")).toBe("true");
      act(() => close?.click());
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();

      await act(async () => {
        rejectFirst?.(new Error("The server refused this deletion."));
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const alert = document.querySelector<HTMLElement>('[role="alert"]');
      expect(alert?.textContent).toContain("server refused");
      expect(document.activeElement).toBe(alert);

      const retry = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete",
      );
      await act(async () => {
        retry?.click();
        await Promise.resolve();
      });
      expect(onConfirm).toHaveBeenCalledTimes(2);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it("moves focus to a surviving fallback when success removes its trigger", async () => {
    function RemovingRow() {
      const [present, setPresent] = useState(true);
      const fallbackRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={fallbackRef} type="button">
            Add another item
          </button>
          {present ? (
            <ConfirmDialog
              trigger={<button type="button">Delete row</button>}
              title="Delete row?"
              description="The row disappears immediately."
              confirmLabel="Delete"
              fallbackFocusRef={fallbackRef}
              onConfirm={() => setPresent(false)}
            />
          ) : null}
        </>
      );
    }

    const root = render(<RemovingRow />);
    try {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete row",
      );
      act(() => trigger?.click());
      const confirm = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete",
      );
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(document.activeElement?.textContent).toBe("Add another item");
    } finally {
      act(() => root.unmount());
    }
  });

  it("moves focus to a fallback when success leaves its trigger disabled", async () => {
    function DisabledTrigger() {
      const [disabled, setDisabled] = useState(false);
      const fallbackRef = useRef<HTMLHeadingElement>(null);
      return (
        <>
          <h2 ref={fallbackRef} tabIndex={-1}>
            Remaining items
          </h2>
          <ConfirmDialog
            trigger={
              <button type="button" disabled={disabled}>
                Delete all
              </button>
            }
            title="Delete everything?"
            description="The trigger remains mounted but becomes unavailable."
            confirmLabel="Delete"
            fallbackFocusRef={fallbackRef}
            onConfirm={() => setDisabled(true)}
          />
        </>
      );
    }

    const root = render(<DisabledTrigger />);
    try {
      const trigger = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete all",
      );
      act(() => trigger?.click());
      const confirm = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Delete",
      );
      await act(async () => {
        confirm?.click();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(trigger?.disabled).toBe(true);
      expect(document.activeElement?.textContent).toBe("Remaining items");
    } finally {
      act(() => root.unmount());
    }
  });
});
