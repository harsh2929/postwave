/**
 * Turning the app lock OFF is as consequential as turning it on.
 *
 * Enabling it always demanded a device-owner challenge — we refuse to arm a
 * lock the user cannot satisfy. Disabling it demanded nothing at all, so the
 * control was asymmetric in the direction that matters: anyone who reached the
 * phone while it was unlocked (or inside the re-prompt grace window) could
 * retire the lock silently, and with it everything that hangs off the lock —
 * the widget-metrics refusal, and the "remember this device" offer that is only
 * made when the lock is on. These tests pin both halves of the symmetry.
 *
 * The second describe pins what "everything that hangs off the lock" means for
 * the remembered-device credential. Trust is only OFFERED while the lock is on
 * (RememberDeviceOptIn), and the pw_device_trust cookie outlives the session
 * and a sign-out — so a disarm that left it behind kept a 180-day second-factor
 * bypass on a phone that no longer met the one condition it was granted under.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import * as ReactQuery from "@tanstack/react-query";
import type { ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import * as AuthStore from "@/store/auth";

const mockAuthenticate = jest.fn<(reason: string) => Promise<boolean>>();
const mockSetBiometricLockEnabled =
  jest.fn<(enabled: boolean) => Promise<void>>();

interface TrustedDevicesEnvelope {
  data?: unknown;
  error?: { status?: number; kind?: string; message: string };
}
const mockListTrustedDevices =
  jest.fn<(baseUrl: string) => Promise<TrustedDevicesEnvelope>>();
const mockRevokeTrustedDevice =
  jest.fn<(baseUrl: string, id: string) => Promise<TrustedDevicesEnvelope>>();
const mockRevokeAllTrustedDevices =
  jest.fn<(baseUrl: string) => Promise<TrustedDevicesEnvelope>>();

jest.mock("@/api/trustedDevices", () => ({
  listTrustedDevices: (baseUrl: string) => mockListTrustedDevices(baseUrl),
  revokeTrustedDevice: (baseUrl: string, id: string) =>
    mockRevokeTrustedDevice(baseUrl, id),
  revokeAllTrustedDevices: (baseUrl: string) =>
    mockRevokeAllTrustedDevices(baseUrl),
}));

const mockToasts: { kind?: string; message: string }[] = [];
jest.mock("@/components/Toast", () => ({
  useToast: () => ({
    toast: (entry: { kind?: string; message: string }) => {
      mockToasts.push(entry);
    },
    dismiss: () => undefined,
  }),
}));

jest.mock("@/lib/biometric", () => ({
  authenticate: (reason: string) => mockAuthenticate(reason),
  canAuthenticate: async () => true,
  isBiometricAvailable: async () => true,
  getBiometricLockEnabled: async () => true,
  setBiometricLockEnabled: (enabled: boolean) =>
    mockSetBiometricLockEnabled(enabled),
  getAppLockGraceSeconds: async () => 0,
  setAppLockGraceSeconds: async () => undefined,
  subscribeBiometricLockPreference: () => () => undefined,
  subscribeAppLockGrace: () => () => undefined,
}));

// eslint-disable-next-line import/first
import { TRUSTED_DEVICES_QUERY_KEY } from "@/hooks/useTrustedDevices";
// eslint-disable-next-line import/first
import Settings from "../app/(tabs)/settings";

const queryHarness = ReactQuery as typeof ReactQuery & {
  __getQueryClientForTests: () => { invalidateQueries: jest.Mock };
};
const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

/** The laptop is remembered too; only the phone in hand may be retired. */
function trustedDevicesFixture(): TrustedDevicesEnvelope {
  return {
    data: {
      devices: [
        {
          id: "trust-laptop",
          current: false,
          trust_days: 180,
          issued_at: "2026-09-01T09:00:00Z",
          expires_at: "2027-02-28T09:00:00Z",
        },
        {
          id: "trust-this-phone",
          current: true,
          trust_days: 180,
          issued_at: "2026-09-10T09:00:00Z",
          expires_at: "2027-03-09T09:00:00Z",
        },
      ],
      allowed: true,
      allowedDurations: [30, 90, 180],
    },
  };
}

// The config runs clearMocks/restoreMocks before every test, so the transport
// answers are (re)installed here — after that reset, never at module scope.
beforeEach(() => {
  mockToasts.length = 0;
  mockListTrustedDevices.mockResolvedValue(trustedDevicesFixture());
  mockRevokeTrustedDevice.mockResolvedValue({ data: { revoked: true } });
  mockRevokeAllTrustedDevices.mockResolvedValue({ data: { revoked_count: 2 } });
});

afterEach(() => {
  authHarness.__resetAuthStateForTests();
});

