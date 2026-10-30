// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { LibraryGrid } from "../../components/library/LibraryGrid";
import { LibraryList } from "../../components/library/LibraryList";
import type { Asset } from "../../lib/api-client";
import {
  applySelection,
  type SelectionEvent,
  type SelectionState,
} from "../../lib/library-selection";

const assets: Asset[] = ["a", "b", "c", "d"].map((id, index) => ({
  id,
  tenantId: "00000000-0000-4000-8000-000000000001",
  filename: `${id}.png`,
  mime: index === 3 ? "image/gif" : "image/png",
  bytes: 1000 + index,
  width: 100,
  height: 100,
  url: `/assets/${id}.${index === 3 ? "gif" : "png"}`,
  createdAt: `2026-07-1${index + 1}T00:00:00Z`,
  updatedAt: `2026-07-1${index + 1}T00:00:00Z`,
  version: 1,
  referencesCount: index,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function Harness({
  mode,
  onOpen,
  onCopy,
  onDelete,
}: {
  mode: "grid" | "list";
  onOpen: (id: string) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
}): ReactElement {
  const [selection, setSelection] = useState<SelectionState>({
    selected: new Set(),
    focusId: null,
  });
  const onSelection = (event: SelectionEvent): void => {
    setSelection((current) =>
      applySelection(
        current,
        assets.map((asset) => asset.id),
        event,
      ),
    );
  };
  return mode === "grid" ? (
    <LibraryGrid
      assets={assets}
      selection={selection}
      density="cozy"
      rowSize={2}
      onSelection={onSelection}
      onOpenQuickLook={onOpen}
      onCopyUrl={onCopy}
      onDelete={onDelete}
    />
  ) : (
    <LibraryList
      assets={assets}
      selection={selection}
      onSelection={onSelection}
      onOpenQuickLook={onOpen}
      onCopyUrl={onCopy}
      onDelete={onDelete}
    />
  );
}

function renderHarness(mode: "grid" | "list") {
  const callbacks = {
    onOpen: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness mode={mode} {...callbacks} />));
  return callbacks;
}

function primary(id: string): HTMLButtonElement {
  const element = container?.querySelector<HTMLButtonElement>(
    `[data-library-primary="${id}"]`,
  );
  if (!element) throw new Error(`Missing primary asset control ${id}`);
  return element;
}

function key(
  target: HTMLElement,
  value: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("Library native collection keyboard model", () => {
  it.each(["grid", "list"] as const)(
    "uses completed click as the canonical %s activation boundary",
    (mode) => {
      renderHarness(mode);
      const target = primary("a");

      act(() => {
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
          }),
        );
        target.dispatchEvent(
          new PointerEvent("pointercancel", {
            bubbles: true,
            pointerId: 7,
            pointerType: "touch",
          }),
        );
      });
      expect(target.getAttribute("aria-pressed")).toBe("false");

      // HTMLElement.click() models the untrusted/synthetic click emitted by
      // assistive technology. It must activate without a preceding pointer.
      act(() => target.click());
      expect(target.getAttribute("aria-pressed")).toBe("true");

      // A touch scroll/cancel followed by no click remains inert; a completed
      // gesture contributes exactly one click, not pointer-down + click.
      act(() => {
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            ctrlKey: true,
            pointerId: 8,
            pointerType: "touch",
          }),
        );
        target.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            ctrlKey: true,
            pointerId: 8,
            pointerType: "touch",
          }),
        );
        target.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
          }),
        );
      });
      expect(target.getAttribute("aria-pressed")).toBe("false");
    },
  );

  it("uses a roving primary control with Space-select and Enter-open", () => {
    const callbacks = renderHarness("grid");
    expect(container?.querySelector('[role="listbox"]')).toBeNull();
    expect(container?.querySelector('[role="option"]')).toBeNull();
    expect(container?.querySelector("button button")).toBeNull();
    expect(container?.textContent).toContain("No reported use");
    expect(container?.textContent).not.toContain("Unused");
    expect(
      container?.querySelector(
        '[data-asset-id="d"] [data-asset-image-state="paused"]',
      ),
    ).not.toBeNull();
    expect(primary("a").tabIndex).toBe(0);
    expect(primary("b").tabIndex).toBe(-1);

    act(() => primary("a").focus());
    const composingEnter = key(primary("a"), "Enter", { isComposing: true });
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(callbacks.onOpen).not.toHaveBeenCalled();
    key(primary("a"), " ");
    expect(primary("a").getAttribute("aria-pressed")).toBe("true");
    expect(callbacks.onOpen).not.toHaveBeenCalled();

    key(primary("a"), "Enter");
    expect(callbacks.onOpen).toHaveBeenCalledWith("a");
    expect(primary("a").getAttribute("aria-pressed")).toBe("true");

    key(primary("a"), "a", { ctrlKey: true });
    for (const asset of assets) {
      expect(primary(asset.id).getAttribute("aria-pressed")).toBe("true");
    }
    key(primary("a"), "Escape");
    for (const asset of assets) {
      expect(primary(asset.id).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("moves DOM focus with arrows/Home/End and extends a complete range", () => {
    renderHarness("grid");
    act(() => primary("a").focus());
    key(primary("a"), "ArrowRight");
    expect(document.activeElement).toBe(primary("b"));
    key(primary("b"), "ArrowDown", { shiftKey: true });
    expect(document.activeElement).toBe(primary("d"));
    for (const id of ["b", "c", "d"]) {
      expect(primary(id).getAttribute("aria-pressed")).toBe("true");
    }
    key(primary("d"), "Home");
    expect(document.activeElement).toBe(primary("a"));
    key(primary("a"), "End");
    expect(document.activeElement).toBe(primary("d"));
  });

  it("keeps active-card actions reachable and leaves context menus native", () => {
    const callbacks = renderHarness("grid");
    act(() => primary("a").focus());
    const preview = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview a.png"]',
    );
    const copy = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy URL for a.png"]',
    );
    const remove = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete a.png"]',
    );
    expect(preview?.tabIndex).toBe(0);
    expect(copy?.tabIndex).toBe(0);
    expect(remove?.tabIndex).toBe(0);
    expect(
      container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Preview b.png"]',
      )?.tabIndex,
    ).toBe(-1);
    act(() => preview?.click());
    act(() => copy?.click());
    act(() => remove?.click());
    expect(callbacks.onOpen).toHaveBeenCalledWith("a");
    expect(callbacks.onCopy).toHaveBeenCalledWith("a");
    expect(callbacks.onDelete).toHaveBeenCalledWith("a");

    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    expect(primary("a").dispatchEvent(context)).toBe(true);
    expect(context.defaultPrevented).toBe(false);
    const keyboardContext = key(primary("a"), "F10", { shiftKey: true });
    expect(keyboardContext.defaultPrevented).toBe(false);
  });

  it("keeps list semantics, actions, focus and native context behavior", () => {
    const callbacks = renderHarness("list");
    expect(container?.querySelector("table")?.getAttribute("aria-label")).toBe(
      "Assets",
    );
    expect(container?.querySelectorAll("th[scope='col']")).toHaveLength(6);
    expect(container?.querySelector('[role="listbox"]')).toBeNull();
    expect(container?.querySelector("button button")).toBeNull();
    act(() => primary("a").focus());
    expect(
      container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy URL for a.png"]',
      )?.tabIndex,
    ).toBe(0);
    key(primary("a"), "ArrowDown");
    expect(document.activeElement).toBe(primary("b"));
    expect(
      container?.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy URL for a.png"]',
      )?.tabIndex,
    ).toBe(-1);
    const copy = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy URL for b.png"]',
    );
    const remove = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete b.png"]',
    );
    expect(copy?.tabIndex).toBe(0);
    expect(remove?.tabIndex).toBe(0);
    key(primary("b"), "Enter");
    expect(callbacks.onOpen).toHaveBeenCalledWith("b");
    expect(primary("b").getAttribute("aria-pressed")).toBe("false");
    act(() => copy?.click());
    act(() => remove?.click());
    expect(callbacks.onCopy).toHaveBeenCalledWith("b");
    expect(callbacks.onDelete).toHaveBeenCalledWith("b");

    const context = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    expect(primary("b").dispatchEvent(context)).toBe(true);
    expect(context.defaultPrevented).toBe(false);
    expect(key(primary("b"), "F10", { shiftKey: true }).defaultPrevented).toBe(
      false,
    );
  });

  it("has no serious automated accessibility violations in either view", async () => {
    const callbacks = renderHarness("grid");
    for (const mode of ["grid", "list"] as const) {
      if (mode === "list") {
        act(() => root?.render(<Harness mode={mode} {...callbacks} />));
      }
      const result = await axe.run(container ?? document.body);
      expect(
        result.violations.filter(
          (violation) =>
            violation.impact === "critical" || violation.impact === "serious",
        ),
      ).toEqual([]);
    }
  });
});
