import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DESKTOP_SHORTCUTS,
  bindingFingerprint,
  bindingFromKeyboardEvent,
  desktopShortcutById,
  eventMatchesShortcutStroke,
  findShortcutBindingConflicts,
  formatShortcutBinding,
  parseShortcutPreferences,
  resetAllShortcutOverrides,
  setShortcutOverride,
  shortcutAriaKeyShortcuts,
  shortcutBindingFor,
  shortcutForSection,
  type ShortcutBinding,
  type ShortcutKeyboardEvent,
} from "../../lib/desktop-shortcuts";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const storage = new MemoryStorage();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function keyboard(
  overrides: Partial<ShortcutKeyboardEvent> = {},
): ShortcutKeyboardEvent {
  return {
    key: "k",
    code: "KeyK",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("canonical desktop shortcut registry", () => {
  it("has unique ids, no duplicate complete binding, and one numeric shortcut per slot", () => {
    const ids = DESKTOP_SHORTCUTS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);

    const fingerprints = DESKTOP_SHORTCUTS.map((definition) =>
      bindingFingerprint(definition.binding),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);

    for (const digit of "1234567890") {
      expect(
        DESKTOP_SHORTCUTS.filter(
          (definition) =>
            definition.binding.strokes.length === 1 &&
            definition.binding.strokes[0].mod &&
            definition.binding.strokes[0].key === digit,
        ),
      ).toHaveLength(1);
    }
  });

  it("keeps route labels, spoken labels, and ARIA labels platform-aware", () => {
    const command = desktopShortcutById("app.command-palette");
    expect(command).not.toBeNull();
    expect(formatShortcutBinding(command!.binding, "macos")).toBe("⌘K");
    expect(formatShortcutBinding(command!.binding, "windows")).toBe("Ctrl+K");
    expect(formatShortcutBinding(command!.binding, "windows", "spoken")).toBe(
      "Control plus K",
    );
    expect(shortcutAriaKeyShortcuts(command!.binding, "macos")).toBe("Meta+K");
    expect(shortcutAriaKeyShortcuts(command!.binding, "windows")).toBe(
      "Control+K",
    );
  });

  it("derives every advertised section shortcut from the same registry", () => {
    expect(shortcutForSection("dashboard")?.id).toBe("nav.dashboard");
    expect(shortcutForSection("lists")?.id).toBe("nav.lists");
    expect(shortcutForSection("migrations")).toBeNull();
  });
});

describe("shortcut matching", () => {
  const command = desktopShortcutById("app.command-palette")!;

  it("uses the native primary modifier instead of accepting both everywhere", () => {
    expect(
      eventMatchesShortcutStroke(
        keyboard({ metaKey: true }),
        command.binding.strokes[0],
        "macos",
        "logical",
      ),
    ).toBe(true);
    expect(
      eventMatchesShortcutStroke(
        keyboard({ ctrlKey: true }),
        command.binding.strokes[0],
        "macos",
        "logical",
      ),
    ).toBe(false);
    expect(
      eventMatchesShortcutStroke(
        keyboard({ ctrlKey: true }),
        command.binding.strokes[0],
        "windows",
        "logical",
      ),
    ).toBe(true);
  });

  it("supports logical and physical layout modes without firing during IME/AltGraph/repeat", () => {
    const event = keyboard({
      key: "л",
      code: "KeyK",
      ctrlKey: true,
    });
    expect(
      eventMatchesShortcutStroke(
        event,
        command.binding.strokes[0],
        "windows",
        "logical",
      ),
    ).toBe(false);
    expect(
      eventMatchesShortcutStroke(
        event,
        command.binding.strokes[0],
        "windows",
        "physical",
      ),
    ).toBe(true);
    for (const blocked of [
      keyboard({ ctrlKey: true, isComposing: true }),
      keyboard({ ctrlKey: true, keyCode: 229 }),
      keyboard({ ctrlKey: true, repeat: true }),
      keyboard({
        ctrlKey: true,
        altKey: true,
        getModifierState: (name) => name === "AltGraph",
      }),
    ]) {
      expect(
        eventMatchesShortcutStroke(
          blocked,
          command.binding.strokes[0],
          "windows",
          "logical",
        ),
      ).toBe(false);
    }
  });
});

describe("device-local shortcut preferences", () => {
  const custom: ShortcutBinding = {
    strokes: [{ key: "j", code: "KeyJ", mod: true, shift: true }],
  };

  it("rejects corrupt, unknown, and native-menu overrides on read", () => {
    const parsed = parseShortcutPreferences(
      JSON.stringify({
        version: 1,
        layoutMode: "physical",
        overrides: {
          "nav.lists": custom,
          "native.quit": custom,
          unknown: custom,
          "nav.domains": { strokes: [] },
        },
      }),
    );
    expect(parsed.layoutMode).toBe("physical");
    expect(Object.keys(parsed.overrides)).toEqual(["nav.lists"]);
  });

  it("persists safe remaps, reports collisions, and restores defaults", () => {
    expect(setShortcutOverride("nav.lists", custom).ok).toBe(true);
    expect(
      formatShortcutBinding(
        shortcutBindingFor(desktopShortcutById("nav.lists")!),
      ),
    ).toMatch(/J$/);
    expect(findShortcutBindingConflicts("nav.domains", custom)).toEqual([
      { id: "nav.lists", label: "Lists" },
    ]);
    const collision = setShortcutOverride("nav.domains", custom);
    expect(collision).toMatchObject({ ok: false, reason: "conflict" });

    resetAllShortcutOverrides();
    expect(shortcutBindingFor(desktopShortcutById("nav.lists")!)).toEqual(
      desktopShortcutById("nav.lists")!.binding,
    );
  });

  it("refuses typing-hijacking bare keys and locked native commands", () => {
    expect(
      setShortcutOverride("nav.lists", {
        strokes: [{ key: "x", code: "KeyX" }],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(setShortcutOverride("native.quit", custom)).toMatchObject({
      ok: false,
      reason: "locked",
    });
    expect(
      setShortcutOverride("nav.lists", {
        strokes: [{ key: "c", code: "KeyC", mod: true }],
      }),
    ).toMatchObject({ ok: false, reason: "reserved" });
  });

  it("captures a normalized chord but ignores composition and modifier-only events", () => {
    expect(
      bindingFromKeyboardEvent(
        keyboard({ key: "J", code: "KeyJ", ctrlKey: true, shiftKey: true }),
      ),
    ).toEqual(custom);
    expect(bindingFromKeyboardEvent(keyboard({ key: "Shift" }))).toBeNull();
    expect(
      bindingFromKeyboardEvent(
        keyboard({ ctrlKey: true, metaKey: true, key: "j", code: "KeyJ" }),
      ),
    ).toBeNull();
  });
});
