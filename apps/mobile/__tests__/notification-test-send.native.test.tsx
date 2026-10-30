/**
 * NotificationPreferencesSection — the test-send that closes the loop.
 *
 * The section could change WHICH emails Moosewave sends you and had no way to
 * establish that any of them arrive. POST /api/v1/settings/notifications/test
 * is mounted on the same object as the GET and PATCH it already speaks
 * (apps/api/internal/settings/notifications.go MountRoutes) and mobile owned
 * neither the call nor a control for it.
 *
 * The assertion that matters is the copy: two of the server's four answers are
 * product boundaries (this deployment has no mailer / this account has no
 * address) and reporting either as a transient failure sends the user to look
 * in the wrong place.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const PREFS = {
  email_on_send_complete: true,
  email_on_approval_request: true,
  email_on_bounce_alert: false,
  digest_frequency: "daily",
};

jest.mock("@/api/settings", () => {
  const sendTest = jest.fn(async () => ({
    data: { sent: true, to: "ops@example.com" },
    error: null,
  }));
  return {
    __esModule: true,
    __sendTest: sendTest,
    getNotificationPrefs: jest.fn(async () => ({
      data: {
        email_on_send_complete: true,
        email_on_approval_request: true,
        email_on_bounce_alert: false,
        digest_frequency: "daily",
      },
      error: null,
    })),
    patchNotificationPrefs: jest.fn(async () => ({ data: PREFS, error: null })),
    sendTestNotification: sendTest,
  };
});

import { NotificationPreferencesSection } from "@/components/settings/NotificationPreferencesSection";

const settingsHarness = jest.requireMock("@/api/settings") as {
  __sendTest: jest.Mock<() => Promise<unknown>>;
};

afterEach(() => {
  settingsHarness.__sendTest.mockReset();
});

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

describe("the notification test-send", () => {
  it("names the address the server says it mailed", async () => {
    settingsHarness.__sendTest.mockResolvedValue({
      data: { sent: true, to: "ops@example.com" },
      error: null,
    });

    await render(<NotificationPreferencesSection />, { wrapper });
    const button = await screen.findByLabelText("Send a test notification");
    await fireEvent.press(button);

    expect(settingsHarness.__sendTest).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByText("Test notification sent to ops@example.com."),
      ).toBeTruthy(),
    );
  });

  it("does not blame the connection for a deployment with no mailer", async () => {
    settingsHarness.__sendTest.mockResolvedValue({
      data: null,
      error: {
        status: 503,
        code: "mailer_unavailable",
        message: "email delivery is not configured",
      },
    });

    await render(<NotificationPreferencesSection />, { wrapper });
    await fireEvent.press(
      await screen.findByLabelText("Send a test notification"),
    );

    await waitFor(() =>
      expect(
        screen.getByText(/no email delivery configured/i),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/connection/i)).toBeNull();
  });
});
