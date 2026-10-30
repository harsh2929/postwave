/**
 * Every vault key must be one SecureStore will actually accept.
 *
 * This was a one-character bug with a whole-app consequence. `safeVaultId`
 * permitted ":" in its character class, and every scope is built from the API
 * origin — which always contains "://". So every scoped key came out as
 * `postwave.mobile.vault.v3.__https:__api.example.com__…`, expo-secure-store
 * rejected it ("Invalid key provided to SecureStore"), and two things followed:
 * the offline vault silently stored nothing, and `vaultClear` could never
 * delete the keys the manifest had already recorded. That permanent cleanup
 * failure sets the cleanup-pending marker, and that marker DISABLES SIGN-IN.
 *
 * Found by driving the real app: after one sign-out the simulator showed
 * "secure local cleanup is incomplete: vault" with both sign-in buttons
 * disabled and no recovery short of erasing the device.
 *
 * THE MOCK VALIDATES LIKE THE REAL LIBRARY. Asserting on a key this test
 * sanitises itself would prove nothing about the sanitiser in the module —
 * so the fake SecureStore below rejects invalid keys exactly as
 * expo-secure-store does, and the test drives the real write path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** expo-secure-store's own isValidKey, verbatim (SecureStore.ts:237). */
const LIBRARY_RULE = /^[\w.-]+$/;
const store = new Map<string, string>();
const rejectedKeys: string[] = [];

function assertValidKey(key: string): void {
  if (!LIBRARY_RULE.test(key)) {
    rejectedKeys.push(key);
    throw new Error(
      'Invalid key provided to SecureStore. Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".',
    );
  }
}

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => {
    assertValidKey(key);
    return store.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    assertValidKey(key);
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    assertValidKey(key);
    store.delete(key);
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
}));

// eslint-disable-next-line import/first
import { vaultClear, vaultScopeForClient, vaultSetJSON } from "./secureVault";

const HTTPS_SCOPE = vaultScopeForClient({
  baseUrl: "https://api.moosewave.com",
  tenantId: "t_9f3c",
  userId: "u_71a2",
  role: "owner",
});
const LOCAL_SCOPE = vaultScopeForClient({
  baseUrl: "http://127.0.0.1:4010",
  tenantId: "t_demo",
  userId: "u_demo",
  role: "owner",
});

beforeEach(() => {
  store.clear();
  rejectedKeys.length = 0;
});

describe("scoped vault writes reach SecureStore at all", () => {
  it("stores against a real https workspace origin", async () => {
    await vaultSetJSON("dashboard", "stats-30d", { total: 1 }, { scope: HTTPS_SCOPE });
    expect(rejectedKeys, `SecureStore refused: ${rejectedKeys[0]}`).toEqual([]);
    // Something was actually written — a silently-skipped write would also
    // leave rejectedKeys empty.
    expect([...store.keys()].some((k) => k.includes("dashboard"))).toBe(true);
  });

  it("stores against a plaintext localhost dev origin (two colons)", async () => {
    await vaultSetJSON("audit", "latest-6", { rows: [] }, { scope: LOCAL_SCOPE });
    expect(rejectedKeys, `SecureStore refused: ${rejectedKeys[0]}`).toEqual([]);
  });

  it("clears without leaving the app latched", async () => {
    // The consequence that matters: vaultClear must resolve, because a
    // rejection here is what sets the cleanup marker that disables sign-in.
    await vaultSetJSON("dashboard", "stats-30d", { total: 1 }, { scope: HTTPS_SCOPE });
    await expect(vaultClear()).resolves.toBeUndefined();
    expect(rejectedKeys).toEqual([]);
  });

  it("repairs a manifest that already holds an unstorable key", async () => {
    // Installs written by the old sanitiser recorded colon-bearing keys. Those
    // can never be deleted, so retrying them forever kept the marker set —
    // they must be dropped instead, or an existing install stays latched.
    const legacy = "postwave.mobile.vault.v3.__https:__api.moosewave.com__.dashboard.stats";
    store.set("postwave.mobile.vault.v3.__manifest", JSON.stringify([legacy]));
    await expect(vaultClear()).resolves.toBeUndefined();
  });
});
