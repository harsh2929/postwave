import { describe, expect, it } from "vitest";

import {
  applySelection,
  type SelectionState,
} from "../../lib/library-selection";

const ids = ["a", "b", "c", "d", "e"];
const empty: SelectionState = { selected: new Set(), focusId: null };

describe("applySelection", () => {
  it("plain click replaces selection and sets focus", () => {
    const out = applySelection(empty, ids, { type: "click", id: "c" });
    expect([...out.selected]).toEqual(["c"]);
    expect(out.focusId).toBe("c");
  });

  it("cmd-click toggles id into selection without clobbering others", () => {
    const start: SelectionState = { selected: new Set(["a"]), focusId: "a" };
    const out = applySelection(start, ids, { type: "cmd-click", id: "c" });
    expect([...out.selected].sort()).toEqual(["a", "c"]);
    expect(out.focusId).toBe("c");
  });

  it("cmd-click on already-selected id removes it", () => {
    const start: SelectionState = {
      selected: new Set(["a", "c"]),
      focusId: "c",
    };
    const out = applySelection(start, ids, { type: "cmd-click", id: "a" });
    expect([...out.selected]).toEqual(["c"]);
    expect(out.focusId).toBe("a");
  });

  it("shift-click selects an inclusive range from focusId to id", () => {
    const start: SelectionState = { selected: new Set(["b"]), focusId: "b" };
    const out = applySelection(start, ids, { type: "shift-click", id: "d" });
    expect([...out.selected].sort()).toEqual(["b", "c", "d"]);
    expect(out.focusId).toBe("d");
  });

  it("shift-click works backwards too", () => {
    const start: SelectionState = { selected: new Set(["d"]), focusId: "d" };
    const out = applySelection(start, ids, { type: "shift-click", id: "b" });
    expect([...out.selected].sort()).toEqual(["b", "c", "d"]);
    expect(out.focusId).toBe("b");
  });

  it("shift-click with no focusId behaves like plain click", () => {
    const out = applySelection(empty, ids, { type: "shift-click", id: "c" });
    expect([...out.selected]).toEqual(["c"]);
    expect(out.focusId).toBe("c");
  });

  it("escape clears selection but preserves focus", () => {
    const start: SelectionState = {
      selected: new Set(["a", "b"]),
      focusId: "a",
    };
    const out = applySelection(start, ids, { type: "escape" });
    expect(out.selected.size).toBe(0);
    expect(out.focusId).toBe("a");
  });

  it("select-all selects every visible id", () => {
    const out = applySelection(empty, ids, { type: "select-all" });
    expect([...out.selected].sort()).toEqual([...ids].sort());
  });

  it("arrow right moves focus to next id; clamps at end", () => {
    const start: SelectionState = { selected: new Set(), focusId: "d" };
    expect(
      applySelection(start, ids, { type: "arrow", dir: "right" }).focusId,
    ).toBe("e");
    const last: SelectionState = { selected: new Set(), focusId: "e" };
    expect(
      applySelection(last, ids, { type: "arrow", dir: "right" }).focusId,
    ).toBe("e");
  });

  it("arrow left moves focus to previous id; clamps at start", () => {
    const start: SelectionState = { selected: new Set(), focusId: "b" };
    expect(
      applySelection(start, ids, { type: "arrow", dir: "left" }).focusId,
    ).toBe("a");
    const first: SelectionState = { selected: new Set(), focusId: "a" };
    expect(
      applySelection(first, ids, { type: "arrow", dir: "left" }).focusId,
    ).toBe("a");
  });

  it("arrow down advances by rowSize", () => {
    const start: SelectionState = { selected: new Set(), focusId: "a" };
    expect(
      applySelection(start, ids, {
        type: "arrow",
        dir: "down",
        rowSize: 2,
      }).focusId,
    ).toBe("c");
  });

  it("shift+arrow extends selection along focus motion", () => {
    const start: SelectionState = { selected: new Set(["b"]), focusId: "b" };
    const out = applySelection(start, ids, {
      type: "arrow",
      dir: "right",
      extend: true,
    });
    expect([...out.selected].sort()).toEqual(["b", "c"]);
    expect(out.focusId).toBe("c");
  });

  it("shift+vertical arrow includes every item crossed by the row jump", () => {
    const start: SelectionState = { selected: new Set(["a"]), focusId: "a" };
    const out = applySelection(start, ids, {
      type: "arrow",
      dir: "down",
      rowSize: 3,
      extend: true,
    });
    expect([...out.selected].sort()).toEqual(["a", "b", "c", "d"]);
    expect(out.focusId).toBe("d");
  });

  it("Home/End move focus and optionally extend a complete range", () => {
    const start: SelectionState = { selected: new Set(), focusId: "c" };
    expect(
      applySelection(start, ids, { type: "boundary", edge: "first" }).focusId,
    ).toBe("a");
    const extended = applySelection(start, ids, {
      type: "boundary",
      edge: "last",
      extend: true,
    });
    expect([...extended.selected].sort()).toEqual(["c", "d", "e"]);
    expect(extended.focusId).toBe("e");
  });

  it("focus movement does not mutate selection", () => {
    const selected = new Set(["a"]);
    const out = applySelection({ selected, focusId: "a" }, ids, {
      type: "focus",
      id: "d",
    });
    expect(out.selected).toBe(selected);
    expect(out.focusId).toBe("d");
  });

  it("arrow with empty ids is a no-op", () => {
    const out = applySelection(empty, [], { type: "arrow", dir: "right" });
    expect(out).toBe(empty);
  });

  it("arrow without focus starts at first id", () => {
    const out = applySelection(empty, ids, { type: "arrow", dir: "right" });
    expect(out.focusId).toBe("a");
  });
});
