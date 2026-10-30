// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "../../components/ConfirmModal";

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
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function type(value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    '[role="alertdialog"] input',
  );
  if (!input) throw new Error("Confirmation input not found");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function Harness({
  onConfirm,
}: {
  onConfirm: () => void | Promise<void>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <ConfirmModal
        open={open}
        title="Delete production data?"
        description="This cannot be undone."
        confirmLabel="Delete"
        danger
        typeToConfirm="DELETE"
        onConfirm={onConfirm}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe("ConfirmModal high-consequence contract", () => {
  it("requires an exact match, starts on Cancel, blocks backdrop dismissal, and resets every open", () => {
    render(<Harness onConfirm={vi.fn()} />);

    act(() => button("Open").click());
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(button("Cancel"));
    expect(button("Delete").disabled).toBe(true);

    type(" DELETE ");
    expect(button("Delete").disabled).toBe(true);
    type("DELETE");
    expect(button("Delete").disabled).toBe(false);

    const backdrop = document.querySelector<HTMLElement>(".modal-backdrop");
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    act(() => button("Cancel").click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    act(() => button("Open").click());
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("");
    expect(button("Delete").disabled).toBe(true);
  });

  it("is single-flight and exposes an accessible busy state", async () => {
    let resolve: (() => void) | undefined;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const onConfirm = vi.fn(() => pending);
    render(<Harness onConfirm={onConfirm} />);
    act(() => button("Open").click());
    type("DELETE");

    await act(async () => {
      button("Delete").click();
      button("Delete").click();
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button("Working…").getAttribute("aria-busy")).toBe("true");
    expect(button("Working…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);

    await act(async () => {
      resolve?.();
      await pending;
    });
    expect(button("Delete").disabled).toBe(false);
  });

  it("contains rejected actions and reports a local retryable error", async () => {
    render(
      <Harness onConfirm={() => Promise.reject(new Error("secret detail"))} />,
    );
    act(() => button("Open").click());
    type("DELETE");
    await act(async () => {
      button("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const alert = document.querySelector<HTMLElement>(".field-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("couldn't be completed");
    expect(alert?.textContent).not.toContain("secret detail");
  });
});
