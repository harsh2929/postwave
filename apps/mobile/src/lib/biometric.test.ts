/**
 * Unit tests for lib/biometric.ts — the no-throw availability check, the
 * authenticate() wrapper, and the SecureStore-backed lock preference.
 *
 * expo-local-authentication + expo-secure-store are native modules, so we
 * mock them. The mocks model the real semantics we care about:
 *   - availability = hasHardware AND isEnrolled
 *   - authenticate maps a {success} result to a boolean
 *   - the pref persists "1" / is deleted, and reads default to false
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let failSecureWrite = false;

const hasHardwareAsync = vi.fn(async () => true);
const isEnrolledAsync = vi.fn(async () => true);
const authenticateAsync = vi.fn(async (_options?: unknown) => {
  return { success: true } as unknown;
});
const getEnrolledLevelAsync = vi.fn(async () => 3 as number); // BIOMETRIC_STRONG

vi.mock("expo-local-authentication", () => ({
  hasHardwareAsync: () => hasHardwareAsync(),
  isEnrolledAsync: () => isEnrolledAsync(),
  authenticateAsync: (options: unknown) => authenticateAsync(options),
  getEnrolledLevelAsync: () => getEnrolledLevelAsync(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (failSecureWrite) throw new Error("secure write failed");
    store.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (failSecureWrite) throw new Error("secure write failed");
    store.delete(key);
  }),
}));

// eslint-disable-next-line import/first
import {
  authenticate,
  canAuthenticate,
  getBiometricLockEnabled,
  isBiometricAvailable,
  requireDeviceAuth,
  setBiometricLockEnabled,
  subscribeBiometricLockPreference,
} from "./biometric";

beforeEach(() => {
  store.clear();
  failSecureWrite = false;
  hasHardwareAsync.mockReset().mockResolvedValue(true);
  isEnrolledAsync.mockReset().mockResolvedValue(true);
  authenticateAsync.mockReset().mockResolvedValue({ success: true });
  getEnrolledLevelAsync.mockReset().mockResolvedValue(3);
});

describe("canAuthenticate", () => {
  it("true when a biometric is enrolled (BIOMETRIC_STRONG)", async () => {
    getEnrolledLevelAsync.mockResolvedValue(3);
    await expect(canAuthenticate()).resolves.toBe(true);
  });

  it("true when only a device passcode is set (SECRET) — lock must not fail open", async () => {
    getEnrolledLevelAsync.mockResolvedValue(1);
    await expect(canAuthenticate()).resolves.toBe(true);
  });

  it("false when no credential at all (NONE)", async () => {
    getEnrolledLevelAsync.mockResolvedValue(0);
    await expect(canAuthenticate()).resolves.toBe(false);
  });

  it("false when the native call throws", async () => {
    getEnrolledLevelAsync.mockRejectedValue(new Error("native"));
    await expect(canAuthenticate()).resolves.toBe(false);
  });
});

describe("isBiometricAvailable", () => {
  it("true only when hardware present AND enrolled", async () => {
    await expect(isBiometricAvailable()).resolves.toBe(true);
  });

  it("false when hardware is missing", async () => {
    hasHardwareAsync.mockResolvedValue(false);
    await expect(isBiometricAvailable()).resolves.toBe(false);
  });

  it("false when nothing is enrolled", async () => {
    isEnrolledAsync.mockResolvedValue(false);
    await expect(isBiometricAvailable()).resolves.toBe(false);
  });

  it("false (no throw) when the native module rejects", async () => {
    hasHardwareAsync.mockRejectedValue(new Error("native boom"));
    await expect(isBiometricAvailable()).resolves.toBe(false);
  });
});

describe("authenticate", () => {
  it("true on a successful prompt", async () => {
    await expect(authenticate("Unlock")).resolves.toBe(true);
    expect(authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        biometricsSecurityLevel: "strong",
        disableDeviceFallback: false,
      }),
    );
  });

  it("false when the user cancels / fails", async () => {
    authenticateAsync.mockResolvedValue({
      success: false,
      error: "user_cancel",
    });
    await expect(authenticate("Unlock")).resolves.toBe(false);
  });

  it("false (no throw) when the prompt rejects", async () => {
    authenticateAsync.mockRejectedValue(new Error("no context"));
    await expect(authenticate("Unlock")).resolves.toBe(false);
  });
});

describe("requireDeviceAuth", () => {
  it("prompts before a high-value action when the device has a credential", async () => {
    getEnrolledLevelAsync.mockResolvedValue(3);
    authenticateAsync.mockResolvedValue({ success: true });
    await expect(requireDeviceAuth("Confirm to authorize")).resolves.toBe(true);
    expect(authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it("blocks the action when the user cancels the prompt", async () => {
    getEnrolledLevelAsync.mockResolvedValue(3);
    authenticateAsync.mockResolvedValue({ success: false });
    await expect(requireDeviceAuth("Confirm to authorize")).resolves.toBe(false);
  });

  it("fails OPEN on a device with no enrolled credential at all", async () => {
    // Hard-requiring here would make the action permanently impossible on a
    // passcode-less device rather than more secure.
    getEnrolledLevelAsync.mockResolvedValue(0);
    await expect(requireDeviceAuth("Confirm to authorize")).resolves.toBe(true);
    expect(authenticateAsync).not.toHaveBeenCalled();
  });
});

describe("biometric lock preference", () => {
  it("defaults to false when unset", async () => {
    await expect(getBiometricLockEnabled()).resolves.toBe(false);
  });

  it("round-trips enabled → reads true", async () => {
    await setBiometricLockEnabled(true);
    await expect(getBiometricLockEnabled()).resolves.toBe(true);
  });

  it("disabling deletes the key → reads false", async () => {
    await setBiometricLockEnabled(true);
    await setBiometricLockEnabled(false);
    await expect(getBiometricLockEnabled()).resolves.toBe(false);
    // The stored value is removed, not just falsified.
    const leftover = Array.from(store.keys()).filter((k) =>
      k.includes("biometric"),
    );
    expect(leftover).toEqual([]);
  });

  it('treats any non-"1" stored value as disabled', async () => {
    store.set("postwave.mobile.biometric.lock", "true");
    await expect(getBiometricLockEnabled()).resolves.toBe(false);
  });

  it("notifies the mounted gate only after a committed preference change", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBiometricLockPreference(listener);
    await setBiometricLockEnabled(true);
    expect(listener).toHaveBeenCalledWith(true);

    failSecureWrite = true;
    await expect(setBiometricLockEnabled(false)).rejects.toThrow(
      "secure write failed",
    );
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(getBiometricLockEnabled()).resolves.toBe(true);
    unsubscribe();
  });
});
