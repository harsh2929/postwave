/**
 * Pure reducer for Library multi-select. No React, no DOM — testable in
 * isolation. Apple-faithful semantics:
 *
 *   click            → replace selection with id; set focus
 *   cmd/ctrl-click   → toggle id in selection; set focus
 *   shift-click      → range select between focus and id; set focus to id
 *   escape           → clear selection (keep focus)
 *   select-all       → all visible ids become the selection
 *   arrow {dir,ext}  → move focus; if `extend`, add every crossed item
 *   boundary         → move to first/last; optionally add the crossed range
 *   focus            → move the focus marker without changing selection
 *
 * `ids` is the currently-visible ordered list (post-filter, post-sort).
 * Range / arrow operations use this order, NOT the underlying asset id order.
 */

export interface SelectionState {
  selected: Set<string>;
  focusId: string | null;
}

export type SelectionEvent =
  | { type: "focus"; id: string }
  | { type: "click"; id: string }
  | { type: "cmd-click"; id: string }
  | { type: "shift-click"; id: string }
  | { type: "escape" }
  | { type: "select-all" }
  | {
      type: "arrow";
      dir: "left" | "right" | "up" | "down";
      extend?: boolean;
      rowSize?: number;
    }
  | { type: "boundary"; edge: "first" | "last"; extend?: boolean };

const ROW_SIZE_DEFAULT = 4;

export function applySelection(
  state: SelectionState,
  ids: readonly string[],
  ev: SelectionEvent,
): SelectionState {
  switch (ev.type) {
    case "focus":
      return { selected: state.selected, focusId: ev.id };

    case "click":
      return { selected: new Set([ev.id]), focusId: ev.id };

    case "cmd-click": {
      const next = new Set(state.selected);
      if (next.has(ev.id)) next.delete(ev.id);
      else next.add(ev.id);
      return { selected: next, focusId: ev.id };
    }

    case "shift-click": {
      const anchor = state.focusId;
      if (!anchor) return { selected: new Set([ev.id]), focusId: ev.id };
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(ev.id);
      if (a < 0 || b < 0) return { selected: new Set([ev.id]), focusId: ev.id };
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const next = new Set(state.selected);
      for (let i = lo; i <= hi; i++) next.add(ids[i]);
      return { selected: next, focusId: ev.id };
    }

    case "escape":
      return { selected: new Set(), focusId: state.focusId };

    case "select-all":
      return { selected: new Set(ids), focusId: state.focusId };

    case "arrow": {
      if (ids.length === 0) return state;
      const cur = state.focusId ? ids.indexOf(state.focusId) : -1;
      const rowSize = ev.rowSize ?? ROW_SIZE_DEFAULT;
      const step =
        ev.dir === "right"
          ? 1
          : ev.dir === "left"
            ? -1
            : ev.dir === "down"
              ? rowSize
              : -rowSize;
      const target =
        cur < 0 ? 0 : Math.max(0, Math.min(ids.length - 1, cur + step));
      const nextFocusId = ids[target];
      if (!ev.extend)
        return { selected: state.selected, focusId: nextFocusId };
      const next = addRange(state.selected, ids, cur < 0 ? target : cur, target);
      return { selected: next, focusId: nextFocusId };
    }

    case "boundary": {
      if (ids.length === 0) return state;
      const target = ev.edge === "first" ? 0 : ids.length - 1;
      const current = state.focusId ? ids.indexOf(state.focusId) : -1;
      const focusId = ids[target];
      return {
        selected: ev.extend
          ? addRange(
              state.selected,
              ids,
              current < 0 ? target : current,
              target,
            )
          : state.selected,
        focusId,
      };
    }

    default:
      return state;
  }
}

function addRange(
  selected: ReadonlySet<string>,
  ids: readonly string[],
  from: number,
  to: number,
): Set<string> {
  const next = new Set(selected);
  const [lo, hi] = from < to ? [from, to] : [to, from];
  for (let index = lo; index <= hi; index += 1) next.add(ids[index]);
  return next;
}

/** Convenience: visible-id list given the current asset list. */
export function visibleIds<T extends { id: string }>(rows: readonly T[]): string[] {
  return rows.map((r) => r.id);
}
