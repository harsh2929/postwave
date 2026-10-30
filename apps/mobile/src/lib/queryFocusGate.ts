/**
 * lib/queryFocusGate.ts — the app's single "is the user actually looking at
 * this?" signal, shaped as a `FocusGate` for lib/eventStreamLifecycle.
 *
 * NATIVE#10 established the rule that a realtime socket is held only while the
 * app is foregrounded: `isProbablyOnline()` stays true while backgrounded, so
 * Android keeps the socket and its reconnect timers alive burning radio, and
 * iOS suspends it into the half-open state the stall watchdog then has to
 * recover from — with a fresh stream-token mint on every one of those cycles.
 * `lib/eventCacheSync` has honoured it since; the two SSE surfaces added
 * later (the audit tail and the live-send tail) did not, which is what this
 * module exists to make cheap to do.
 *
 * IT ADDS NO LISTENER. `lib/connectivity` already bridges the ONE AppState
 * subscription this app installs into TanStack's `focusManager`; this reads
 * that. Anything that wants to know about focus should come through here
 * rather than adding a second AppState listener with its own idea of which
 * states count as foreground.
 *
 * The `undefined` case is already handled upstream and does not need
 * re-handling here: `focusManager.setFocused(undefined)` means "no override,
 * use the default resolver", and `onFocus()` resolves it through
 * `isFocused()` BEFORE notifying, so a listener is only ever handed a
 * boolean (`Listener = (focused: boolean) => void`, @tanstack/query-core
 * 5.100.9). A `focused !== false` normalisation here would be a branch no
 * input can take — which is exactly the kind of line a mutation run cannot
 * kill, so it is not written.
 */
import { focusManager } from "@tanstack/react-query";

import type { FocusGate } from "./eventStreamLifecycle";

export const queryFocusGate: FocusGate = {
  isFocused: () => focusManager.isFocused(),
  subscribe: (listener) => focusManager.subscribe(listener),
};
