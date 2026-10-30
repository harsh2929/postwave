import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Platform, StyleSheet } from "react-native";

import { AuthSubmitButton } from "@/components/auth/AuthSubmitButton";
import { OAuthSignInButton } from "@/components/auth/OAuthSignInButton";

function styleOf(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<
    string,
    unknown
  >;
}

function geometry(style: Record<string, unknown>) {
  return {
    alignItems: style.alignItems,
    borderRadius: style.borderRadius,
    justifyContent: style.justifyContent,
    minHeight: style.minHeight,
    paddingHorizontal: style.paddingHorizontal,
    paddingVertical: style.paddingVertical,
  };
}

describe("auth action interaction feedback", () => {
  it("paints AuthSubmitButton on press-in/out without changing layout", async () => {
    const onPress = jest.fn();
    await render(<AuthSubmitButton label="Sign in" onPress={onPress} />);

    let button = screen.getByRole("button", { name: "Sign in" });
    const resting = styleOf(button);
    expect(typeof button.props.style).toBe("object");

    await fireEvent(button, "pressIn");
    button = screen.getByRole("button", { name: "Sign in" });
    const pressed = styleOf(button);
    expect(Number(pressed.opacity)).toBeLessThan(Number(resting.opacity));
    expect(geometry(pressed)).toEqual(geometry(resting));

    await fireEvent(button, "pressOut");
    expect(styleOf(screen.getByRole("button", { name: "Sign in" })).opacity).toBe(
      resting.opacity,
    );
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled and loading submit buttons inert and announced", async () => {
    const onPress = jest.fn();
    const view = await render(
      <AuthSubmitButton label="Continue" onPress={onPress} disabled />,
    );

    let button = screen.getByRole("button", { name: "Continue" });
    const disabledOpacity = styleOf(button).opacity;
    expect(button.props.accessibilityState).toMatchObject({
      busy: false,
      disabled: true,
    });
    await fireEvent(button, "pressIn");
    expect(styleOf(screen.getByRole("button", { name: "Continue" })).opacity).toBe(
      disabledOpacity,
    );
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();

    await view.rerender(
      <AuthSubmitButton label="Continue" onPress={onPress} busy />,
    );
    button = screen.getByRole("button", { name: "Continue" });
    expect(button.props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    expect(screen.queryByText("Continue")).toBeNull();
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("gives the canonical OAuth control iOS paint feedback and Android ripple", async () => {
    const onPress = jest.fn();
    await render(<OAuthSignInButton onPress={onPress} />);

    let button = screen.getByRole("button", { name: "Continue with Google" });
    const resting = styleOf(button);
    expect(typeof button.props.style).toBe("object");

    await fireEvent(button, "pressIn");
    button = screen.getByRole("button", { name: "Continue with Google" });
    const pressed = styleOf(button);
    expect(Number(pressed.opacity)).toBeLessThan(Number(resting.opacity));
    expect(geometry(pressed)).toEqual(geometry(resting));

    await fireEvent(button, "pressOut");
    expect(
      styleOf(screen.getByRole("button", { name: "Continue with Google" }))
        .opacity,
    ).toBe(resting.opacity);
    await fireEvent.press(
      screen.getByRole("button", { name: "Continue with Google" }),
    );
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled and loading OAuth controls inert and announced", async () => {
    const onPress = jest.fn();
    const view = await render(<OAuthSignInButton onPress={onPress} disabled />);

    let button = screen.getByRole("button", { name: "Continue with Google" });
    expect(button.props.accessibilityState).toMatchObject({
      busy: false,
      disabled: true,
    });
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();

    await view.rerender(<OAuthSignInButton onPress={onPress} busy />);
    button = screen.getByRole("button", { name: "Continue with Google" });
    expect(button.props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    expect(screen.queryByText("Continue with Google")).toBeNull();
    await fireEvent(button, "pressIn");
    expect(styleOf(button).opacity).toBe(0.6);
    await fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("configures bounded native Android ripples on both controls", async () => {
    const originalOS = Platform.OS;
    Object.defineProperty(Platform, "OS", {
      configurable: true,
      value: "android",
    });
    try {
      const submit = await render(
        <AuthSubmitButton label="Sign in" onPress={() => undefined} />,
      );
      expect(
        screen.getByRole("button", { name: "Sign in" }).props
          .nativeBackgroundAndroid,
      ).toMatchObject({ borderless: false, type: "RippleAndroid" });
      await submit.unmount();

      await render(<OAuthSignInButton onPress={() => undefined} />);
      expect(
        screen.getByRole("button", { name: "Continue with Google" }).props
          .nativeBackgroundAndroid,
      ).toMatchObject({ borderless: false, type: "RippleAndroid" });
    } finally {
      Object.defineProperty(Platform, "OS", {
        configurable: true,
        value: originalOS,
      });
    }
  });
});
