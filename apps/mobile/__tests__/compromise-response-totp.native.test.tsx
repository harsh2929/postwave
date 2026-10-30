/**
 * TotpSecuritySection — the two controls that change what a password is worth.
 *
 * The control-coverage audit found both mounted and never pressed. That matters
 * more here than almost anywhere else in Settings: "Disable two-factor" is the
 * single control an attacker who already holds a session would reach for, and
 * the three guards standing in front of it (workspace policy, a fresh MFA
 * assertion, a destructive confirm) were entirely unexercised — a regression
 * that dropped any one of them would have looked exactly like a passing suite.
 *
 * Pinned here:
 *
 *  1. POLICY BEATS THE BUTTON. When the workspace REQUIRES two-factor for this
 *     role, the control explains that and issues nothing.
 *  2. A STALE MFA ASSERTION BEATS THE BUTTON. When the session has not
 *     satisfied MFA, the operator is sent to re-verify — with the step-up
 *     purpose that brings them back here — and nothing is disabled.
 *  3. THE CONFIRM IS A REAL GATE. Cancelling disables nothing; only the
 *     destructive button reaches `POST /auth/totp/disable`.
 *  4. THE SESSION IS RE-READ, AND A FAILURE TO RE-READ IS ADMITTED. Disabling
 *     without refreshing would leave the screen claiming TOTP is still on; the
 *     component refreshes, and when the refresh fails it says the disable
 *     happened anyway rather than showing a plain success.
 *  5. ENABLE HANDS THE SERVER'S OWN ENROLLMENT TO THE SHEET — and a failed
 *     enroll opens nothing.
 *
 * `@/api/auth` is mocked at the transport boundary; everything above it (the
 * guards, the Alert copy, the enrollment hand-off) is the real component.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { ReactNode } from "react";

import { router } from "expo-router";
import * as AuthStore from "@/store/auth";
import { TotpSecuritySection } from "@/components/settings/TotpSecuritySection";

type ApiResult = { data?: unknown; error?: { message: string } | null };

/** What the mocked auth transport answers, and what it saw. */
const mockApi: {
  calls: string[];
  enroll: ApiResult;
  disable: ApiResult;
} = {
  calls: [],
  enroll: { data: null, error: null },
  disable: { data: null, error: null },
};

jest.mock("@/api/auth", () => ({
  createAuthClient: () => ({
    baseUrl: "https://api.moosewave.com",
    totpEnroll: async () => {
      mockApi.calls.push("enroll");
      return mockApi.enroll;
    },
    totpDisable: async () => {
      mockApi.calls.push("disable");
      return mockApi.disable;
    },
    totpVerify: async () => ({ data: { verified: true }, error: null }),
  }),
  isValidWorkspaceSlug: () => true,
  redactAuthError: () => "Authentication failed",
  scorePassword: () => ({ label: "Strong", score: 4 }),
  suggestWorkspaceSlug: () => "test-workspace",
}));

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

const ENROLLMENT = {
  otpauth_uri:
    "otpauth://totp/Moosewave:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=Moosewave",
  recovery_codes: ["AAAA-1111", "BBBB-2222"],
};

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

async function press(element: Parameters<typeof fireEvent.press>[0]) {
  await act(async () => {
    fireEvent.press(element);
  });
}

type AlertButton = { text?: string; style?: string; onPress?: () => unknown };
type AlertCall = [string, string?, AlertButton[]?];

function alertSpy() {
  return Alert.alert as unknown as { mock: { calls: AlertCall[] } };
}

/** The most recent Alert, so a test asserts on the dialog actually raised. */
function lastAlert(): AlertCall {
  const { calls } = alertSpy().mock;
  if (calls.length === 0) throw new Error("no Alert was raised");
  return calls[calls.length - 1] as AlertCall;
}

/** Invoke a named button on the most recent Alert, the way a tap would. */
async function tapAlertButton(text: string): Promise<void> {
  const [title, , buttons] = lastAlert();
  const button = (buttons ?? []).find((entry) => entry.text === text);
  if (!button) {
    throw new Error(
      `Alert "${title}" has no "${text}" button (has: ${(buttons ?? [])
        .map((entry) => entry.text)
        .join(", ")})`,
    );
  }
  await act(async () => {
    await button.onPress?.();
  });
}

beforeEach(() => {
  jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  mockApi.calls = [];
  mockApi.enroll = { data: ENROLLMENT, error: null };
  mockApi.disable = { data: { disabled: true }, error: null };
});

afterEach(() => {
  authHarness.__resetAuthStateForTests();
});

