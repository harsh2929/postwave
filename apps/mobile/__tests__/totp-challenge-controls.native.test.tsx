/**
 * The nine controls of the per-session TOTP challenge — none of which had any
 * coverage at all.
 *
 * This screen is the last gate before a signed-in session, and every control
 * on it either spends a credential or weakens the gate:
 *
 *  - `Verify`, and the return key on BOTH fields, spend a code. A recovery
 *    code is ONE-SHOT, so a submit that fires twice, or fires with a code the
 *    server will certainly refuse, costs the user a credential they cannot get
 *    back.
 *  - The recovery/authenticator toggle swaps which credential is about to be
 *    posted. If it left the other field populated, the screen would be holding
 *    a half-typed secret for a path it is no longer on.
 *  - `Switch account` DESTROYS the half-built session during sign-in — and
 *    must NOT destroy it when the same button is a step-up "Cancel" opened
 *    from Settings. One button, two consequences, decided by the caller.
 *  - The remember-device checkbox and its duration radios are the AUTH#48
 *    opt-in: what they end up putting on the wire IS the security decision.
 *
 * So every case below asserts the CONSEQUENCE: the exact challenge body that
 * reached the client, the credential that was cleared, the session that was
 * (or was not) cancelled, the route that was replaced.
 *
 * The seam is `createAuthClient(...).totpChallenge` — the network. Everything
 * above it runs for real: the screen's state machine, `submitTotpChallenge`'s
 * trust-refusal retry, `challengeErrorMessage`, `trustedDeviceContract`.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { router } from "expo-router";

import TotpGate from "../app/(auth)/totp";

const authStore = require("./mocks/authStore.cjs");
const expoRouter = require("./mocks/expoRouter.cjs");

const routerReplace = router.replace as unknown as {
  mock: { calls: unknown[][] };
};

type ChallengeResponse = { data?: unknown; error?: unknown };

/**
 * The network seam. `calls` is every body the screen actually posted;
 * `responses` is a queue the test fills, so a case can script a refusal
 * followed by the retry's answer.
 */
const mockChallenge: {
  calls: Record<string, unknown>[];
  responses: ChallengeResponse[];
} = { calls: [], responses: [] };

/**
 * What `/me` says the session needs. The screen re-reads it after every
 * challenge, so the stub flips it to "none" when the server accepts a code —
 * that is what the real endpoint does, and routing on anything less would
 * make the success path untestable.
 */
const mockGate: { value: string } = { value: "challenge" };

/** `getBiometricLockEnabled()` — the app-lock guardrail on the trust offer. */
const mockLock: { enabled: boolean } = { enabled: true };

jest.mock("@/api/auth", () => ({
  createAuthClient: () => ({
    baseUrl: "https://api.moosewave.com",
    totpChallenge: async (body: Record<string, unknown>) => {
      mockChallenge.calls.push(body);
      const next: ChallengeResponse = mockChallenge.responses.shift() ?? {
        data: {
          mfa_satisfied: true,
          device_trusted: body.trust_device === true,
        },
      };
      const data = next.data as { mfa_satisfied?: boolean } | undefined;
      if (data?.mfa_satisfied === true) mockGate.value = "none";
      return { data: next.data, error: next.error ?? null };
    },
  }),
  isValidWorkspaceSlug: () => true,
  // Passed through rather than flattened, so a server message the copy module
  // decides to surface is still readable in an assertion.
  redactAuthError: (message: string) => message,
  scorePassword: () => ({ label: "Strong", score: 4 }),
  suggestWorkspaceSlug: () => "test-workspace",
}));

jest.mock("@/lib/biometric", () => ({
  getBiometricLockEnabled: async () => mockLock.enabled,
  requireDeviceAuth: async () => true,
}));

