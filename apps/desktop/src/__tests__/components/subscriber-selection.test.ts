import { describe, expect, it } from "vitest";

import {
  applySubscriberSelection,
  EMPTY_SUBSCRIBER_SELECTION,
  type SelectionState,
} from "../../lib/subscriber-selection";

// Subscriber keys are id ?? email; the reducer ranges over the visible
// page order, so these stand in for subscriberKey(row) for a page.
const keys = ["sub-1", "sub-2", "sub-3", "sub-4", "sub-5"];

describe("applySubscriberSelection (SUB-079)", () => {
  it("plain click selects just that row and sets the anchor", () => {
    const out = applySubscriberSelection(EMPTY_SUBSCRIBER_SELECTION, keys, {
      type: "click",
      id: "sub-3",
    });
    expect([...out.selected]).toEqual(["sub-3"]);
    expect(out.focusId).toBe("sub-3");
  });

  it("cmd-click toggles a row in without clobbering the rest", () => {
    const start: SelectionState = {
      selected: new Set(["sub-1"]),
      focusId: "sub-1",
    };
    const out = applySubscriberSelection(start, keys, {
      type: "cmd-click",
      id: "sub-3",
    });
    expect([...out.selected].sort()).toEqual(["sub-1", "sub-3"]);
    expect(out.focusId).toBe("sub-3");
  });

  it("shift-click selects the inclusive range from anchor to row", () => {
    const start: SelectionState = {
      selected: new Set(["sub-2"]),
      focusId: "sub-2",
    };
    const out = applySubscriberSelection(start, keys, {
      type: "shift-click",
      id: "sub-4",
    });
    expect([...out.selected].sort()).toEqual(["sub-2", "sub-3", "sub-4"]);
    expect(out.focusId).toBe("sub-4");
  });

  it("shift-click ranges upward too (anchor below the clicked row)", () => {
    const start: SelectionState = {
      selected: new Set(["sub-5"]),
      focusId: "sub-5",
    };
    const out = applySubscriberSelection(start, keys, {
      type: "shift-click",
      id: "sub-2",
    });
    expect([...out.selected].sort()).toEqual([
      "sub-2",
      "sub-3",
      "sub-4",
      "sub-5",
    ]);
    expect(out.focusId).toBe("sub-2");
  });

  it("shift-click with no anchor falls back to a single selection", () => {
    const out = applySubscriberSelection(EMPTY_SUBSCRIBER_SELECTION, keys, {
      type: "shift-click",
      id: "sub-3",
    });
    expect([...out.selected]).toEqual(["sub-3"]);
    expect(out.focusId).toBe("sub-3");
  });
});
