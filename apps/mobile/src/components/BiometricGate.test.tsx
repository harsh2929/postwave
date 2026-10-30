import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const nativeState = vi.hoisted(() => ({
  appState: "active",
  appStateListener: null as ((state: string) => void) | null,
  preferenceListener: null as ((enabled: boolean) => void) | null,
  graceListener: null as ((seconds: number) => void) | null,
  lockEnabled: true,
  authenticateResult: false,
  graceSeconds: 0,
}));
const preventScreenCaptureAsync = vi.hoisted(() =>
  vi.fn(async () => undefined),
);
const clearWidgetSnapshot = vi.hoisted(() => vi.fn(() => true));
const alertMock = vi.hoisted(() =>
  vi.fn(
    (
      _title: string,
      _message?: string,
      _buttons?: { text: string; onPress?: () => void }[],
    ) => undefined,
  ),
);
const signOut = vi.hoisted(() => vi.fn(async () => undefined));
const unregisterPushThenSignOut = vi.hoisted(() =>
  vi.fn(async (run: () => Promise<void>) => {
    await run();
  }),
);
const setBiometricLockEnabled = vi.hoisted(() => vi.fn(async () => undefined));
const listTrustedDevices = vi.hoisted(() =>
  vi.fn(async (_baseUrl: string) => ({
    data: {
      devices: [
        { id: "someone-elses-laptop", current: false },
        { id: "this-phone", current: true },
      ],
    },
  })),
);
const revokeTrustedDevice = vi.hoisted(() =>
  vi.fn(async (_baseUrl: string, _id: string) => ({ data: { revoked: true } })),
);
const authenticateSpy = vi.hoisted(() =>
  vi.fn(async (_reason: string) => false),
);

vi.mock("react-native", () => ({
  Alert: {
    alert: (
      title: string,
      message?: string,
      buttons?: { text: string; onPress?: () => void }[],
    ) => alertMock(title, message, buttons),
  },
  AppState: {
    get currentState() {
      return nativeState.appState;
    },
    addEventListener: vi.fn(
      (_event: string, listener: (state: string) => void) => {
        nativeState.appStateListener = listener;
        return { remove: vi.fn() };
      },
    ),
  },
  Platform: { OS: "android" },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));

vi.mock("expo-screen-capture", () => ({
  preventScreenCaptureAsync,
  allowScreenCaptureAsync: vi.fn(async () => undefined),
  enableAppSwitcherProtectionAsync: vi.fn(async () => undefined),
  disableAppSwitcherProtectionAsync: vi.fn(async () => undefined),
}));

vi.mock("@/lib/biometric", () => ({
  authenticate: (reason: string) => {
    void authenticateSpy(reason);
    return Promise.resolve(nativeState.authenticateResult);
  },
  canAuthenticate: vi.fn(async () => true),
  getAppLockGraceSeconds: vi.fn(async () => nativeState.graceSeconds),
  getBiometricLockEnabled: vi.fn(async () => nativeState.lockEnabled),
  isBiometricAvailable: vi.fn(async () => true),
  setBiometricLockEnabled,
  subscribeAppLockGrace: vi.fn((listener: (seconds: number) => void) => {
    nativeState.graceListener = listener;
    return vi.fn();
  }),
  subscribeBiometricLockPreference: vi.fn(
    (listener: (enabled: boolean) => void) => {
      nativeState.preferenceListener = listener;
      return vi.fn();
    },
  ),
}));

vi.mock("@/lib/fonts", () => ({
  FONT: { display: "Display", regular: "Regular", semibold: "Semibold" },
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    t: {
      accent: "#f00",
      accentFg: "#000",
      accentSubtle: "#200",
      bg: "#000",
      border: "#333",
      fg: "#fff",
      fgMuted: "#aaa",
    },
  }),
}));

vi.mock("@/lib/widgetData", () => ({
  clearWidgetSnapshot,
}));

vi.mock("@/lib/haptics", () => ({
  haptics: {
    tap: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    impact: vi.fn(),
  },
}));

vi.mock("@/lib/push", () => ({ unregisterPushThenSignOut }));

vi.mock("@/api/trustedDevices", () => ({
  listTrustedDevices,
  revokeTrustedDevice,
}));

vi.mock("@/store/auth", () => {
  const state = {
    baseUrl: "https://api.example.test",
    session: { workspaceName: "Acme Co" },
    signOut,
  };
  const useAuthStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useAuthStore.getState = () => state;
  return { useAuthStore };
});

// eslint-disable-next-line import/first
import { Text } from "react-native";
// eslint-disable-next-line import/first
import { BiometricGate } from "./BiometricGate";

