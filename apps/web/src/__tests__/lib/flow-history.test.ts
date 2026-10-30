// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  canRedo,
  canUndo,
  initHistory,
  pushHistory,
  redo,
  undo,
} from "@/lib/flow-history";

describe("flow-history", () => {
  it("pushes states and undoes/redoes them", () => {
    let h = initHistory("a");
    h = pushHistory(h, "b");
    h = pushHistory(h, "c");
    expect(h.present).toBe("c");
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);

    h = undo(h);
    expect(h.present).toBe("b");
    h = undo(h);
    expect(h.present).toBe("a");
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present).toBe("b");
    expect(canRedo(h)).toBe(true);
  });

  it("clears the redo stack when a new state is pushed after undo", () => {
    let h = initHistory(1);
    h = pushHistory(h, 2);
    h = pushHistory(h, 3);
    h = undo(h); // present = 2, future = [3]
    h = pushHistory(h, 4); // branching: future cleared
    expect(h.present).toBe(4);
    expect(canRedo(h)).toBe(false);
  });

  it("ignores a no-op push (identical present)", () => {
    let h = initHistory("a");
    const same = h;
    h = pushHistory(h, "a");
    expect(h).toBe(same);
    expect(canUndo(h)).toBe(false);
  });

  it("bounds the past stack to the limit", () => {
    let h = initHistory(0);
    for (let i = 1; i <= 10; i++) h = pushHistory(h, i, 3);
    // present=10, past holds at most 3 prior states
    expect(h.past.length).toBe(3);
    expect(h.present).toBe(10);
    expect(h.past).toEqual([7, 8, 9]);
  });

  it("is a no-op to undo/redo at the ends", () => {
    const h = initHistory("only");
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
