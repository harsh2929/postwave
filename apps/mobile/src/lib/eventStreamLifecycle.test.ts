import { describe, expect, it, vi } from "vitest";

import {
  createFocusGatedStream,
  type FocusGate,
} from "./eventStreamLifecycle";

function fakeFocus(initial: boolean): FocusGate & {
  set(focused: boolean): void;
  listenerCount(): number;
} {
  let focused = initial;
  const listeners = new Set<(next: boolean) => void>();
  return {
    isFocused: () => focused,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      focused = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

describe("createFocusGatedStream", () => {
  it("connects immediately when the app is already focused", () => {
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const focus = fakeFocus(true);
    createFocusGatedStream({ connect, focus });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("does not connect while the app starts backgrounded", () => {
    const connect = vi.fn(() => vi.fn());
    const focus = fakeFocus(false);
    createFocusGatedStream({ connect, focus });
    expect(connect).not.toHaveBeenCalled();
  });

  it("tears the socket down on background and re-opens on foreground", () => {
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const focus = fakeFocus(true);
    const onPause = vi.fn();
    const onResume = vi.fn();
    createFocusGatedStream({ connect, focus, onPause, onResume });

    focus.set(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();

    focus.set(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("is idempotent for repeated focus events in the same direction", () => {
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const focus = fakeFocus(true);
    createFocusGatedStream({ connect, focus });
    focus.set(true);
    focus.set(true);
    expect(connect).toHaveBeenCalledTimes(1);
    focus.set(false);
    focus.set(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("stop() disconnects, unsubscribes, and reports no pause", () => {
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);
    const focus = fakeFocus(true);
    const onPause = vi.fn();
    const stop = createFocusGatedStream({ connect, focus, onPause });
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(onPause).not.toHaveBeenCalled();
    expect(focus.listenerCount()).toBe(0);
    // Focus churn after teardown must never resurrect the stream.
    focus.set(false);
    focus.set(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("stop() is safe to call twice", () => {
    const disconnect = vi.fn();
    const stop = createFocusGatedStream({
      connect: () => disconnect,
      focus: fakeFocus(true),
    });
    stop();
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("still clears its handle when a disconnect throws", () => {
    const connect = vi.fn(() => () => {
      throw new Error("abort failed");
    });
    const focus = fakeFocus(true);
    createFocusGatedStream({ connect, focus });
    expect(() => focus.set(false)).toThrow("abort failed");
    focus.set(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