describe("TotpSecuritySection — enable", () => {
  it("hands the SERVER's enrollment to the sheet, and opens nothing before the press", async () => {
    authHarness.__setAuthStateForTests({ session: { hasTotp: false } });
    await render(<TotpSecuritySection />, { wrapper });

    expect(screen.getByText("TOTP not enabled")).toBeTruthy();
    expect(screen.queryByLabelText("Two-factor authentication setup")).toBeNull();

    await press(screen.getByLabelText("Enable two-factor authentication"));

    expect(mockApi.calls).toEqual(["enroll"]);
    // The consequence: the enrollment sheet is up, carrying the codes and the
    // QR the server just minted — not a placeholder, and not the previous
    // enrollment.
    expect(screen.getByLabelText("Two-factor authentication setup")).toBeTruthy();
    expect(screen.getByText("AAAA-1111")).toBeTruthy();
    expect(screen.getByText("BBBB-2222")).toBeTruthy();
    expect(
      screen.getByLabelText("QR code for scanning from another device"),
    ).toBeTruthy();
    // And the status line does NOT flip optimistically: enrollment is not
    // enabled until the 6-digit code is verified.
    expect(screen.getByText("TOTP not enabled")).toBeTruthy();
  });

  it("opens no sheet when the server refuses the enrollment, and says why", async () => {
    authHarness.__setAuthStateForTests({ session: { hasTotp: false } });
    mockApi.enroll = { data: null, error: { message: "TOTP already enrolled" } };
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Enable two-factor authentication"));

    expect(mockApi.calls).toEqual(["enroll"]);
    expect(lastAlert()[0]).toBe("Couldn't enroll");
    expect(lastAlert()[1]).toBe("TOTP already enrolled");
    expect(screen.queryByLabelText("Two-factor authentication setup")).toBeNull();
  });

  it("offers enable, never disable, while TOTP is off", async () => {
    authHarness.__setAuthStateForTests({ session: { hasTotp: false } });
    await render(<TotpSecuritySection />, { wrapper });

    expect(
      screen.queryByLabelText("Disable two-factor authentication"),
    ).toBeNull();
  });
});

describe("TotpSecuritySection — disable", () => {
  it("refuses outright when workspace policy requires two-factor for this role", async () => {
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: true, mfaSatisfied: true },
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));

    expect(lastAlert()[0]).toBe("Required by workspace policy");
    expect(lastAlert()[1]).toBe(
      "Two-factor authentication cannot be removed while your workspace policy requires it for your role.",
    );
    // No confirm, and above all no request: the server would refuse it anyway,
    // and offering the destructive dialog would teach the wrong model.
    expect(mockApi.calls).toEqual([]);
  });

  it("sends an un-verified session to step up first — and disables nothing", async () => {
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: false },
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));

    expect(lastAlert()[0]).toBe("Verify before disabling");
    expect(mockApi.calls).toEqual([]);

    await tapAlertButton("Verify");

    // The purpose is load-bearing: it is what returns the operator to the
    // security settings after the code, instead of to the dashboard.
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(auth)/totp",
      params: { purpose: "security_settings" },
    });
    expect(mockApi.calls).toEqual([]);
  });

  it("cancelling the un-verified prompt navigates nowhere", async () => {
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: false },
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));
    await tapAlertButton("Cancel");

    expect(router.push).not.toHaveBeenCalled();
    expect(mockApi.calls).toEqual([]);
  });

  it("raises a destructive confirm that names the consequence, and cancelling disables nothing", async () => {
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: true },
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));

    const [title, message, buttons] = lastAlert();
    expect(title).toBe("Disable two-factor?");
    expect(message).toBe(
      "Your account will accept password-only sign-in until you re-enroll.",
    );
    // The affirmative is marked destructive so the OS paints it red — the
    // only visual cue this dialog gets.
    expect(buttons?.find((b) => b.text === "Disable")?.style).toBe("destructive");
    expect(buttons?.find((b) => b.text === "Cancel")?.style).toBe("cancel");

    await tapAlertButton("Cancel");
    expect(mockApi.calls).toEqual([]);
  });

  it("confirming disables two-factor, re-reads the session, and reports it", async () => {
    const refresh = jest.fn(async () => undefined);
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: true },
      refreshSessionFromServer: refresh,
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));
    await tapAlertButton("Disable");

    expect(mockApi.calls).toEqual(["disable"]);
    // Re-reading is not cosmetic: without it the section keeps rendering
    // "TOTP enabled" over an account that no longer has it.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lastAlert()[0]).toBe("Disabled");
    expect(lastAlert()[1]).toBe("Two-factor auth was removed.");
  });

  it("surfaces the server's refusal and does not re-read the session", async () => {
    const refresh = jest.fn(async () => undefined);
    mockApi.disable = { error: { message: "step-up required" } };
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: true },
      refreshSessionFromServer: refresh,
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));
    await tapAlertButton("Disable");

    expect(lastAlert()[0]).toBe("Couldn't disable");
    expect(lastAlert()[1]).toBe("step-up required");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("admits the disable happened when the session refresh fails", async () => {
    const refresh = jest.fn(async () => {
      throw new Error("Network request failed");
    });
    authHarness.__setAuthStateForTests({
      session: { hasTotp: true, mfaRequired: false, mfaSatisfied: true },
      refreshSessionFromServer: refresh,
    });
    await render(<TotpSecuritySection />, { wrapper });

    await press(screen.getByLabelText("Disable two-factor authentication"));
    await tapAlertButton("Disable");

    // The disable DID land. Reporting a plain failure here would send the
    // operator to disable it a second time on a workspace that no longer has
    // two-factor at all.
    expect(mockApi.calls).toEqual(["disable"]);
    expect(lastAlert()[0]).toBe("Disabled, refresh needed");
    expect(lastAlert()[1]).toBe("Network request failed");
  });
});

describe("TotpSecuritySection — visibility", () => {
  it("renders nothing at all for an API-key session, which has no TOTP to manage", async () => {
    authHarness.__setAuthStateForTests({ mode: "api_key" });
    await render(<TotpSecuritySection />, { wrapper });
    expect(screen.queryByText("Security")).toBeNull();
  });

  it("renders nothing when there is no session", async () => {
    authHarness.__setAuthStateForTests({ session: null });
    await render(<TotpSecuritySection />, { wrapper });
    expect(screen.queryByText("Security")).toBeNull();
  });
});
