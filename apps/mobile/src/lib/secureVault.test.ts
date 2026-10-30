import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  data: new Map<string, string>(),
  failSetIncludes: null as string | null,
  failDeleteKey: null as string | null,
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (state.failSetIncludes && key.includes(state.failSetIncludes)) {
      throw new Error("set failed");
    }
    state.data.set(key, value);
  }),
  getItemAsync: vi.fn(async (key: string) => state.data.get(key) ?? null),
  deleteItemAsync: vi.fn(async (key: string) => {
    if (state.failDeleteKey === key) throw new Error("delete failed");
    state.data.delete(key);
  }),
}));

// eslint-disable-next-line import/first
import {
  vaultClear,
  vaultGetJSON,
  vaultRecoverPendingCleanup,
  vaultScopeForClient,
  vaultSetJSON,
} from "./secureVault";

const scopeA = vaultScopeForClient({
  baseUrl: "https://api.moosewave.com/",
  tenantId: "tenant-a",
  userId: "user-a",
  role: "Editor",
});
const scopeB = vaultScopeForClient({
  baseUrl: "https://api.moosewave.com",
  tenantId: "tenant-a",
  userId: "user-b",
  role: "viewer",
});

describe("mobile secureVault", () => {
  beforeEach(() => {
    state.data.clear();
    state.failSetIncludes = null;
    state.failDeleteKey = null;
  });

  it("round-trips only within the same origin+tenant+user+role scope", async () => {
    await vaultSetJSON(
      "subscriber",
      "sub_1",
      { email: "reader@example.com" },
      { scope: scopeA },
    );

    await expect(
      vaultGetJSON("subscriber", "sub_1", { scope: scopeA }),
    ).resolves.toEqual({ email: "reader@example.com" });
    await expect(
      vaultGetJSON("subscriber", "sub_1", { scope: scopeB }),
    ).resolves.toBeNull();
  });

  it("normalizes the API origin but changes scope for user or effective role", () => {
    expect(
      vaultScopeForClient({
        baseUrl: "https://api.moosewave.com",
        tenantId: "tenant-a",
        userId: "user-a",
        role: "editor",
      }),
    ).toBe(scopeA);
    expect(scopeB).not.toBe(scopeA);
    expect(
      vaultScopeForClient({
        baseUrl: "https://api.moosewave.com",
        tenantId: "tenant-a",
        userId: "user-a",
        role: "viewer",
      }),
    ).not.toBe(scopeA);
  });

  it("vaultClear wipes current and legacy manifest entries", async () => {
    await vaultSetJSON(
      "audit",
      "evt_1",
      { action: "export" },
      { scope: scopeA },
    );
    const legacyKey = "postwave.mobile.vault.v2.audit.old";
    state.data.set(legacyKey, "legacy");
    state.data.set(
      "postwave.mobile.vault.v2.__manifest",
      JSON.stringify([legacyKey]),
    );

    await vaultClear();

    expect(
      [...state.data.keys()].filter((key) =>
        key.startsWith("postwave.mobile.vault"),
      ),
    ).toEqual([]);
  });

  it("registers a tombstone before payload writes so failures stay purgeable", async () => {
    state.failSetIncludes = ".subscriber.";

    await expect(
      vaultSetJSON(
        "subscriber",
        "sub_1",
        { email: "reader@example.com" },
        { scope: scopeA },
      ),
    ).rejects.toThrow("set failed");

    const manifest = state.data.get("postwave.mobile.vault.v3.__manifest");
    expect(manifest).toContain("subscriber");
    state.failSetIncludes = null;
    await vaultClear();
    expect(state.data.size).toBe(0);
  });

  it("does not write a payload when the manifest cannot be committed", async () => {
    state.failSetIncludes = ".__manifest";

    await expect(
      vaultSetJSON("audit", "evt_1", { secret: "value" }, { scope: scopeA }),
    ).rejects.toThrow("set failed");

    expect([...state.data.keys()].some((key) => key.includes(".audit."))).toBe(
      false,
    );
  });

  it("retains failed cleanup keys and retries from a durable marker", async () => {
    await vaultSetJSON(
      "suppression",
      "s_1",
      { email: "blocked@example.com" },
      { scope: scopeA },
    );
    const entryKey = [...state.data.keys()].find((key) =>
      key.includes(".suppression."),
    );
    expect(entryKey).toBeDefined();
    state.failDeleteKey = entryKey ?? null;

    await expect(vaultClear()).rejects.toThrow(/incomplete/i);
    expect(state.data.has("postwave.mobile.vault.v3.__cleanup_pending")).toBe(
      true,
    );
    expect(state.data.get("postwave.mobile.vault.v3.__manifest")).toContain(
      entryKey,
    );

    state.failDeleteKey = null;
    await expect(vaultRecoverPendingCleanup()).resolves.toBe(true);
    expect(state.data.size).toBe(0);
  });

  it("rejects a poisoned manifest instead of deleting unrelated secrets", async () => {
    state.data.set("postwave.api_key", "pw_secret");
    state.data.set(
      "postwave.mobile.vault.v3.__manifest",
      JSON.stringify({ version: 3, keys: ["postwave.api_key"] }),
    );

    await expect(vaultClear()).rejects.toThrow(/incomplete/i);
    expect(state.data.get("postwave.api_key")).toBe("pw_secret");
  });

  it("does not store oversized or multi-byte oversized payloads", async () => {
    await vaultSetJSON(
      "audit",
      "large",
      { blob: "x".repeat(30_000) },
      {
        scope: scopeA,
      },
    );
    await vaultSetJSON(
      "audit",
      "unicode",
      { blob: "😊".repeat(7_000) },
      {
        scope: scopeA,
      },
    );

    await expect(
      vaultGetJSON("audit", "large", { scope: scopeA }),
    ).resolves.toBeNull();
    await expect(
      vaultGetJSON("audit", "unicode", { scope: scopeA }),
    ).resolves.toBeNull();
  });

  it("removes corrupt or expired entries and their manifest references", async () => {
    await vaultSetJSON("audit", "bad", { action: "ok" }, { scope: scopeA });
    const entryKey = [...state.data.keys()].find((key) =>
      key.includes(".audit."),
    );
    expect(entryKey).toBeDefined();
    if (!entryKey) return;
    state.data.set(entryKey, "{bad-json");

    await expect(
      vaultGetJSON("audit", "bad", { scope: scopeA }),
    ).resolves.toBeNull();
    expect(state.data.has(entryKey)).toBe(false);
    expect(
      state.data.get("postwave.mobile.vault.v3.__manifest") ?? "",
    ).not.toContain(entryKey);
  });

  it("bounds and sanitizes SecureStore keys", async () => {
    const longId = "sub/" + "x".repeat(400);
    await vaultSetJSON(
      "subscriber",
      longId,
      { email: "reader@example.com" },
      { scope: scopeA },
    );

    const key = [...state.data.keys()].find((candidate) =>
      candidate.includes(".subscriber."),
    );
    expect(key?.length).toBeLessThan(900);
    await expect(
      vaultGetJSON("subscriber", longId, { scope: scopeA }),
    ).resolves.toEqual({ email: "reader@example.com" });
  });
});
