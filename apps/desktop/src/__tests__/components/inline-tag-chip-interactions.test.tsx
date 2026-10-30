// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AddTagButton,
  InlineTagChip,
} from "../../components/subscribers/InlineTagChip";

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
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

function inputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

describe("inline tag interactions", () => {
  it("coalesces removal and surfaces a retryable failure", async () => {
    const pending = deferred<void>();
    const onRemove = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error("network offline"));
    render(<InlineTagChip tag="vip" onRemove={onRemove} />);

    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove tag vip"]',
    );
    act(() => {
      remove?.click();
      remove?.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(remove?.disabled).toBe(false);
    expect(remove?.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      pending.resolve();
      await pending.promise;
    });
    act(() => remove?.click());
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain(
      "Remove failed: network offline",
    );
    expect(remove?.getAttribute("aria-disabled")).toBeNull();
    expect(document.querySelector("[title]")).toBeNull();
  });

  it("parses a pasted list once, ignores composing Enter, and restores focus", async () => {
    const first = deferred<void>();
    const onAdd = vi
      .fn<(tag: string) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    render(<AddTagButton onAdd={onAdd} />);
    const trigger = button("+ Tag");
    act(() => trigger.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Tags to add"]',
    );
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    inputValue(input!, "vip, churned; vip");

    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(onAdd).not.toHaveBeenCalled();

    const enter = (): void => {
      input?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    };
    act(() => {
      enter();
      enter();
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenNthCalledWith(1, "vip");
    expect(document.body.textContent).toContain("Adding tags…");

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd).toHaveBeenNthCalledWith(2, "churned");
    await waitFor(() => expect(button("+ Tag")).toBeTruthy());
    await act(async () => Promise.resolve());
    expect(document.activeElement).toBe(button("+ Tag"));
    expect(document.querySelector("[title]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("retains the draft and explains safe retry after a partial failure", async () => {
    const onAdd = vi
      .fn<(tag: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second tag failed"))
      .mockResolvedValue(undefined);
    render(<AddTagButton onAdd={onAdd} />);
    act(() => button("+ Tag").click());
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Tags to add"]',
    )!;
    inputValue(input, "first, second");
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("second tag failed"),
    );
    expect(input.value).toBe("first, second");
    expect(document.body.textContent).toContain(
      "Some tags may already be present; retrying is safe.",
    );
  });
});
