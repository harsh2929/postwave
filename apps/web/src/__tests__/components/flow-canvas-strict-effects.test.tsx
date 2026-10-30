// @vitest-environment happy-dom
//
// The canvas commits a drag and a drag-to-connect from inside setState updater
// functions. React requires updaters to be PURE — it may invoke them more than
// once for a single update, and next.config.mjs sets reactStrictMode:true, so
// it demonstrably does. Every commit path here lands in flow-editor's setGraph,
// which pushes an undo-history entry; pushHistory only dedupes on Object.is and
// updateNode/setNext build a fresh object each call, so a double invocation
// records TWO history entries for one gesture and the first Ctrl+Z appears to
// do nothing.
//
// flow-canvas-drag.test.tsx renders WITHOUT StrictMode, which is why it never
// caught this. These render the same interactions the way the app runs them.
import { StrictMode, act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

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
  {
    key: "exit",
    label: "Exit",
    category: "control",
    runtime_status: "supported",
  },
];

const nodes: FlowNode[] = [
  { id: "a", type: "send_email", template_id: "7" },
  { id: "b", type: "exit" },
];

let container: HTMLDivElement | null = null;

afterEach(() => {
  unmountRoots();
  container?.remove();
  container = null;
});

function renderStrict(
  props: Partial<React.ComponentProps<typeof FlowCanvas>> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(FlowCanvas, {
          nodes,
          edges: [{ from: "a", to: "b" }],
          entryId: "a",
          nodeCatalog: catalog,
          selectedId: null,
          onSelect: () => {},
          ...props,
        }),
      ),
    );
  });
  return container;
}

function pointer(el: HTMLElement, type: string, x: number, y: number) {
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

function nodeButton(el: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`no node button for ${label}`);
  return btn as HTMLButtonElement;
}

describe("flow canvas commits exactly once under StrictMode", () => {
  it("a drag persists one position, not two", () => {
    const onMove = vi.fn();
    const el = renderStrict({ onMove });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 163, 141);
    pointer(btn, "pointerup", 163, 141);

    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("a click selects once", () => {
    const onSelect = vi.fn();
    const el = renderStrict({ onSelect, onMove: () => {} });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointerup", 100, 100);

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a drag-to-connect creates one edge, not two", () => {
    const onConnect = vi.fn();
    const el = renderStrict({ onConnect, onMove: () => {} });
    const handle = el.querySelector(
      'span[data-connect-label^="Drag to connect from a"]',
    );
    if (!handle) throw new Error("no connection handle for node a");
    const targetB = el.querySelector('[data-node-id="b"]') as HTMLElement;

    const orig = document.elementFromPoint;
    document.elementFromPoint = () => targetB;
    try {
      pointer(handle as HTMLElement, "pointerdown", 100, 200);
      pointer(handle as HTMLElement, "pointermove", 150, 260);
      pointer(handle as HTMLElement, "pointerup", 150, 260);
    } finally {
      document.elementFromPoint = orig;
    }

    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith("a", "b", undefined);
  });
});
