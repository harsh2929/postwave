import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

import { ScreenHeader } from "@/components/ScreenHeader";
import { haptics } from "@/lib/haptics";

jest.mock("@/lib/haptics", () => ({
  haptics: { tap: jest.fn() },
}));

function flattenedStyle(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >;
}

function geometry(style: Record<string, unknown>) {
  return {
    width: style.width,
    height: style.height,
    minWidth: style.minWidth,
    minHeight: style.minHeight,
    paddingEnd: style.paddingEnd,
    alignItems: style.alignItems,
    justifyContent: style.justifyContent,
  };
}

describe("ScreenHeader control feedback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("paints and clears Back feedback without changing its touch geometry", async () => {
    const onBack = jest.fn();
    await render(
      <ScreenHeader title="Campaign" onBack={onBack} hideStatus />,
    );

    let back = screen.getByRole("button", { name: "Go back" });
    const initial = flattenedStyle(back);
    expect(initial.backgroundColor).toBe("transparent");
    // The chevron is 20pt tall; its unchanged 12pt hit slop on both sides
    // preserves the existing 44pt effective vertical target.
    expect(back.props.hitSlop).toBe(12);
    expect(initial.paddingEnd).toBe(4);
    expect(initial.overflow).toBe("hidden");

    await fireEvent(back, "pressIn");
    back = screen.getByRole("button", { name: "Go back" });
    const pressed = flattenedStyle(back);
    expect(pressed.backgroundColor).not.toBe("transparent");
    expect(geometry(pressed)).toEqual(geometry(initial));
    expect(onBack).not.toHaveBeenCalled();

    await fireEvent(back, "pressOut");
    back = screen.getByRole("button", { name: "Go back" });
    expect(flattenedStyle(back).backgroundColor).toBe("transparent");

    await fireEvent.press(back);
    expect(haptics.tap).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("paints and clears Search feedback inside its unchanged 44pt box", async () => {
    const onSearch = jest.fn();
    await render(
      <ScreenHeader title="Campaigns" onSearch={onSearch} hideStatus />,
    );

    let search = screen.getByRole("button", { name: "Search" });
    const initial = flattenedStyle(search);
    expect(initial.width).toBe(44);
    expect(initial.height).toBe(44);
    expect(initial.backgroundColor).toBe("transparent");
    expect(initial.overflow).toBe("hidden");

    await fireEvent(search, "pressIn");
    search = screen.getByRole("button", { name: "Search" });
    const pressed = flattenedStyle(search);
    expect(pressed.backgroundColor).not.toBe("transparent");
    expect(geometry(pressed)).toEqual(geometry(initial));
    expect(onSearch).not.toHaveBeenCalled();

    await fireEvent(search, "pressOut");
    search = screen.getByRole("button", { name: "Search" });
    expect(flattenedStyle(search).backgroundColor).toBe("transparent");

    await fireEvent.press(search);
    expect(onSearch).toHaveBeenCalledTimes(1);
    // Search did not previously emit a haptic; the feedback pass must not
    // silently change its interaction contract.
    expect(haptics.tap).not.toHaveBeenCalled();
  });

  it("keeps absent controls absent instead of manufacturing disabled chrome", async () => {
    await render(<ScreenHeader title="Dashboard" hideStatus />);

    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  });
});
