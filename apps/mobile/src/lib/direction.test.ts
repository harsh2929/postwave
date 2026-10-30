import { afterEach, describe, expect, it } from "vitest";

import {
  forwardArrow,
  forwardChevron,
  isRTLLayout,
  pathLabel,
  setLayoutDirection,
  transitionLabel,
} from "./direction";

afterEach(() => {
  setLayoutDirection(false);
});

describe("direction", () => {
  it("defaults to LTR — an unconfigured app behaves as it always did", () => {
    expect(isRTLLayout()).toBe(false);
    expect(forwardArrow()).toBe("→");
    expect(forwardChevron()).toBe("›");
  });

  it("flips the connector, not the operands, under RTL", () => {
    setLayoutDirection(true);
    expect(transitionLabel("enabled", "blocklisted")).toBe(
      "enabled ← blocklisted",
    );
    expect(pathLabel(["Workspace", "API keys"])).toBe("Workspace ‹ API keys");
  });

  it("is symmetric — switching back restores LTR glyphs", () => {
    setLayoutDirection(true);
    setLayoutDirection(false);
    expect(transitionLabel("a", "b")).toBe("a → b");
    expect(pathLabel(["a", "b"])).toBe("a › b");
  });

  it("treats a non-true value as LTR (a wrong-way arrow is the worse bug)", () => {
    setLayoutDirection(undefined as unknown as boolean);
    expect(isRTLLayout()).toBe(false);
  });

  it("pathLabel leaves a single segment untouched", () => {
    expect(pathLabel(["Only"])).toBe("Only");
    expect(pathLabel([])).toBe("");
  });
});
