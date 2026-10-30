import { beforeEach, describe, expect, it, vi } from "vitest";
import * as SecureStore from "expo-secure-store";

import {
  MAGIC_LINK_STATE_TTL_MS,
  PASSWORD_RESET_STATE_TTL_MS,
  clearPendingMagicLinkState,
  clearPendingPasswordResetState,
  createPendingMagicLinkState,
  createPendingPasswordResetState,
  magicLinkEmailMatches,
  resolvePendingMagicLinkState,
  resolvePendingPasswordResetState,
  safeMagicLinkState,
  verifyPendingMagicLinkState,
} from "./magicLinkState";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

describe("magic-link pending state", () => {
  let stored: string | null;

  beforeEach(() => {
    stored = null;
    vi.clearAllMocks();
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        array.forEach((_, i) => {
          array[i] = i + 1;
        });
        return array;
      },
    });
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async () => stored);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (_key, value) => {
      stored = value;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      stored = null;
    });
  });

  it("creates a bounded random state with normalized email and base URL", async () => {
    const pending = await createPendingMagicLinkState({
      email: " Owner@Example.COM ",
      baseUrl: "https://api.moosewave.com/",
      now: 1_000,
    });

    expect(pending).toEqual({
      version: 1,
      flow: "magic",
      audience: "mobile",
      state: "0102030405060708090a0b0c0d0e0f10",
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com",
      expiresAt: 1_000 + MAGIC_LINK_STATE_TTL_MS,
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
  });

  it("verifies exact state and normalized base URL before consumption", async () => {
    const pending = await createPendingMagicLinkState({
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com/",
      now: 1_000,
    });

    await expect(
      verifyPendingMagicLinkState({
        state: pending.state,
        baseUrl: "https://api.moosewave.com",
        now: 2_000,
      }),
    ).resolves.toEqual({ ok: true, pending });
    expect(magicLinkEmailMatches(pending, "OWNER@example.com")).toBe(true);
  });

  it("clears expired state but retains a valid request after an unsolicited mismatch", async () => {
    const pending = await createPendingMagicLinkState({
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com",
      now: 1_000,
    });

    await expect(
      verifyPendingMagicLinkState({
        state: pending.state,
        baseUrl: "https://api.moosewave.com",
        now: 1_000 + MAGIC_LINK_STATE_TTL_MS + 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    expect(stored).toBeNull();

    await createPendingMagicLinkState({
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com",
      now: 1_000,
    });
    await expect(
      verifyPendingMagicLinkState({
        state: "wrong",
        baseUrl: "https://api.moosewave.com",
        now: 2_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "state_mismatch" });
    expect(stored).not.toBeNull();
    await expect(
      resolvePendingMagicLinkState({
        state: "0102030405060708090a0b0c0d0e0f10",
        now: 2_000,
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects unsafe state params", async () => {
    expect(safeMagicLinkState(null)).toBeNull();
    expect(safeMagicLinkState(" nonce")).toBeNull();
    expect(safeMagicLinkState("a".repeat(300))).toBeNull();
    expect(safeMagicLinkState("abc\n")).toBeNull();
    expect(safeMagicLinkState("nonce")).toBe("nonce");

    await clearPendingMagicLinkState();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalled();
  });

  it("retries transient SecureStore writes and deletes", async () => {
    vi.mocked(SecureStore.setItemAsync)
      .mockRejectedValueOnce(new Error("keychain busy"))
      .mockImplementationOnce(async (_key, value) => {
        stored = value;
      });
    const pending = await createPendingMagicLinkState({
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com",
      now: 1_000,
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(2);

    vi.mocked(SecureStore.deleteItemAsync)
      .mockRejectedValueOnce(new Error("keychain busy"))
      .mockImplementationOnce(async () => {
        stored = null;
      });
    await expect(
      verifyPendingMagicLinkState({
        state: pending.state,
        baseUrl: pending.baseUrl,
        now: 1_000 + MAGIC_LINK_STATE_TTL_MS + 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
  });

  it("returns bounded storage errors instead of leaking or throwing", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(
      new Error("owner@example.com private keychain detail"),
    );

    await expect(
      verifyPendingMagicLinkState({
        state: "safe-state",
        baseUrl: "https://api.moosewave.com",
      }),
    ).resolves.toEqual({ ok: false, reason: "storage_unavailable" });
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it("fails closed when expired state cannot be purged", async () => {
    await createPendingMagicLinkState({
      email: "owner@example.com",
      baseUrl: "https://api.moosewave.com",
      now: 1_000,
    });
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(
      new Error("keychain busy"),
    );

    await expect(
      verifyPendingMagicLinkState({
        state: "0102030405060708090a0b0c0d0e0f10",
        baseUrl: "https://api.moosewave.com",
        now: 1_000 + MAGIC_LINK_STATE_TTL_MS + 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "cleanup_failed" });
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
  });

  it("binds password reset to an arbitrary locally selected self-hosted HTTPS origin", async () => {
    const pending = await createPendingPasswordResetState({
      email: "Owner@Example.com",
      baseUrl: "https://mail.example.net/postwave/",
      now: 5_000,
    });

    expect(pending).toMatchObject({
      version: 1,
      flow: "reset",
      audience: "mobile",
      email: "owner@example.com",
      baseUrl: "https://mail.example.net/postwave",
      expiresAt: 5_000 + PASSWORD_RESET_STATE_TTL_MS,
    });
    await expect(
      resolvePendingPasswordResetState({
        state: pending.state,
        now: 6_000,
      }),
    ).resolves.toEqual({ ok: true, pending });

    await clearPendingPasswordResetState();
    expect(stored).toBeNull();
  });
});