async function renderGate(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(
      <BiometricGate>
        <Text testID="protected-customer-content">Sensitive workspace</Text>
      </BiometricGate>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe("BiometricGate privacy boundary", () => {
  beforeEach(() => {
    nativeState.appState = "active";
    nativeState.appStateListener = null;
    nativeState.preferenceListener = null;
    nativeState.lockEnabled = true;
    nativeState.authenticateResult = false;
    nativeState.graceListener = null;
    nativeState.graceSeconds = 0;
    preventScreenCaptureAsync.mockClear();
    clearWidgetSnapshot.mockClear();
    alertMock.mockClear();
    signOut.mockClear();
    unregisterPushThenSignOut.mockClear();
    setBiometricLockEnabled.mockClear();
    listTrustedDevices.mockClear();
    revokeTrustedDevice.mockClear();
  });

  async function signOutFromTheLockScreen(): Promise<void> {
    const renderer = await renderGate();
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: "Sign out of this workspace" })
        .props.onPress();
    });
    const destructive = alertMock.mock.calls[0]?.[2]?.find(
      (button) => button.text === "Sign out",
    );
    await act(async () => {
      destructive?.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("offers a sign-out escape hatch that also disarms the lock", async () => {
    // Without this, a wedged authenticator (a real Android OEM bug class)
    // leaves deleting the app as the only exit — while the SERVER session
    // stays alive.
    const renderer = await renderGate();
    const signOutButton = renderer.root.findByProps({
      accessibilityLabel: "Sign out of this workspace",
    });

    await act(async () => {
      signOutButton.props.onPress();
    });
    expect(alertMock).toHaveBeenCalledTimes(1);

    const destructive = alertMock.mock.calls[0]?.[2]?.find(
      (button) => button.text === "Sign out",
    );
    await act(async () => {
      destructive?.onPress?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(unregisterPushThenSignOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(setBiometricLockEnabled).toHaveBeenCalledWith(false);
  });

  it("retires this phone's trusted-device credential with the lock it depended on", async () => {
    // "Remember this device" is only offered when the app lock is ON, because
    // a 180-day MFA bypass on an unlocked handset is worse than the password
    // it supplements. This escape hatch turns the lock OFF, and a trust record
    // deliberately outlives the session — so leaving it behind would keep the
    // credential and drop its only precondition.
    await signOutFromTheLockScreen();

    expect(revokeTrustedDevice).toHaveBeenCalledWith(
      "https://api.example.test",
      "this-phone",
    );
    // Signing out here is a decision about THIS handset. It must not silently
    // re-impose 2FA on the laptop the user left at the office.
    expect(revokeTrustedDevice).toHaveBeenCalledTimes(1);
    // The revoke needs the session cookie, so it has to precede the teardown.
    expect(revokeTrustedDevice.mock.invocationCallOrder[0]).toBeLessThan(
      unregisterPushThenSignOut.mock.invocationCallOrder[0]!,
    );
    expect(setBiometricLockEnabled).toHaveBeenCalledWith(false);
  });

  it("still signs out when the trust record cannot be reached", async () => {
    // The usual reason someone reaches this button is that something is
    // already broken. A failed revoke must not strand them on the lock screen;
    // the server-side trust TTL is the backstop.
    listTrustedDevices.mockRejectedValueOnce(new Error("offline"));
    await signOutFromTheLockScreen();

    expect(revokeTrustedDevice).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(setBiometricLockEnabled).toHaveBeenCalledWith(false);
  });

  it("names the workspace behind the lock", async () => {
    const renderer = await renderGate();
    const copy = JSON.stringify(renderer.toJSON());
    expect(copy).toContain("Acme Co is protected");
  });

  it("unmounts protected content and hides the wrapper from TalkBack while locked", async () => {
    const renderer = await renderGate();

    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({
        importantForAccessibility: "no-hide-descendants",
      }).props.accessibilityElementsHidden,
    ).toBe(true);
    expect(preventScreenCaptureAsync).toHaveBeenCalledWith("postwave-app-lock");
    expect(clearWidgetSnapshot).toHaveBeenCalledOnce();
  });

  it("arms reactively after a verified setting change and removes content on inactive", async () => {
    nativeState.lockEnabled = false;
    const renderer = await renderGate();
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(1);

    await act(async () => {
      nativeState.preferenceListener?.(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(1);

    act(() => {
      nativeState.appState = "inactive";
      nativeState.appStateListener?.("inactive");
    });
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(0);
  });
});

describe("BiometricGate re-prompt grace", () => {
  beforeEach(() => {
    nativeState.appState = "active";
    nativeState.appStateListener = null;
    nativeState.preferenceListener = null;
    nativeState.graceListener = null;
    nativeState.lockEnabled = true;
    // The unlock prompt succeeds, so the gate starts unlocked and the test is
    // about what happens on the way BACK from another app.
    nativeState.authenticateResult = true;
    nativeState.graceSeconds = 0;
    authenticateSpy.mockClear();
  });

  async function leaveAndReturn(): Promise<TestRenderer.ReactTestRenderer> {
    const renderer = await renderGate();
    await act(async () => {
      nativeState.appState = "background";
      nativeState.appStateListener?.("background");
      await Promise.resolve();
    });
    // Cover is unconditional: content must be gone the instant we leave.
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(0);
    await act(async () => {
      nativeState.appState = "active";
      nativeState.appStateListener?.("active");
      await Promise.resolve();
      await Promise.resolve();
    });
    return renderer;
  }

  it("re-prompts on return at the default zero grace", async () => {
    await leaveAndReturn();
    // One prompt on arm, one on return. Today's behaviour, unchanged for
    // anyone who never touches the new picker.
    expect(authenticateSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("skips the prompt for a brief switch once a grace window is chosen", async () => {
    nativeState.graceSeconds = 60;
    const renderer = await leaveAndReturn();
    // Exactly the arm-time prompt: returning inside the window costs nothing.
    expect(authenticateSpy).toHaveBeenCalledTimes(1);
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(1);
  });

  it("picks up a Settings change without a remount", async () => {
    const renderer = await renderGate();
    await act(async () => {
      nativeState.graceListener?.(900);
      nativeState.appState = "background";
      nativeState.appStateListener?.("background");
      await Promise.resolve();
    });
    await act(async () => {
      nativeState.appState = "active";
      nativeState.appStateListener?.("active");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({ testID: "protected-customer-content" }),
    ).toHaveLength(1);
  });
});
