/**
 * A stat tile's label must never split a word in half.
 *
 * MiniStat is one cell of a three-across row (`flexBasis: "31%"`), and its
 * labels are UPPERCASE with letterSpacing. A single long word has no space to
 * wrap at, so React Native breaks it MID-WORD: "SUBSCRIBERS" rendered as
 * "SUBSCRIBER" over "S" on the audience growth card, seen in-app on
 * 2026-08-19.
 *
 * The fix is one line that shrinks rather than breaks, so this pins the three
 * props that produce that behaviour together. Any one of them missing brings
 * the split back: without numberOfLines it wraps, without adjustsFontSizeToFit
 * it truncates with an ellipsis instead, and without minimumFontScale it may
 * shrink without bound and stop honouring a large-text setting.
 */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";

import { MiniStat } from "@/components/subscriber/SubscriberDetailPrimitives";
import type { ThemeTokens } from "@/lib/theme";

// Only the five tokens MiniStat reads. Supplied directly rather than imported,
// because the jest setup mocks @/lib/theme and this test is about layout props,
// not about colour values.
const T = {
  surface: "#fff",
  borderSubtle: "#eee",
  fg: "#000",
  fgMuted: "#666",
  fgSubtle: "#999",
} as unknown as ThemeTokens;

describe("MiniStat label", () => {
  it("renders the longest real label on ONE line, shrinking to fit", async () => {
    await render(<MiniStat label="Subscribers" value="8" t={T} />);
    const label = screen.getByText("Subscribers");
    expect(label.props.numberOfLines).toBe(1);
    expect(label.props.adjustsFontSizeToFit).toBe(true);
    expect(label.props.minimumFontScale).toBeGreaterThan(0);
    // Bounded: a large-text user must still get a bigger label, not an
    // arbitrarily shrunken one.
    expect(label.props.minimumFontScale).toBeGreaterThanOrEqual(0.8);
  });

  it("still renders the value and its subtitle", async () => {
    await render(<MiniStat label="Unsubbed (min)" value="12" sub="at least 12" t={T} />);
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("at least 12")).toBeTruthy();
  });
});
