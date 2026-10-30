import { describe, expect, it, vi } from "vitest";

import { pageSheetKeyboardOffset } from "./usePageSheetKeyboardOffset";

// Only the pure geometry is under test; the hook's react-native imports just
// have to resolve.
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

describe("pageSheetKeyboardOffset (A11Y-2)", () => {
  it("is the card's drop below the window top on an iPhone pageSheet", () => {
    // 844pt window, a 790pt card anchored to its bottom: the card starts at 54.
    expect(pageSheetKeyboardOffset("ios", 844, 790)).toBe(54);
  });

  it("adds nothing when the sheet fills the window", () => {
    // Full-screen presentation (iPhone landscape): nothing to count twice.
    expect(pageSheetKeyboardOffset("ios", 844, 844)).toBe(0);
  });

  it("adds nothing before the sheet has laid out", () => {
    // A zero height is "not measured yet", not "a card 844pt down".
    expect(pageSheetKeyboardOffset("ios", 844, 0)).toBe(0);
  });

  it("never goes negative for a sheet reported taller than the window", () => {
    expect(pageSheetKeyboardOffset("ios", 844, 900)).toBe(0);
  });

  it("adds nothing on Android, where a Modal is its own full window", () => {
    expect(pageSheetKeyboardOffset("android", 844, 790)).toBe(0);
  });
});
