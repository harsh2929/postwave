import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const announceForAccessibility = vi.fn((_message: string) => {});
const setAccessibilityFocus = vi.fn((_handle: number) => {});
const findNodeHandle = vi.fn((_node: unknown): number | null => 7);
const platform = { OS: "ios" as string };

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: (message: string) =>
      announceForAccessibility(message),
    setAccessibilityFocus: (handle: number) => setAccessibilityFocus(handle),
  },
  findNodeHandle: (node: unknown) => findNodeHandle(node),
  get Platform() {
    return platform;
  },
}));

// eslint-disable-next-line import/first
import { announce, announceScreenChange, focusOn, liveRegionProps } from "./a11y";

describe("announce", () => {
  beforeEach(() => {
    platform.OS = "ios";
    announceForAccessibility.mockClear();
    setAccessibilityFocus.mockClear();
    findNodeHandle.mockClear();
    findNodeHandle.mockReturnValue(7);
  });

  afterEach(() => {
    announceForAccessibility.mockReset();
  });

  it("speaks an auth error on iOS, where alert-role does not announce", () => {
    announce("Email or password is incorrect.");
    expect(announceForAccessibility).toHaveBeenCalledWith(
      "Email or password is incorrect.",
    );
  });

  it("stays silent on Android, where the live region already announces", () => {
    platform.OS = "android";
    announce("Email or password is incorrect.");
    expect(announceForAccessibility).not.toHaveBeenCalled();
  });

  it("ignores empty and whitespace-only messages", () => {
    announce("");
    announce("   ");
    expect(announceForAccessibility).not.toHaveBeenCalled();
  });

  it("truncates so a pathological message cannot be read aloud forever", () => {
    announce("x".repeat(5000));
    expect(announceForAccessibility.mock.calls[0]?.[0]).toHaveLength(300);
  });

  it("never throws when the native module is unavailable", () => {
    announceForAccessibility.mockImplementation(() => {
      throw new Error("no native module");
    });
    expect(() => announce("hello")).not.toThrow();
  });
});

describe("liveRegionProps", () => {
  it("declares an assertive alert for Android's live-region support", () => {
    expect(liveRegionProps()).toEqual({
      accessibilityRole: "alert",
      accessibilityLiveRegion: "assertive",
    });
  });
});

describe("focusOn", () => {
  beforeEach(() => {
    setAccessibilityFocus.mockClear();
    findNodeHandle.mockClear();
    findNodeHandle.mockReturnValue(7);
  });

  it("moves screen-reader focus onto a mounted node", () => {
    focusOn({ current: {} });
    expect(setAccessibilityFocus).toHaveBeenCalledWith(7);
  });

  it("no-ops for an unmounted or absent ref", () => {
    focusOn({ current: null });
    focusOn(null);
    focusOn(undefined);
    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });

  it("no-ops when the node has no native handle yet", () => {
    findNodeHandle.mockReturnValue(null);
    focusOn({ current: {} });
    expect(setAccessibilityFocus).not.toHaveBeenCalled();
  });
});

describe("announceScreenChange", () => {
  beforeEach(() => {
    platform.OS = "ios";
    announceForAccessibility.mockClear();
    announceForAccessibility.mockImplementation(() => {});
    setAccessibilityFocus.mockClear();
    findNodeHandle.mockReturnValue(7);
  });

  it("both speaks the new state and moves focus to its heading", () => {
    announceScreenChange("Check your email", { current: {} });
    expect(announceForAccessibility).toHaveBeenCalledWith("Check your email");
    expect(setAccessibilityFocus).toHaveBeenCalledWith(7);
  });
});
