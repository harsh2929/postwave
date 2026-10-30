// SPDX-License-Identifier: AGPL-3.0-only
//
// A tiny, pure, bounded undo/redo history for the flow-builder graph (FLOW-005).
// Immutable snapshots — every graph mutation pushes the prior graph onto the
// past stack, so an accidental Delete step / mis-drag / wrong connection is
// recoverable with ⌘Z (and ⌘⇧Z re-applies it). Kept generic and DOM-free so it
// unit-tests in node and can wrap any reducer state.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

/** Cap on retained snapshots. A journey graph is small, but an operator can
 *  hold ⌘Z; bound the memory rather than grow unboundedly. */
export const DEFAULT_HISTORY_LIMIT = 100;

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/**
 * Record a new present. A no-op (referentially identical next) is dropped so a
 * mutation that changed nothing does not create an undo step. Pushing a new
 * state clears the redo stack, matching every editor's undo semantics.
 */
export function pushHistory<T>(
  history: History<T>,
  next: T,
  limit: number = DEFAULT_HISTORY_LIMIT,
): History<T> {
  if (Object.is(next, history.present)) return history;
  const past = [...history.past, history.present];
  // Drop the oldest entries past the cap.
  while (past.length > limit) past.shift();
  return { past, present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const present = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [present, ...rest] = history.future;
  return {
    past: [...history.past, history.present],
    present,
    future: rest,
  };
}
