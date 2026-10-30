// SPDX-License-Identifier: AGPL-3.0-only
//
// Canvas for the visual flow-builder: a layered node graph drawn from the AST.
// Edges are SVG beziers with an arrowhead and optional Yes/No branch labels.
// Nodes are draggable (position PINS a node; auto-layout otherwise). Node
// summaries, edge/label colours, orphan flagging, validation flagging, and the
// empty state all read from shared theme tokens / helpers so they stay
// consistent and flip correctly in dark mode.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Maximize2, Minus, Plus } from "lucide-react";

import {
  GRID,
  NODE_H,
  NODE_W,
  computeFlowLayout,
  edgePath,
  reachableNodeIds,
  snapToGrid,
} from "@/lib/flow-layout";
import {
  type CatalogItem,
  type ConditionFieldSpec,
  type FlowEdge,
  type FlowNode,
  runtimeStatusMeta,
} from "@/lib/flows-api";
import { nodeSummary } from "@/lib/flow-graph";
import { type NodeDropOff, formatPercent } from "@/lib/flow-analytics";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const CATEGORY_STYLE: Record<string, string> = {
  message: "border-sky-300 bg-sky-50 dark:bg-sky-950/40",
  wait: "border-violet-300 bg-violet-50 dark:bg-violet-950/40",
  split: "border-amber-300 bg-amber-50 dark:bg-amber-950/40",
  action: "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40",
  goal: "border-rose-300 bg-rose-50 dark:bg-rose-950/40",
  control: "border-zinc-300 bg-zinc-50 dark:bg-zinc-900/40",
};

/** Movement under this many px is a click, not a drag. */
const DRAG_THRESHOLD = 4;

// FLOW-034: zoom + minimap geometry.
const MIN_SCALE = 0.25;
const MAX_SCALE = 1.5;
const SCALE_STEP = 0.15;
const MINIMAP_MAX = 180; // px — the minimap's longest edge.

interface DragState {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  moved: boolean;
}

interface FlowCanvasProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  entryId?: string;
  nodeCatalog: CatalogItem[];
  conditionFields?: ConditionFieldSpec[];
  /** Resolve a send_email node's template_id to its name (FLOW-016). */
  resolveTemplateName?: (id: string) => string | undefined;
  selectedId: string | null;
  /** node ids flagged by a validation error (FLOW-023). */
  flaggedNodeIds?: Set<string>;
  /** per-node drop-off from flow analytics (FLOW-007). */
  nodeDropOff?: Map<string, NodeDropOff>;
  onSelect: (id: string) => void;
  /** Commit a node's new position. Omit to render a read-only canvas. */
  onMove?: (id: string, x: number, y: number) => void;
  /**
   * Create an edge by dragging from a node's output/branch handle to a target
   * node (FLOW-033). leg distinguishes a branch's true/false legs; omit for a
   * linear next. Omit the whole prop to hide connection handles.
   */
  onConnect?: (fromId: string, toId: string, leg?: "true" | "false") => void;
  /** Delete the node (Delete/Backspace on a focused node — FLOW-017). */
  onDeleteNode?: (id: string) => void;
  /** Seed a first step from the empty state (FLOW-031). */
  onAddFirstStep?: () => void;
}

// FLOW-033: a small draggable output/branch handle. This is a pointer shortcut,
// hidden from the accessibility tree because keyboard users wire the exact
// same connection through the named config-panel dropdowns.
function ConnectHandle({
  x,
  y,
  label,
  onStart,
  onMove,
  onEnd,
}: {
  x: number;
  y: number;
  label: string;
  onStart: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onMove: (e: React.PointerEvent<HTMLSpanElement>) => void;
  onEnd: (e: React.PointerEvent<HTMLSpanElement>) => void;
}) {
  return (
    <span
      aria-hidden="true"
      data-connect-label={label}
      title="Drag to connect"
      className="absolute z-20 h-11 w-11 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full before:absolute before:left-1/2 before:top-1/2 before:h-3 before:w-3 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:border-2 before:border-background before:bg-primary before:shadow-sm before:transition-transform before:content-[''] hover:before:scale-150"
      style={{ left: x, top: y, touchAction: "none" }}
      onPointerDown={onStart}
      onPointerMove={onMove}
      onPointerUp={onEnd}
    />
  );
}

