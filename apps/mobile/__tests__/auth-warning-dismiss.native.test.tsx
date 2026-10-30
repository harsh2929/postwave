/**
 * AuthWarning — a warning you cannot act on must at least be one you can put
 * down.
 *
 * Two different states set `authWarning`. One is actionable: a pending secure
 * local cleanup, whose retry is the ONLY way out (until the prior session's
 * SecureStore artifacts are cleared, signing in again would inherit them).
 * The other is not: a sign-out whose local cleanup succeeded and whose SERVER
 * revocation did not sets a warning with `localCleanupPending: false`, so the
 * strip rendered with no control on it at all and stayed above the form for
 * the rest of the process. The store exported `clearAuthWarning` for exactly
 * that and nothing called it.
 *
 * The asymmetry is the behaviour under test: dismissing an ACTIONABLE warning
 * would hide the only route out of the state it describes, so the retry
 * branch deliberately offers no dismiss.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AuthWarning } from "@/components/auth/AuthWarning";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      {children}
    </SafeAreaProvider>
  );
}

describe("the sign-in auth warning", () => {
  it("can be dismissed when there is nothing to retry", async () => {
    const onDismiss = jest.fn();

    await render(
      <AuthWarning
        message="Server sign-out could not be completed."
        busy={false}
        showRetry={false}
        onRetry={jest.fn()}
        onDismiss={onDismiss}
      />,
      { wrapper },
    );
    await fireEvent.press(screen.getByLabelText("Dismiss this warning"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("never offers a dismiss instead of the retry that resolves it", async () => {
    await render(
      <AuthWarning
        message="Secure local cleanup is incomplete."
        busy={false}
        showRetry
        onRetry={jest.fn()}
        onDismiss={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.getByLabelText("Retry secure local cleanup")).toBeTruthy();
    expect(screen.queryByLabelText("Dismiss this warning")).toBeNull();
  });

  it("stays button-less when no dismiss handler is supplied", async () => {
    await render(
      <AuthWarning
        message="Server sign-out could not be completed."
        busy={false}
        showRetry={false}
        onRetry={jest.fn()}
      />,
      { wrapper },
    );

    expect(screen.queryByLabelText("Dismiss this warning")).toBeNull();
    expect(screen.queryByLabelText("Retry secure local cleanup")).toBeNull();
  });
});
