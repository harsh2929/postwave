// @vitest-environment happy-dom
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

import { FlowCanvas } from "@/app/(dashboard)/app/flows/_components/flow-canvas";
import type { CatalogItem, FlowNode } from "@/lib/flows-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no pointer-capture API; the canvas calls it on every drag.
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

function render(props: Partial<React.ComponentProps<typeof FlowCanvas>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(FlowCanvas, {
        nodes,
        edges: [{ from: "a", to: "b" }],
        entryId: "a",
        nodeCatalog: catalog,
        selectedId: null,
        onSelect: () => {},
        ...props,
      }),
    );
  });
  return container;
}

function nodeButton(el: HTMLElement, label: string): HTMLButtonElement {
  const btn = Array.from(el.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  );
  if (!btn) throw new Error(`no node button for ${label}`);
  return btn as HTMLButtonElement;
}

function pointer(btn: HTMLElement, type: string, x: number, y: number) {
  act(() => {
    btn.dispatchEvent(
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

// The canvas had ZERO drag handlers: flow-layout re-derived coordinates by BFS
// on every render, so an operator could not lay a journey out at all. These
// tests pin the two behaviours that are easy to get subtly wrong.
describe("flow canvas drag", () => {
  it("commits a snapped position when a node is dragged", () => {
    const onMove = vi.fn();
    const el = render({ onMove });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 163, 141); // +63, +41
    pointer(btn, "pointerup", 163, 141);

    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, x, y] = onMove.mock.calls[0];
    expect(id).toBe("a");
    // Snapped to the 8px grid, so hand-placed nodes stay aligned with auto-laid ones.
    expect(x % 8).toBe(0);
    expect(y % 8).toBe(0);
  });

  // The subtle one. A click is a pointerdown+pointerup with no movement. If that
  // committed a position, the FIRST time anyone clicked a node to select it the
  // node would silently pin — and the graph would fall out of auto-layout for
  // good, without the operator ever asking for it.
  it("a click selects and does NOT pin the node", () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const el = render({ onMove, onSelect });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointerup", 100, 100);

    expect(onSelect).toHaveBeenCalledWith("a");
    expect(onMove).not.toHaveBeenCalled();
  });

  // Sub-threshold jitter is a click, not a drag: a shaky pointer must not pin.
  it("treats a tiny wobble as a click, not a drag", () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const el = render({ onMove, onSelect });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 102, 101); // 2px — under the 4px threshold
    pointer(btn, "pointerup", 102, 101);

    expect(onSelect).toHaveBeenCalledWith("a");
    expect(onMove).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "lostpointercapture"])(
    "abandons a drag on %s without persisting an interrupted position",
    (eventType) => {
      const onMove = vi.fn();
      const onSelect = vi.fn();
      const el = render({ onMove, onSelect });
      const btn = nodeButton(el, "Send email");

      pointer(btn, "pointerdown", 100, 100);
      pointer(btn, "pointermove", 180, 160);
      pointer(btn, eventType, 180, 160);
      pointer(btn, "pointerup", 180, 160);

      expect(onMove).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  // Keyboard nudging: a drag-only canvas is unusable without a pointer.
  it("nudges a node with the arrow keys", () => {
    const onMove = vi.fn();
    const el = render({ onMove });
    const btn = nodeButton(el, "Send email");

    act(() => {
      btn.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, x] = onMove.mock.calls[0];
    expect(id).toBe("a");
    expect(x % 8).toBe(0);
  });

  // FLOW-034: zoom controls + minimap.
  it("exposes zoom controls that scale the canvas and a minimap", () => {
    const el = render();
    const byLabel = (label: string) =>
      Array.from(el.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === label,
      );
    expect(byLabel("Zoom in")).toBeTruthy();
    expect(byLabel("Zoom out")).toBeTruthy();
    expect(byLabel("Fit to view")).toBeTruthy();
    // The minimap is a named, keyboard-operable navigation control.
    const minimap = el.querySelector(
      'svg[aria-label^="Flow minimap"]',
    ) as SVGSVGElement | null;
    expect(minimap).toBeTruthy();
    expect(minimap?.getAttribute("role")).toBe("button");
    expect(minimap?.getAttribute("tabindex")).toBe("0");

    const scaledStyle = () => {
      const node = Array.from(el.querySelectorAll("div")).find((d) =>
        d.style.transform.includes("scale("),
      );
      return node?.style.transform ?? "";
    };
    const before = scaledStyle();
    act(() => {
      byLabel("Zoom in")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const after = scaledStyle();
    expect(after).toContain("scale(");
    expect(after).not.toBe(before);
  });

  // FLOW-033: drag from a node's output handle to another node creates an edge.
  it("creates an edge by dragging from a connection handle onto a node", () => {
    const onConnect = vi.fn();
    const el = render({ onConnect, onMove: () => {} });
    const handle = el.querySelector(
      'span[data-connect-label^="Drag to connect from a"]',
    ) as HTMLElement | null;
    if (!handle) throw new Error("no connection handle for node a");
    const targetB = el.querySelector('[data-node-id="b"]') as HTMLElement;

    // happy-dom has no elementFromPoint; the drop hit-test relies on it.
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => targetB;
    try {
      pointer(handle, "pointerdown", 100, 200);
      pointer(handle, "pointermove", 150, 260);
      pointer(handle, "pointerup", 150, 260);
    } finally {
      document.elementFromPoint = orig;
    }

    expect(onConnect).toHaveBeenCalledWith("a", "b", undefined);
  });

  // A drag that starts on a connection handle must NOT move the node (the two
  // pointer modes are disambiguated by stopPropagation on the handle).
  it("dragging a connection handle does not reposition the node", () => {
    const onMove = vi.fn();
    const onConnect = vi.fn();
    const el = render({ onMove, onConnect });
    const handle = el.querySelector(
      'span[data-connect-label^="Drag to connect from a"]',
    ) as HTMLElement | null;
    if (!handle) throw new Error("no connection handle for node a");

    pointer(handle, "pointerdown", 100, 200);
    pointer(handle, "pointermove", 200, 300);
    pointer(handle, "pointerup", 200, 300);

    expect(onMove).not.toHaveBeenCalled();
  });

  // Without onMove the canvas is read-only (e.g. version-history preview).
  it("is read-only when no onMove is supplied", () => {
    const onSelect = vi.fn();
    const el = render({ onSelect });
    const btn = nodeButton(el, "Send email");

    pointer(btn, "pointerdown", 100, 100);
    pointer(btn, "pointermove", 200, 200);
    pointer(btn, "pointerup", 200, 200);

    // Still selectable — just not movable.
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith("a");
  });
});
