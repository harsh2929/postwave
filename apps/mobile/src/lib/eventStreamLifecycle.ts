/**
 * lib/eventStreamLifecycle.ts — keep the realtime stream open only while the
 * app is actually in front of the user (NATIVE#10).
 *
 * The event-bus connection used to live for the whole authenticated session:
 * `connectEventBus` consults `isProbablyOnline()`, which stays true while the
 * app is backgrounded, so Android kept the socket and its reconnect timers
 * alive burning radio, and iOS suspended it into the half-open state the stall
 * watchdog now has to recover from. TanStack already knows the app is
 * unfocused (lib/connectivity.ts bridges AppState into `focusManager`); the
 * stream simply never asked.
 *
 * The gate is expressed against an injected `FocusGate` rather than importing
 * AppState directly, so the lifecycle is testable in the node environment and
 * so it reuses the ONE AppState listener the app already installs instead of
 * adding a second.
 */
export type StreamDisconnect = () => void;

export interface FocusGate {
  isFocused(): boolean;
  subscribe(listener: (focused: boolean) => void): () => void;
}

export interface FocusGatedStreamOptions {
  /** Opens the stream; the returned function must tear it down. */
  connect: () => StreamDisconnect;
  focus: FocusGate;
  /** Called when a live stream is torn down because the app backgrounded. */
  onPause?: () => void;
  /** Called immediately before a re-open triggered by returning to the app. */
  onResume?: () => void;
}

/**
 * Connect while focused, disconnect while backgrounded, reconnect on return.
 * The returned function stops everything permanently (logout / unmount).
 */
export function createFocusGatedStream(
  options: FocusGatedStreamOptions,
): StreamDisconnect {
  let disconnect: StreamDisconnect | null = null;
  let stopped = false;

  const open = (resumed: boolean): void => {
    if (stopped || disconnect) return;
    if (resumed) options.onResume?.();
    disconnect = options.connect();
  };

  const close = (paused: boolean): void => {
    if (!disconnect) return;
    const active = disconnect;
    disconnect = null;
    try {
      active();
    } finally {
      if (paused) options.onPause?.();
    }
  };

  const unsubscribe = options.focus.subscribe((focused) => {
    if (stopped) return;
    if (focused) open(true);
    else close(true);
  });

  if (options.focus.isFocused()) open(false);

  return () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    close(false);
  };
}
