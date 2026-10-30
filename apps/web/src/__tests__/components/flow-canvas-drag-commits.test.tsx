// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Dragging a node used to write the in-flight pointer position into React
// state. Pointermove fires at 60-120Hz, so a 25-node flow re-created every node
// button, every SVG edge path and the whole minimap thousands of times a
// second, and the node lagged behind the cursor — on the canvas's core direct
// manipulation gesture.
//
// The gesture is now imperative: the layout position stays on the element as
// left/top and the live offset rides on a transform. These tests pin that
// division, because it is exactly what a well-meaning refactor would undo.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlowCanvas } from "@/app/(dashboard)/app/flows/_components/flow-canvas";
import type { CatalogItem, FlowNode } from "@/lib/flows-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
}

const catalog: CatalogItem[] = [
  {
    key: "send_email",
    label: "Send email",
    category: "message",
    runtime_status: "supported",
  },
  { key: "exit", label: "Exit", category: "control", runtime_status: "supported" },
];

const nodes: FlowNode[] = [
  { id: "a", type: "send_email", template_id: "7" },
  { id: "b", type: "exit" },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

function render(onMove = vi.fn()): {
  container: HTMLElement;
  onMove: ReturnType<typeof vi.fn>;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      createElement(FlowCanvas, {
        nodes,
        edges: [{ from: "a", to: "b" }],
        entryId: "a",
        nodeCatalog: catalog,
        selectedId: null,
        onSelect: () => {},
        onMove,
      }),
    );
  });
  return { container, onMove };
}

function nodeButton(el: HTMLElement, id: string): HTMLButtonElement {
  const btn = el.querySelector<HTMLButtonElement>(`[data-node-id="${id}"]`);
  if (!btn) throw new Error(`no node button for ${id}`);
  return btn;
}

function pointer(el: HTMLElement, type: string, x: number, y: number): void {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 1,
      }),
    );
  });
}

describe("flow canvas drag is imperative", () => {
  it("moves the dragged node by transform while left/top stay at the layout position", () => {
    const { container: el } = render();
    const btn = nodeButton(el, "a");
    const layoutLeft = btn.style.left;
    const layoutTop = btn.style.top;

    pointer(btn, "pointerdown", 100, 100);
    for (let i = 1; i <= 20; i += 1) {
      pointer(btn, "pointermove", 100 + i * 5, 100 + i * 3);
    }

    // 20 pointermoves later the element has moved…
    expect(btn.style.transform).toContain("translate3d(100px, 60px");
    // …without React being handed a new position for it.
    expect(btn.style.left).toBe(layoutLeft);
    expect(btn.style.top).toBe(layoutTop);
  });

  it("leaves the node untouched below the click/drag threshold", () => {
    const { container: el, onMove } = render();
    const btn = nodeButton(el, "a");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 102, 101);

    expect(btn.style.transform).toBe("");
    pointer(btn, "pointerup", 102, 101);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("hands positioning back to React on drop", () => {
    const { container: el, onMove } = render();
    const btn = nodeButton(el, "a");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 180, 160);
    pointer(btn, "pointerup", 180, 160);

    // The committed coordinates arrive as left/top on the next render, so a
    // leftover transform would double the offset.
    expect(btn.style.transform).toBe("");
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("clears the transform when the gesture is cancelled", () => {
    const { container: el, onMove } = render();
    const btn = nodeButton(el, "a");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 180, 160);
    expect(btn.style.transform).not.toBe("");

    pointer(btn, "pointercancel", 180, 160);
    expect(btn.style.transform).toBe("");
    expect(onMove).not.toHaveBeenCalled();
  });
});
