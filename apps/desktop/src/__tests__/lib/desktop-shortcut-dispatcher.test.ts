// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDesktopShortcutDispatcher } from "../../lib/desktop-shortcut-dispatcher";
import type {
  DesktopShortcutIntent,
  ShortcutKeyboardEvent,
} from "../../lib/desktop-shortcuts";

function keyboard(
  key: string,
  overrides: Partial<ShortcutKeyboardEvent> = {},
): ShortcutKeyboardEvent {
  return {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe("desktop shortcut dispatcher", () => {
  it("dispatches the platform primary modifier and ignores the wrong one", () => {
    const intents: DesktopShortcutIntent[] = [];
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "macos",
      onIntent: (intent) => intents.push(intent),
    });
    expect(dispatcher.handle(keyboard("k", { ctrlKey: true }))).toBe(false);
    expect(dispatcher.handle(keyboard("k", { metaKey: true }))).toBe(true);
    expect(intents).toEqual([{ kind: "command-palette.toggle" }]);
  });

  it("allows the palette in text fields but blocks navigation there", () => {
    const input = document.createElement("input");
    const intents: DesktopShortcutIntent[] = [];
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "windows",
      onIntent: (intent) => intents.push(intent),
    });
    expect(
      dispatcher.handle(keyboard("1", { ctrlKey: true, target: input })),
    ).toBe(false);
    expect(
      dispatcher.handle(keyboard("k", { ctrlKey: true, target: input })),
    ).toBe(true);
    expect(intents).toEqual([{ kind: "command-palette.toggle" }]);
  });

  it("blocks shell navigation behind an overlay but leaves palette toggle available", () => {
    const intents: DesktopShortcutIntent[] = [];
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "windows",
      overlayActive: () => true,
      onIntent: (intent) => intents.push(intent),
    });
    expect(dispatcher.handle(keyboard("1", { ctrlKey: true }))).toBe(false);
    expect(dispatcher.handle(keyboard("k", { ctrlKey: true }))).toBe(true);
    expect(intents).toEqual([{ kind: "command-palette.toggle" }]);
  });

  it("arms G chords, announces options, dispatches the second key, and times out", () => {
    vi.useFakeTimers();
    const intents: DesktopShortcutIntent[] = [];
    const states: Array<unknown> = [];
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "windows",
      onIntent: (intent) => intents.push(intent),
      onChordChange: (state) => states.push(state),
    });
    expect(dispatcher.handle(keyboard("g"))).toBe(true);
    expect(states.at(-1)).toMatchObject({ prefix: "G", prompt: "Go to…" });
    expect(dispatcher.handle(keyboard("d"))).toBe(true);
    expect(intents).toEqual([{ kind: "section.open", section: "dashboard" }]);
    expect(states.at(-1)).toBeNull();

    dispatcher.handle(keyboard("g"));
    vi.advanceTimersByTime(1_501);
    expect(states.at(-1)).toBeNull();
  });

  it("re-evaluates a mismatching second stroke as a fresh shortcut", () => {
    const intents: DesktopShortcutIntent[] = [];
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "windows",
      onIntent: (intent) => intents.push(intent),
    });
    dispatcher.handle(keyboard("g"));
    expect(dispatcher.handle(keyboard("k", { ctrlKey: true }))).toBe(true);
    expect(intents).toEqual([{ kind: "command-palette.toggle" }]);
  });

  it("never dispatches repeats, IME key events, or AltGraph", () => {
    const onIntent = vi.fn();
    const dispatcher = createDesktopShortcutDispatcher({
      platform: "windows",
      onIntent,
    });
    expect(
      dispatcher.handle(keyboard("k", { ctrlKey: true, repeat: true })),
    ).toBe(false);
    expect(
      dispatcher.handle(keyboard("k", { ctrlKey: true, isComposing: true })),
    ).toBe(false);
    expect(
      dispatcher.handle(
        keyboard("k", {
          ctrlKey: true,
          altKey: true,
          getModifierState: (name) => name === "AltGraph",
        }),
      ),
    ).toBe(false);
    expect(onIntent).not.toHaveBeenCalled();
  });
});