/** The screen's mount effect awaits `/me`; nothing renders until it lands. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderGate() {
  const view = await render(React.createElement(TotpGate));
  await flush();
  return view;
}

type Gate = Awaited<ReturnType<typeof renderGate>>;

async function typeCode(view: Gate, digits: string) {
  await fireEvent.changeText(
    view.getByLabelText("6-digit authentication code"),
    digits,
  );
  await flush();
}

async function press(view: Gate, label: string) {
  await fireEvent.press(view.getByLabelText(label));
  await flush();
}

beforeEach(() => {
  mockChallenge.calls.length = 0;
  mockChallenge.responses.length = 0;
  mockGate.value = "challenge";
  mockLock.enabled = true;
  // Without a challenge gate the screen renders its error state and every
  // assertion below would be about a screen with no controls on it.
  authStore.__setAuthStateForTests({ mfaGate: () => mockGate.value });
});

afterEach(() => {
  authStore.__resetAuthStateForTests();
  expoRouter.__setSearchParamsForTests({});
});

describe("totp challenge — Verify", () => {
  it("stays inert until a code exists, and pressing it posts nothing", async () => {
    const view = await renderGate();

    const verify = view.getByLabelText("Verify code");
    expect(verify.props.accessibilityState?.disabled).toBe(true);

    // Three digits is not a code. The button must not become a way to spend
    // an attempt against the rate limiter.
    await typeCode(view, "123");
    expect(
      view.getByLabelText("Verify code").props.accessibilityState?.disabled,
    ).toBe(true);

    await press(view, "Verify code");
    expect(mockChallenge.calls).toEqual([]);
  });

  it("posts exactly one challenge when six digits arrive at once", async () => {
    const view = await renderGate();

    // A pasted code lands as a single change. The `!busy` guard is the only
    // thing between that and two challenges for one code.
    await typeCode(view, "123456");

    expect(mockChallenge.calls).toEqual([{ code: "123456" }]);
  });

  it("clears a rejected code and says why it was rejected", async () => {
    mockChallenge.responses.push({
      error: { code: "invalid_code", status: 401, message: "HTTP 401" },
    });
    const view = await renderGate();

    await typeCode(view, "111111");

    expect(mockChallenge.calls).toHaveLength(1);
    expect(
      view.getByText(
        "That code didn't work. Codes rotate every 30 seconds — enter the current one.",
      ),
    ).toBeTruthy();
    // Cleared, so the next attempt cannot silently re-send the stale code.
    expect(
      view.getByLabelText("6-digit authentication code").props.value,
    ).toBe("");
    expect(
      view.getByLabelText("Verify code").props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it("posts the recovery code when Verify is pressed on the recovery path", async () => {
    const view = await renderGate();

    await press(view, "Switch to a recovery code");
    await fireEvent.changeText(
      view.getByLabelText("Recovery code"),
      "  abcd-efgh-ijkl  ",
    );
    await flush();
    await press(view, "Verify code");

    // Trimmed, and posted as a recovery credential — never as `code`.
    expect(mockChallenge.calls).toEqual([{ recovery_code: "abcd-efgh-ijkl" }]);
  });
});

describe("totp challenge — the return key", () => {
  it("refuses an incomplete code instead of spending an attempt on it", async () => {
    const view = await renderGate();

    await typeCode(view, "1234");
    await fireEvent(
      view.getByLabelText("6-digit authentication code"),
      "submitEditing",
    );
    await flush();

    expect(mockChallenge.calls).toEqual([]);
    expect(
      view.getByText("Enter the 6-digit code from your authenticator"),
    ).toBeTruthy();
  });

  it("submits the recovery code from the recovery field", async () => {
    const view = await renderGate();

    await press(view, "Switch to a recovery code");
    await fireEvent.changeText(
      view.getByLabelText("Recovery code"),
      "zzzz-yyyy-xxxx",
    );
    await flush();
    await fireEvent(view.getByLabelText("Recovery code"), "submitEditing");
    await flush();

    expect(mockChallenge.calls).toEqual([{ recovery_code: "zzzz-yyyy-xxxx" }]);
  });

  it("refuses an empty recovery field rather than posting a blank credential", async () => {
    const view = await renderGate();

    await press(view, "Switch to a recovery code");
    await fireEvent(view.getByLabelText("Recovery code"), "submitEditing");
    await flush();

    expect(mockChallenge.calls).toEqual([]);
    expect(view.getByText("Enter a recovery code")).toBeTruthy();
  });
});

describe("totp challenge — the credential toggle", () => {
  it("swaps the field, the instruction and the label, and drops what was typed", async () => {
    const view = await renderGate();

    await typeCode(view, "12345");
    await press(view, "Switch to a recovery code");

    expect(view.getByLabelText("Recovery code")).toBeTruthy();
    expect(view.queryByLabelText("6-digit authentication code")).toBeNull();
    expect(
      view.getByText("Enter one of your one-time recovery codes."),
    ).toBeTruthy();
    // The control now offers the way back, rather than repeating itself.
    expect(view.getByLabelText("Switch to authenticator code")).toBeTruthy();

    await press(view, "Switch to authenticator code");

    // The half-typed authenticator code did NOT survive the round trip: a
    // credential kept across a path the user left is a credential that can be
    // posted by accident.
    expect(
      view.getByLabelText("6-digit authentication code").props.value,
    ).toBe("");
    expect(
      view.getByText("Enter the 6-digit code from your authenticator app."),
    ).toBeTruthy();
    expect(mockChallenge.calls).toEqual([]);
  });
});

describe("totp challenge — switch account", () => {
  it("abandons the half-built session and returns to sign-in", async () => {
    const view = await renderGate();

    await press(view, "Switch account");

    // The session is CANCELLED, not merely navigated away from: leaving a
    // half-authenticated session on the device is the bug this button exists
    // to avoid.
    expect(authStore.useAuthStore.getState().cancelSession).toHaveBeenCalled();
    expect(routerReplace.mock.calls).toContainEqual(["/(auth)/sign-in"]);
    // And the screen says what it is doing while it happens.
    expect(view.getByText("Switching accounts…")).toBeTruthy();
  });

  it("cancels a settings step-up WITHOUT destroying the signed-in session", async () => {
    // Same button, opened from Settings. Cancelling a re-authentication must
    // not sign the user out of the app they are already inside.
    expoRouter.__setSearchParamsForTests({ purpose: "security_settings" });
    authStore.__setAuthStateForTests({
      mfaGate: () => mockGate.value,
      session: { totpEnabled: true, mfaSatisfied: false },
    });
    const view = await renderGate();

    await press(view, "Cancel verification");

    expect(
      authStore.useAuthStore.getState().cancelSession,
    ).not.toHaveBeenCalled();
    expect(routerReplace.mock.calls).toContainEqual(["/(tabs)/settings"]);
  });
});

describe("totp challenge — remember this device", () => {
  it("is off by default and hides its durations until it is ticked", async () => {
    const view = await renderGate();

    const checkbox = view.getByLabelText("Remember this device");
    // A control that weakens MFA is ticked, never inherited.
    expect(checkbox.props.accessibilityState?.checked).toBe(false);
    expect(view.queryByLabelText("30 days")).toBeNull();
    expect(view.queryByLabelText("180 days")).toBeNull();

    await press(view, "Remember this device");

    expect(
      view.getByLabelText("Remember this device").props.accessibilityState
        ?.checked,
    ).toBe(true);
    // The SHORTEST option is preselected — the default gives away the least.
    expect(view.getByLabelText("30 days").props.accessibilityState?.selected).toBe(
      true,
    );
    expect(
      view.getByLabelText("180 days").props.accessibilityState?.selected,
    ).toBe(false);
    expect(
      view.getByText(
        "This device won't ask for a code again for 30 days. You can undo this any time in Settings.",
      ),
    ).toBeTruthy();
  });

  it("is never offered on a phone with no app lock", async () => {
    // "Remember this device" without a device lock means anyone holding the
    // handset is past two-factor. The offer is withheld, not warned about.
    mockLock.enabled = false;
    const view = await renderGate();

    expect(view.queryByLabelText("Remember this device")).toBeNull();

    await typeCode(view, "123456");
    expect(mockChallenge.calls).toEqual([{ code: "123456" }]);
  });

  it("puts the duration the user picked on the wire", async () => {
    const view = await renderGate();

    await press(view, "Remember this device");
    await press(view, "180 days");

    expect(
      view.getByLabelText("180 days").props.accessibilityState?.selected,
    ).toBe(true);
    expect(
      view.getByLabelText("30 days").props.accessibilityState?.selected,
    ).toBe(false);
    // The consent line follows the picker; the numbers alone do not say what
    // is being given up.
    expect(
      view.getByText(
        "This device won't ask for a code again for 180 days. You can undo this any time in Settings.",
      ),
    ).toBeTruthy();

    await typeCode(view, "424242");

    expect(mockChallenge.calls).toEqual([
      { code: "424242", trust_device: true, trust_days: 180 },
    ]);
  });

  it("asks for no trust at all once the box is unticked", async () => {
    const view = await renderGate();

    await press(view, "Remember this device");
    await press(view, "90 days");
    await press(view, "Remember this device");

    expect(
      view.getByLabelText("Remember this device").props.accessibilityState
        ?.checked,
    ).toBe(false);
    expect(view.queryByLabelText("90 days")).toBeNull();

    await typeCode(view, "555555");

    // No `trust_device: false` — the field is absent, which is what asks for
    // nothing (see trustRequestFields).
    expect(mockChallenge.calls).toEqual([{ code: "555555" }]);
  });

  it("retries once without trust when the workspace refuses it, and says so", async () => {
    // `validateTrustRequest` runs BEFORE the code is verified, so a
    // `device_trust_disabled` 403 leaves the credential unspent and the retry
    // is free. Getting this wrong burns a one-shot recovery code.
    mockChallenge.responses.push({
      error: { code: "device_trust_disabled", status: 403, message: "HTTP 403" },
    });
    const view = await renderGate();

    await press(view, "Remember this device");
    await typeCode(view, "606060");

    expect(mockChallenge.calls).toEqual([
      { code: "606060", trust_device: true, trust_days: 30 },
      { code: "606060" },
    ]);
    // The control explains itself rather than silently disappearing.
    expect(
      view.getByText(/doesn.t allow remembering devices/),
    ).toBeTruthy();
    expect(view.queryByLabelText("Remember this device")).toBeNull();
  });
});
