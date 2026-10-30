import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ROW_DENSITY } from "./displayPreferences";
import {
  appliedRowDensity,
  resetRowDensityStore,
  setAppliedRowDensity,
  subscribeRowDensity,
} from "./rowDensityStore";

afterEach(() => {
  resetRowDensityStore();
});

describe("rowDensityStore", () => {
  it("starts at the default so a row can render before any read lands", () => {
    expect(appliedRowDensity()).toBe(DEFAULT_ROW_DENSITY);
  });

  it("notifies subscribers on a real change", () => {
    const seen = vi.fn();
    subscribeRowDensity(seen);
    setAppliedRowDensity("compact");
    expect(appliedRowDensity()).toBe("compact");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does NOT notify when the value is unchanged", () => {
    // The publisher calls this from an effect that runs on every render of the
    // shell; a naive store would re-render every row in every list each time.
    const seen = vi.fn();
    subscribeRowDensity(seen);
    setAppliedRowDensity(DEFAULT_ROW_DENSITY);
    expect(seen).not.toHaveBeenCalled();
  });

  it("stops notifying after unsubscribe", () => {
    const seen = vi.fn();
    const stop = subscribeRowDensity(seen);
    stop();
    setAppliedRowDensity("compact");
    expect(seen).not.toHaveBeenCalled();
  });

  it("survives a subscriber that unsubscribes DURING the notify", () => {
    // Rows unmount as the list virtualises; a Set mutated mid-iteration would
    // otherwise skip the next listener.
    const order: string[] = [];
    let stopSecond = (): void => {};
    subscribeRowDensity(() => {
      order.push("first");
      stopSecond();
    });
    stopSecond = subscribeRowDensity(() => {
      order.push("second");
    });
    setAppliedRowDensity("compact");
    expect(order).toEqual(["first", "second"]);
  });
});
