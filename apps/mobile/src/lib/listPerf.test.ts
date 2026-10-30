import { describe, expect, it } from "vitest";

import {
  MOBILE_LIST_PERF_PROPS,
  MOBILE_SECTION_LIST_PERF_PROPS,
} from "./listPerf";

describe("MOBILE_LIST_PERF_PROPS", () => {
  it("persists taps while the keyboard is up so the first row tap is not swallowed", () => {
    // RN's default is "never", which costs a phantom tap on every list that
    // sits under a search field. Regression guard for COMMERCE-V#5.
    expect(MOBILE_LIST_PERF_PROPS.keyboardShouldPersistTaps).toBe("handled");
  });

  it("never uses 'always', which would strand the keyboard open on a background tap", () => {
    expect(MOBILE_LIST_PERF_PROPS.keyboardShouldPersistTaps).not.toBe("always");
  });

  it("keeps the virtualization tuning that made it worth sharing", () => {
    expect(MOBILE_LIST_PERF_PROPS.initialNumToRender).toBeGreaterThan(0);
    expect(MOBILE_LIST_PERF_PROPS.maxToRenderPerBatch).toBeGreaterThan(0);
    expect(MOBILE_LIST_PERF_PROPS.removeClippedSubviews).toBe(true);
  });

  it("gives SectionList the same contract", () => {
    expect(MOBILE_SECTION_LIST_PERF_PROPS).toEqual(MOBILE_LIST_PERF_PROPS);
  });
});