/** Drain every queued continuation, not a hand-counted number of them. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function lockSwitch() {
  return screen.getByLabelText("Require Face ID to unlock");
}

async function turnLockOff(): Promise<void> {
  await act(async () => {
    fireEvent(lockSwitch(), "valueChange", false);
  });
}

function warnings() {
  return mockToasts.filter((entry) => entry.kind === "warning");
}

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

async function renderWithLockOn() {
  const view = await render(<Settings />, { wrapper });
  // The stored preference resolves in an effect; the switch reads OFF until it
  // lands, and asserting against that frame would test nothing.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return view;
}

describe("disabling the app lock", () => {
  it("challenges the device owner before the preference is cleared", async () => {
    mockAuthenticate.mockResolvedValue(false);
    mockSetBiometricLockEnabled.mockResolvedValue(undefined);
    await renderWithLockOn();

    const toggle = screen.getByLabelText("Require Face ID to unlock");
    expect(toggle.props.accessibilityState?.checked).toBe(true);

    await act(async () => {
      fireEvent(toggle, "valueChange", false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    // A refused or cancelled challenge leaves the lock exactly as it was —
    // the Keychain is not touched and the switch does not lie about it.
    expect(mockSetBiometricLockEnabled).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Require Face ID to unlock").props
        .accessibilityState?.checked,
    ).toBe(true);
  });

  it("clears the preference once the owner passes", async () => {
    mockAuthenticate.mockResolvedValue(true);
    mockSetBiometricLockEnabled.mockResolvedValue(undefined);
    await renderWithLockOn();

    await act(async () => {
      fireEvent(
        screen.getByLabelText("Require Face ID to unlock"),
        "valueChange",
        false,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    // Passing is what unlocks the write, so the challenge has to have run.
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockSetBiometricLockEnabled).toHaveBeenCalledWith(false);
  });
});

describe("disabling the app lock retires this phone's remembered-device trust", () => {
  it("revokes this phone's trust record, and only that one, once the owner passes", async () => {
    mockAuthenticate.mockResolvedValue(true);
    mockSetBiometricLockEnabled.mockResolvedValue(undefined);
    await renderWithLockOn();

    await turnLockOff();

    await waitFor(() => {
      expect(mockRevokeTrustedDevice).toHaveBeenCalledTimes(1);
    });
    expect(mockRevokeTrustedDevice).toHaveBeenCalledWith(
      "https://api.moosewave.com",
      "trust-this-phone",
    );
    // A disarm is a statement about the handset in hand. The laptop keeps its
    // trust, and the "forget every device" panic button is never pressed.
    expect(mockRevokeTrustedDevice).not.toHaveBeenCalledWith(
      expect.anything(),
      "trust-laptop",
    );
    expect(mockRevokeAllTrustedDevices).not.toHaveBeenCalled();
    expect(mockSetBiometricLockEnabled).toHaveBeenCalledWith(false);
    // The disarm is committed first; the network never gets to hold it.
    expect(
      mockSetBiometricLockEnabled.mock.invocationCallOrder[0],
    ).toBeLessThan(mockListTrustedDevices.mock.invocationCallOrder[0]!);
    expect(lockSwitch().props.accessibilityState?.checked).toBe(false);
    // The Remembered devices card on this same screen re-reads the server.
    await waitFor(() => {
      expect(
        queryHarness.__getQueryClientForTests().invalidateQueries,
      ).toHaveBeenCalledWith({ queryKey: [TRUSTED_DEVICES_QUERY_KEY] });
    });
    expect(warnings()).toEqual([]);
  });

  it("leaves the trust record alone when the challenge is refused", async () => {
    mockAuthenticate.mockResolvedValue(false);
    await renderWithLockOn();

    await turnLockOff();
    await flush();

    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
    expect(mockListTrustedDevices).not.toHaveBeenCalled();
    expect(mockRevokeTrustedDevice).not.toHaveBeenCalled();
    expect(lockSwitch().props.accessibilityState?.checked).toBe(true);
  });

  it("keeps the lock off and warns when the trust record cannot be retired", async () => {
    mockAuthenticate.mockResolvedValue(true);
    mockSetBiometricLockEnabled.mockResolvedValue(undefined);
    mockRevokeTrustedDevice.mockResolvedValue({
      error: { status: 500, kind: "http", message: "boom" },
    });
    await renderWithLockOn();

    await turnLockOff();

    await waitFor(() => {
      expect(warnings()).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(
            /still sign in without a two-factor code/,
          ),
        }),
      ]);
    });
    // The owner passed the challenge and the preference is committed OFF. A
    // failed revoke must neither flip the switch back nor claim the lock was
    // "not changed" — both would contradict what is stored.
    expect(mockSetBiometricLockEnabled).toHaveBeenCalledWith(false);
    expect(lockSwitch().props.accessibilityState?.checked).toBe(false);
    expect(mockToasts.filter((entry) => entry.kind === "error")).toEqual([]);
  });

  it("does not reach for trust records under an API key, which has none", async () => {
    authHarness.__setAuthStateForTests({ mode: "api_key" });
    mockAuthenticate.mockResolvedValue(true);
    mockSetBiometricLockEnabled.mockResolvedValue(undefined);
    await renderWithLockOn();

    await turnLockOff();
    await flush();

    expect(mockSetBiometricLockEnabled).toHaveBeenCalledWith(false);
    expect(lockSwitch().props.accessibilityState?.checked).toBe(false);
    // The trusted-device routes are session-only; asking would 401 and put a
    // false "can still sign in" warning in front of the user.
    expect(mockListTrustedDevices).not.toHaveBeenCalled();
    expect(mockRevokeTrustedDevice).not.toHaveBeenCalled();
    expect(warnings()).toEqual([]);
  });
});
