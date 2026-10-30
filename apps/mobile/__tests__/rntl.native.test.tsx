import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { PasswordResetForm } from "@/components/auth/PasswordResetForm";
import { PasswordResetSent } from "@/components/auth/PasswordResetSent";
import { ErrorState } from "@/components/ErrorState";

describe("native route test harness", () => {
  it("renders and queries the React Native accessibility tree", async () => {
    await render(<Text accessibilityRole="header">Moosewave</Text>);
    expect(screen.getByRole("header", { name: "Moosewave" })).toBeTruthy();
  });

  it("renders and operates the password-reset form states", async () => {
    const onPasswordChange = jest.fn();
    const onConfirmChange = jest.fn();
    const onSubmit = jest.fn();
    const onBack = jest.fn();
    const view = await render(
      <PasswordResetForm
        password="CorrectHorse1!"
        confirm="CorrectHorse1!"
        busy={false}
        error=""
        online
        onPasswordChange={onPasswordChange}
        onConfirmChange={onConfirmChange}
        onSubmit={onSubmit}
        onBack={onBack}
      />,
    );

    await fireEvent.changeText(
      screen.getByLabelText("New password"),
      "Changed1!",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Confirm new password"),
      "Changed1!",
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Reset password" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Back to sign in" }),
    );
    expect(onPasswordChange).toHaveBeenCalledWith("Changed1!");
    expect(onConfirmChange).toHaveBeenCalledWith("Changed1!");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    await view.rerender(
      <PasswordResetForm
        password="CorrectHorse1!"
        confirm="DifferentHorse1!"
        busy
        error="Reset was rejected"
        online
        onPasswordChange={onPasswordChange}
        onConfirmChange={onConfirmChange}
        onSubmit={onSubmit}
        onBack={onBack}
      />,
    );
    expect(screen.getByText("Passwords do not match")).toBeTruthy();
    expect(screen.getByRole("alert")).toHaveTextContent("Reset was rejected");

    await view.rerender(
      <PasswordResetForm
        password=""
        confirm=""
        busy={false}
        error=""
        online={false}
        onPasswordChange={onPasswordChange}
        onConfirmChange={onConfirmChange}
        onSubmit={onSubmit}
        onBack={onBack}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/offline/i);
  });

  it("renders resend status and invokes both recovery actions", async () => {
    const onResend = jest.fn();
    const onBack = jest.fn();
    const view = await render(
      <PasswordResetSent
        email="reader@example.com"
        error=""
        busy={false}
        onResend={onResend}
        onBack={onBack}
      />,
    );

    await fireEvent.press(
      screen.getByRole("button", { name: "Resend reset link" }),
    );
    await fireEvent.press(
      screen.getByRole("button", { name: "Back to sign in" }),
    );
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    await view.rerender(
      <PasswordResetSent
        email="reader@example.com"
        error="Please wait"
        busy
        onResend={onResend}
        onBack={onBack}
      />,
    );
    expect(screen.getByText("Please wait")).toBeTruthy();
  });

  it("renders an actionable error state without exposing raw errors", async () => {
    const onRetry = jest.fn();
    await render(
      <ErrorState
        message="Could not load this view"
        error={new Error("private upstream response")}
        onRetry={onRetry}
        compact
      />,
    );

    expect(screen.getByText("Could not load this view")).toBeTruthy();
    expect(screen.queryByText("private upstream response")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
