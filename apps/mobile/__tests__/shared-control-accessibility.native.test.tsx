import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";

import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SegmentedControl } from "@/components/SegmentedControl";
import { MIN_TOUCH_TARGET } from "@/lib/displayPreferences";

/**
 * These assertions are about TARGET SIZE and PRESS FEEDBACK, not about which
 * word the role is — the role itself is platform-specific now and is pinned in
 * `segmented-control-role.native.test.tsx`. Deriving it here keeps this file
 * from failing for a reason it does not test. jest-expo runs with the iOS
 * platform, where `tab` maps to `UIAccessibilityTraitNone`.
 */
const SEGMENT_ROLE = Platform.OS === "ios" ? "button" : "tab";

function flattenedStyle(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >;
}

describe("shared control accessibility", () => {
  it("gives every segmented option a full target and a selected state", async () => {
    const onChange = jest.fn();
    await render(
      <SegmentedControl
        accessibilityLabel="Sign-in method"
        options={[
          { value: "password", label: "Password" },
          { value: "link", label: "Email link" },
        ]}
        value="password"
        onChange={onChange}
      />,
    );

    const password = screen.getByRole(SEGMENT_ROLE, { name: "Password" });
    const emailLink = screen.getByRole(SEGMENT_ROLE, { name: "Email link" });
    expect(flattenedStyle(password).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET,
    );
    expect(flattenedStyle(emailLink).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET,
    );
    expect(password.props.accessibilityState).toEqual({ selected: true });
    expect(emailLink.props.accessibilityState).toEqual({ selected: false });

    await fireEvent.press(emailLink);
    expect(onChange).toHaveBeenCalledWith("link");
  });

  it("shows press feedback without changing static control geometry", async () => {
    await render(
      <SegmentedControl
        options={[
          { value: "password", label: "Password" },
          { value: "link", label: "Email link" },
        ]}
        value="password"
        onChange={() => undefined}
      />,
    );

    const emailLink = screen.getByRole(SEGMENT_ROLE, { name: "Email link" });
    const initial = flattenedStyle(emailLink);
    expect(initial.backgroundColor).toBe("transparent");

    await fireEvent(emailLink, "pressIn");
    const pressed = flattenedStyle(
      screen.getByRole(SEGMENT_ROLE, { name: "Email link" }),
    );
    expect(pressed.backgroundColor).not.toBe("transparent");
    expect(pressed.minHeight).toBe(initial.minHeight);

    await fireEvent(
      screen.getByRole(SEGMENT_ROLE, { name: "Email link" }),
      "pressOut",
    );
    expect(
      flattenedStyle(screen.getByRole(SEGMENT_ROLE, { name: "Email link" }))
        .backgroundColor,
    ).toBe("transparent");
  });

  it("keeps bare empty-state actions at the touch floor", async () => {
    const onPress = jest.fn();
    await render(
      <EmptyState
        title="No campaigns"
        cta={{ label: "Create campaign", onPress }}
      />,
    );

    const action = screen.getByRole("button", { name: "Create campaign" });
    expect(flattenedStyle(action).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET,
    );
    await fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("announces error copy separately from its reachable retry action", async () => {
    const onRetry = jest.fn();
    await render(
      <ErrorState message="The report could not load" onRetry={onRetry} />,
    );

    expect(
      screen.getByRole("alert", { name: "The report could not load" }),
    ).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(flattenedStyle(retry).minHeight).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET,
    );
    await fireEvent.press(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
