/**
 * subscriber-selection — pure multi-select reducer for the Subscribers
 * list (SUB-079 shift-click range select). This is a thin, subscriber-
 * specific adapter over the proven `applySelection` reducer in
 * library-selection.ts, which already implements Apple-faithful
 * click / cmd-click / shift-click / arrow semantics with tests.
 *
 * The Subscribers list keys rows by `subscriberKey(row)` (id ?? email),
 * so the "ids" the reducer ranges over are the ordered list of those
 * keys for the CURRENT page (post-filter, post-sort). Range / arrow
 * operations use that visible order, NOT the underlying id order.
 *
 * No React, no DOM — testable in isolation.
 */

import {
  applySelection,
  type SelectionEvent,
  type SelectionState,
} from "./library-selection";

export type { SelectionEvent, SelectionState };

/** Empty selection state — no rows selected, no focus anchor. */
export const EMPTY_SUBSCRIBER_SELECTION: SelectionState = {
  selected: new Set<string>(),
  focusId: null,
};

/**
 * Apply a selection event against the subscriber-key list.
 *
 *   click            → replace selection with key; set focus
 *   cmd/ctrl-click   → toggle key in selection; set focus
 *   shift-click      → range-select between focus and key; set focus to key
 *
 * `keys` is the ordered list of subscriberKey(row) for the visible page.
 */
export function applySubscriberSelection(
  state: SelectionState,
  keys: readonly string[],
  ev: SelectionEvent,
): SelectionState {
  return applySelection(state, keys, ev);
}