export function FlowCanvas({
  nodes,
  edges,
  entryId,
  nodeCatalog,
  conditionFields = [],
  resolveTemplateName,
  selectedId,
  flaggedNodeIds,
  nodeDropOff,
  onSelect,
  onMove,
  onConnect,
  onDeleteNode,
  onAddFirstStep,
}: FlowCanvasProps) {
  const layout = useMemo(
    () => computeFlowLayout(nodes, edges, entryId),
    [nodes, edges, entryId],
  );
  const reachable = useMemo(
    () => reachableNodeIds(nodes, edges, entryId),
    [nodes, edges, entryId],
  );
  // The live drag lives in a ref, not in state. Pointermove fires at 60-120Hz
  // and a state write per event re-rendered every node, every edge path and the
  // minimap — thousands of React elements a second for a gesture that moves ONE
  // box. The moving node is positioned imperatively (a transform, so no layout
  // pass); React state changes exactly twice per drag: when the gesture crosses
  // the click/drag threshold, and when it ends.
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<{
    id: string;
    moved: boolean;
  } | null>(null);
  const draggable = typeof onMove === "function";

  // FLOW-034: zoom + minimap. The scroll container is measured for fit-to-view
  // and to project the viewport rectangle onto the minimap.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const zoomTo = useCallback((next: number) => {
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
  }, []);
  const updateViewport = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({
      left: el.scrollLeft,
      top: el.scrollTop,
      width: el.clientWidth,
      height: el.clientHeight,
    });
  }, []);
  const fitToView = useCallback(() => {
    const el = scrollRef.current;
    if (!el || layout.width === 0 || layout.height === 0) return;
    const next = Math.min(
      el.clientWidth / layout.width,
      el.clientHeight / layout.height,
      1,
    );
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
    el.scrollTo({ left: 0, top: 0 });
  }, [layout.width, layout.height]);
  // Keep the minimap viewport rectangle in sync with resize + zoom.
  useEffect(() => {
    updateViewport();
  }, [updateViewport, scale, layout.width, layout.height]);
  // The minimap projects the whole canvas into MINIMAP_MAX on its longest edge.
  const minimapScale =
    layout.width > 0 && layout.height > 0
      ? MINIMAP_MAX / Math.max(layout.width, layout.height)
      : 0;

  // FLOW-033: drag-to-connect. A separate pointer mode from move-drag, started
  // on a node's output/branch handle, drawing an in-progress edge to the pointer
  // and creating an edge on drop over another node.
  const canConnect = typeof onConnect === "function";
  const [connecting, setConnecting] = useState<{
    fromId: string;
    leg?: "true" | "false";
    anchorX: number;
    anchorY: number;
    toX: number;
    toY: number;
  } | null>(null);
  const toCanvasCoords = useCallback(
    (clientX: number, clientY: number) => {
      const el = scrollRef.current;
      if (!el) return { x: clientX, y: clientY };
      const rect = el.getBoundingClientRect();
      return {
        x: (clientX - rect.left + el.scrollLeft) / scale,
        y: (clientY - rect.top + el.scrollTop) / scale,
      };
    },
    [scale],
  );
  const startConnect = useCallback(
    (
      e: React.PointerEvent<HTMLSpanElement>,
      fromId: string,
      anchorX: number,
      anchorY: number,
      leg?: "true" | "false",
    ) => {
      if (e.button !== 0) return;
      // Do NOT let the handle's pointerdown bubble to the node's move-drag.
      e.stopPropagation();
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setConnecting({
        fromId,
        leg,
        anchorX,
        anchorY,
        toX: anchorX,
        toY: anchorY,
      });
    },
    [],
  );
  const moveConnect = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const point = toCanvasCoords(e.clientX, e.clientY);
      setConnecting((cur) =>
        cur ? { ...cur, toX: point.x, toY: point.y } : cur,
      );
    },
    [toCanvasCoords],
  );
  const endConnect = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      // Read the gesture from state and clear it with a plain value. The hit
      // test and onConnect used to live inside the setConnecting updater, but
      // React may invoke an updater more than once per update (StrictMode does
      // it every time), and each onConnect lands in flow-editor's setGraph —
      // which pushes an undo entry. One drag recorded two, so the first Ctrl+Z
      // looked like it did nothing. Updaters must stay pure.
      const cur = connecting;
      setConnecting(null);
      if (!cur || !canConnect) return;
      // elementFromPoint works in screen space, so it is correct regardless
      // of zoom/scroll.
      const target = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest("[data-node-id]");
      const toId = target?.getAttribute("data-node-id") ?? "";
      if (toId && toId !== cur.fromId) {
        onConnect?.(cur.fromId, toId, cur.leg);
      }
    },
    [canConnect, connecting, onConnect],
  );

  const handlePointerDown = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      id: string,
      x: number,
      y: number,
    ) => {
      if (!draggable || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        id,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: x,
        originY: y,
        x,
        y,
        moved: false,
      };
      setDragging({ id, moved: false });
    },
    [draggable],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
      const cur = dragRef.current;
      if (!cur || cur.id !== id || cur.pointerId !== e.pointerId) return;
      const dx = e.clientX - cur.startX;
      const dy = e.clientY - cur.startY;
      // FLOW-034: pointer deltas are screen px; divide by scale so a drag
      // still tracks the cursor when the canvas is zoomed.
      cur.x = cur.originX + dx / scale;
      cur.y = cur.originY + dy / scale;
      if (
        !cur.moved &&
        (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
      ) {
        // One state write per gesture: this is what flips the node into its
        // "being dragged" treatment and turns a click into a move.
        cur.moved = true;
        setDragging({ id, moved: true });
      }
      // Below the threshold the node stays put — a shaky click must not nudge
      // anything. The scale factor mirrors the `scale-[1.02]` class, which an
      // inline transform would otherwise override.
      e.currentTarget.style.transform = cur.moved
        ? `translate3d(${dx / scale}px, ${dy / scale}px, 0) scale(1.02)`
        : "";
    },
    [scale],
  );

  const handlePointerInterruption = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
      const cur = dragRef.current;
      if (!cur || cur.id !== id || cur.pointerId !== e.pointerId) return;
      dragRef.current = null;
      e.currentTarget.style.transform = "";
      setDragging(null);
    },
    [],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, id: string) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Same purity rule as endConnect: commit outside the updater, otherwise
      // one drag pushes two identical positions onto the undo stack and one
      // click selects twice.
      const cur = dragRef.current;
      if (!cur || cur.id !== id || cur.pointerId !== e.pointerId) return;
      dragRef.current = null;
      // Hand positioning back to React: the committed coordinates arrive as
      // left/top on the next render.
      e.currentTarget.style.transform = "";
      setDragging(null);
      if (!cur.moved) {
        onSelect(id);
      } else {
        onMove?.(id, snapToGrid(cur.x), snapToGrid(cur.y));
      }
    },
    [onMove, onSelect],
  );

  // Keyboard: arrow keys nudge a node; Delete/Backspace remove it (FLOW-017).
  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLButtonElement>,
      id: string,
      x: number,
      y: number,
    ) => {
      if ((e.key === "Delete" || e.key === "Backspace") && onDeleteNode) {
        e.preventDefault();
        onDeleteNode(id);
        return;
      }
      if (!draggable) return;
      const step = e.shiftKey ? GRID * 4 : GRID;
      let nx = x;
      let ny = y;
      switch (e.key) {
        case "ArrowLeft":
          nx -= step;
          break;
        case "ArrowRight":
          nx += step;
          break;
        case "ArrowUp":
          ny -= step;
          break;
        case "ArrowDown":
          ny += step;
          break;
        default:
          return;
      }
      e.preventDefault();
      onMove?.(id, snapToGrid(nx), snapToGrid(ny));
    },
    [draggable, onMove, onDeleteNode],
  );

  const labelFor = useMemo(() => {
    const m = new Map<string, CatalogItem>();
    for (const c of nodeCatalog) m.set(c.key, c);
    return m;
  }, [nodeCatalog]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full min-h-[320px] items-center justify-center p-6">
        <EmptyState
          icon={GitBranch}
          title="Start building your flow"
          description="Add a step from the palette on the left, or drop in a first email to get going."
          action={
            onAddFirstStep ? (
              <Button type="button" onClick={onAddFirstStep}>
                Add your first step
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div
        ref={scrollRef}
        onScroll={updateViewport}
        tabIndex={0}
        role="region"
        aria-label="Flow canvas"
        className="h-full w-full overflow-auto bg-[radial-gradient(circle,theme(colors.zinc.200)_1px,transparent_1px)] bg-[length:24px_24px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:bg-[radial-gradient(circle,theme(colors.zinc.800)_1px,transparent_1px)]"
      >
        {/* Outer sizer carries the SCALED dimensions so the scrollbars match
            the zoomed content (transform:scale does not resize the box). */}
        <div
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            className="relative"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
            }}
          >
            <svg
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
            >
              <defs>
                <marker
                  id="flow-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  {/* Theme-driven so edges flip with light/dark (FLOW-037). */}
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    className="fill-muted-foreground"
                  />
                </marker>
              </defs>
              {layout.edges.map((e) => {
                const from = layout.nodes.get(e.from);
                const to = layout.nodes.get(e.to);
                if (!from || !to) return null;
                const midX = (from.x + to.x) / 2 + NODE_W / 2;
                const midY = (from.y + NODE_H + to.y) / 2;
                return (
                  <g key={`${e.from}-${e.to}-${e.label ?? ""}`}>
                    <path
                      d={edgePath(from, to)}
                      className="fill-none stroke-muted-foreground/50"
                      strokeWidth={1.5}
                      markerEnd="url(#flow-arrow)"
                    />
                    {e.label ? (
                      <text
                        x={midX}
                        y={midY}
                        className="fill-muted-foreground text-[10px] font-medium"
                        textAnchor="middle"
                      >
                        {e.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {/* FLOW-033: in-progress connection line. */}
              {connecting ? (
                <line
                  x1={connecting.anchorX}
                  y1={connecting.anchorY}
                  x2={connecting.toX}
                  y2={connecting.toY}
                  className="stroke-primary"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                />
              ) : null}
            </svg>

            {nodes.map((node) => {
              const pos = layout.nodes.get(node.id);
              if (!pos) return null;
              const meta = labelFor.get(node.type);
              const status = meta?.runtime_status ?? "planned";
              const statusMeta = runtimeStatusMeta(status);
              const isEntry = node.id === entryId;
              const isSelected = node.id === selectedId;
              const isFlagged = flaggedNodeIds?.has(node.id) ?? false;
              const isOrphan = !isEntry && !reachable.has(node.id);
              const isDragging = dragging?.id === node.id && dragging.moved;
              // Position stays authoritative in layout coordinates; the live
              // gesture rides on top of it as a transform.
              const left = pos.x;
              const top = pos.y;
              return (
                <button
                  key={node.id}
                  type="button"
                  data-node-id={node.id}
                  onClick={draggable ? undefined : () => onSelect(node.id)}
                  onPointerDown={(e) =>
                    handlePointerDown(e, node.id, pos.x, pos.y)
                  }
                  onPointerMove={(e) => handlePointerMove(e, node.id)}
                  onPointerUp={(e) => handlePointerUp(e, node.id)}
                  onPointerCancel={(e) => handlePointerInterruption(e, node.id)}
                  onLostPointerCapture={(e) =>
                    handlePointerInterruption(e, node.id)
                  }
                  onKeyDown={(e) => handleKeyDown(e, node.id, pos.x, pos.y)}
                  aria-grabbed={isDragging || undefined}
                  aria-pressed={isSelected}
                  style={{
                    left,
                    top,
                    width: NODE_W,
                    height: NODE_H,
                    touchAction: draggable ? "none" : undefined,
                  }}
                  className={cn(
                    "absolute flex flex-col gap-1 rounded-lg border p-3 text-left shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    CATEGORY_STYLE[meta?.category ?? "control"] ??
                      CATEGORY_STYLE.control,
                    draggable &&
                      (isDragging ? "cursor-grabbing" : "cursor-grab"),
                    isDragging && "z-10 scale-[1.02] shadow-lg transition-none",
                    isFlagged
                      ? "ring-2 ring-destructive ring-offset-1"
                      : isSelected
                        ? "ring-2 ring-primary ring-offset-1"
                        : "hover:shadow-md",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {meta?.label ?? node.type}
                    </span>
                    <span
                      className={cn("h-2 w-2 shrink-0 rounded-full", {
                        "bg-emerald-500": status === "supported",
                        "bg-amber-500": status === "partial",
                        "bg-zinc-400": status === "planned",
                      })}
                      title={statusMeta.label}
                    />
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {nodeSummary(node, {
                      conditionFields,
                      resolveTemplateName,
                    })}
                  </span>
                  {(() => {
                    const drop = nodeDropOff?.get(node.id);
                    return drop?.rate !== undefined ? (
                      <span className="truncate text-[11px] text-warning-emphasis">
                        {formatPercent(drop.rate)} drop-off
                      </span>
                    ) : null;
                  })()}
                  <span className="mt-auto flex flex-wrap items-center gap-1">
                    {isEntry ? (
                      <span className="inline-flex w-fit rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        Entry
                      </span>
                    ) : null}
                    {isOrphan ? (
                      <span
                        className="inline-flex w-fit rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive-emphasis"
                        title="Not connected to the stored journey definition"
                      >
                        Not connected
                      </span>
                    ) : null}
                    {pos.pinned ? (
                      <span
                        className="inline-flex w-fit rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        title="Manually positioned — Auto-arrange will reset it"
                      >
                        Pinned
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}

            {/* FLOW-033: connection handles (drag from here to another node). */}
            {canConnect
              ? nodes.map((node) => {
                  const pos = layout.nodes.get(node.id);
                  if (!pos || node.type === "exit") return null;
                  const bottomY = pos.y + NODE_H;
                  if (node.type === "branch") {
                    const trueX = pos.x + NODE_W * 0.32;
                    const falseX = pos.x + NODE_W * 0.68;
                    return (
                      <div key={`h-${node.id}`}>
                        <ConnectHandle
                          x={trueX}
                          y={bottomY}
                          label={`Drag to connect the true leg of ${node.id}`}
                          onStart={(e) =>
                            startConnect(e, node.id, trueX, bottomY, "true")
                          }
                          onMove={moveConnect}
                          onEnd={endConnect}
                        />
                        <ConnectHandle
                          x={falseX}
                          y={bottomY}
                          label={`Drag to connect the false leg of ${node.id}`}
                          onStart={(e) =>
                            startConnect(e, node.id, falseX, bottomY, "false")
                          }
                          onMove={moveConnect}
                          onEnd={endConnect}
                        />
                      </div>
                    );
                  }
                  const cx = pos.x + NODE_W / 2;
                  return (
                    <ConnectHandle
                      key={`h-${node.id}`}
                      x={cx}
                      y={bottomY}
                      label={`Drag to connect from ${node.id}`}
                      onStart={(e) => startConnect(e, node.id, cx, bottomY)}
                      onMove={moveConnect}
                      onEnd={endConnect}
                    />
                  );
                })
              : null}
          </div>
        </div>
      </div>

      {/* FLOW-034: zoom controls. */}
      <div className="absolute bottom-20 right-3 flex flex-col overflow-hidden rounded-md border bg-background shadow-sm">
        <button
          type="button"
          aria-label="Zoom in"
          className="flex h-10 w-10 items-center justify-center outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
          disabled={scale >= MAX_SCALE}
          onClick={() => zoomTo(scale + SCALE_STEP)}
        >
          <Plus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className="flex h-10 w-10 items-center justify-center border-t outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40"
          disabled={scale <= MIN_SCALE}
          onClick={() => zoomTo(scale - SCALE_STEP)}
        >
          <Minus className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Fit to view"
          title="Fit to view"
          className="flex h-10 w-10 items-center justify-center border-t outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={fitToView}
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {/* FLOW-034: minimap — overview + click-to-pan for large graphs. */}
      {minimapScale > 0 ? (
        <svg
          className="absolute bottom-3 left-3 cursor-pointer rounded-md border bg-background/90 shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          width={layout.width * minimapScale}
          height={layout.height * minimapScale}
          role="button"
          tabIndex={0}
          aria-label="Flow minimap. Use the arrow keys to pan and Home to fit the flow"
          onKeyDown={(event) => {
            const el = scrollRef.current;
            if (!el) return;
            const distance = event.shiftKey ? 240 : 80;
            let left = 0;
            let top = 0;
            switch (event.key) {
              case "ArrowLeft":
                left = -distance;
                break;
              case "ArrowRight":
                left = distance;
                break;
              case "ArrowUp":
                top = -distance;
                break;
              case "ArrowDown":
                top = distance;
                break;
              case "Home":
                event.preventDefault();
                fitToView();
                return;
              default:
                return;
            }
            event.preventDefault();
            el.scrollBy({ left, top });
          }}
          onClick={(e) => {
            const el = scrollRef.current;
            if (!el) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const canvasX = (e.clientX - rect.left) / minimapScale;
            const canvasY = (e.clientY - rect.top) / minimapScale;
            // Center the clicked point in the (scaled) scroll viewport.
            el.scrollTo({
              left: canvasX * scale - el.clientWidth / 2,
              top: canvasY * scale - el.clientHeight / 2,
            });
          }}
        >
          {[...layout.nodes.values()].map((n, i) => (
            <rect
              key={i}
              x={n.x * minimapScale}
              y={n.y * minimapScale}
              width={NODE_W * minimapScale}
              height={NODE_H * minimapScale}
              rx={1}
              className="fill-muted-foreground/50"
            />
          ))}
          <rect
            x={(viewport.left / scale) * minimapScale}
            y={(viewport.top / scale) * minimapScale}
            width={(viewport.width / scale) * minimapScale}
            height={(viewport.height / scale) * minimapScale}
            className="fill-primary/10 stroke-primary"
            strokeWidth={1}
          />
        </svg>
      ) : null}
    </div>
  );
}
