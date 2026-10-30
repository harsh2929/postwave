import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  vaultDecryptString,
  vaultEncryptString,
  vaultGetJSON,
  vaultPurgeAll,
  vaultReadJSON,
  vaultSetJSON,
} from "../../lib/secure-vault";

describe("desktop secure vault", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal("window", {
      localStorage,
      crypto: globalThis.crypto,
    });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("round-trips JSON without storing plaintext", async () => {
    await vaultSetJSON("subscriber:sub_1", {
      email: "reader@example.com",
      tags: ["vip"],
    });

    const raw = storage.get("postwave.desktop.vault.v1:subscriber:sub_1");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("reader@example.com");
    await expect(vaultGetJSON("subscriber:sub_1")).resolves.toEqual({
      email: "reader@example.com",
      tags: ["vip"],
    });
  });

  it("rejects oversized vault items before writing them", async () => {
    await expect(
      vaultSetJSON("huge", { value: "x".repeat(600 * 1024) }),
    ).rejects.toThrow("too large");
    expect(storage.has("postwave.desktop.vault.v1:huge")).toBe(false);
  });

  it("rejects invalid local vault keys before touching storage", async () => {
    await expect(
      vaultSetJSON("../subscriber\nsecret", { email: "reader@example.com" }),
    ).rejects.toThrow(/vault key/i);
    await expect(
      vaultSetJSON(`${"subscriber".repeat(30)}`, {
        email: "reader@example.com",
      }),
    ).rejects.toThrow(/vault key/i);
    await expect(vaultGetJSON("../subscriber\nsecret")).resolves.toBeNull();
    expect(storage.size).toBe(0);
  });

  it("removes corrupt vault entries on read", async () => {
    storage.set("postwave.desktop.vault.v1:bad", "{not-json");

    await expect(vaultGetJSON("bad")).resolves.toBeNull();
    expect(storage.has("postwave.desktop.vault.v1:bad")).toBe(false);
  });

  it("can retain corrupt ciphertext until an idempotency owner records quarantine", async () => {
    storage.set("postwave.desktop.vault.v1:recovery", "{not-json");

    await expect(
      vaultReadJSON("recovery", { preserveCorrupt: true }),
    ).resolves.toEqual({ status: "corrupt" });
    expect(storage.has("postwave.desktop.vault.v1:recovery")).toBe(true);
  });

  it("does not silently fall back to plaintext when WebCrypto is unavailable", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
      crypto: undefined,
    });

    await expect(
      vaultSetJSON("subscriber:sub_2", { email: "x@test" }),
    ).rejects.toThrow(/unavailable/i);
    expect(storage.has("postwave.desktop.vault.v1:subscriber:sub_2")).toBe(
      false,
    );
  });

  it("keeps ciphertext and does not re-key when keychain access fails", async () => {
    // Fresh module instance so no in-memory vault key is cached.
    vi.resetModules();
    const openVaultString = vi
      .fn()
      .mockRejectedValue(new Error("keychain locked"));
    const sealVaultString = vi.fn();
    vi.doMock("../../lib/tauri", () => ({
      isTauri: () => true,
      tauriApi: { openVaultString, sealVaultString },
    }));
    const mod = await import("../../lib/secure-vault");

    storage.set(
      "postwave.desktop.vault.v1:item",
      JSON.stringify({
        alg: "AES-GCM",
        iv: "AAAAAAAAAAAAAAAA",
        data: "AAAAAAAA",
      }),
    );

    await expect(mod.vaultGetJSON("item")).resolves.toBeNull();
    // Transient keychain failure: the (possibly fine) ciphertext stays,
    // and no replacement key is minted/stored.
    expect(storage.has("postwave.desktop.vault.v1:item")).toBe(true);
    expect(sealVaultString).not.toHaveBeenCalled();

    vi.doUnmock("../../lib/tauri");
  });

  it("purges every vault item and deletes the key secret on sign-out (D02#4)", async () => {
    vi.resetModules();
    const sealVaultString = vi.fn(async () =>
      JSON.stringify({ alg: "AES-GCM", iv: "native", data: "ciphertext" }),
    );
    const purgeVaultKey = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../lib/tauri", () => ({
      isTauri: () => true,
      tauriApi: { sealVaultString, purgeVaultKey },
    }));
    const mod = await import("../../lib/secure-vault");

    await mod.vaultSetJSON("sensitive:user:a:/api/v1/subscribers/s1", {
      pii: 1,
    });
    await mod.vaultSetJSON("sensitive:user:a:/api/v1/audit", { pii: 2 });
    // A non-vault localStorage key must survive the purge.
    storage.set("postwave.desktop.unrelated", "keep-me");

    await mod.vaultPurgeAll();

    const vaultKeysLeft = Array.from(storage.keys()).filter((k) =>
      k.startsWith("postwave.desktop.vault.v1:"),
    );
    expect(vaultKeysLeft).toHaveLength(0);
    expect(storage.get("postwave.desktop.unrelated")).toBe("keep-me");
    expect(purgeVaultKey).toHaveBeenCalledTimes(1);

    vi.doUnmock("../../lib/tauri");
  });

  it("drains and fences an in-flight native write before purging the key", async () => {
    vi.resetModules();
    let finishSeal!: (envelope: string) => void;
    const sealVaultString = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishSeal = resolve;
        }),
    );
    const purgeVaultKey = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../lib/tauri", () => ({
      isTauri: () => true,
      tauriApi: { sealVaultString, purgeVaultKey },
    }));
    const mod = await import("../../lib/secure-vault");

    const write = mod.vaultSetJSON("webhook-fixtures:user-a", {
      payload: "private-person@example.com",
    });
    const rejectedWrite = expect(write).rejects.toThrow(/sign-out/u);
    await vi.waitFor(() => expect(sealVaultString).toHaveBeenCalledOnce());

    const purge = mod.vaultPurgeAll();
    expect(purgeVaultKey).not.toHaveBeenCalled();

    finishSeal(
      JSON.stringify({ alg: "AES-GCM", iv: "native", data: "ciphertext" }),
    );
    await rejectedWrite;
    await purge;

    expect(purgeVaultKey).toHaveBeenCalledOnce();
    expect(
      storage.has("postwave.desktop.vault.v1:webhook-fixtures:user-a"),
    ).toBe(false);
    await expect(
      mod.vaultSetJSON("webhook-fixtures:user-a", { payload: "late" }),
    ).rejects.toThrow(/sign-out/u);
    expect(sealVaultString).toHaveBeenCalledTimes(1);

    vi.doUnmock("../../lib/tauri");
  });

  it("exports vaultPurgeAll", () => {
    expect(typeof vaultPurgeAll).toBe("function");
  });

  it("round-trips arbitrary strings as ciphertext for the query cache (D02#3)", async () => {
    const plain = JSON.stringify({
      queries: [{ email: "reader@example.com" }],
    });
    const envelope = await vaultEncryptString(plain);
    expect(envelope).not.toContain("reader@example.com");
    expect(JSON.parse(envelope)).toMatchObject({ alg: "AES-GCM" });
    await expect(vaultDecryptString(envelope)).resolves.toBe(plain);
  });

  it("treats a legacy plaintext cache blob as a decrypt miss (D02#3)", async () => {
    // A pre-D02#3 persisted cache is raw JSON, not an AES envelope — it
    // must never be trusted as plaintext; decrypt returns null → refetch.
    await expect(
      vaultDecryptString('{"clientState":{"queries":[]}}'),
    ).resolves.toBeNull();
    await expect(vaultDecryptString("not json at all")).resolves.toBeNull();
  });

  it("delegates concurrent native encryption without exposing a key", async () => {
    vi.resetModules();
    const plaintextByEnvelope = new Map<string, string>();
    const sealVaultString = vi.fn(async (plaintext: string) => {
      const envelope = JSON.stringify({
        alg: "AES-GCM",
        iv: "native",
        data: `ciphertext-${plaintextByEnvelope.size}`,
      });
      plaintextByEnvelope.set(envelope, plaintext);
      return envelope;
    });
    const openVaultString = vi.fn(
      async (envelope: string) => plaintextByEnvelope.get(envelope) ?? null,
    );
    vi.doMock("../../lib/tauri", () => ({
      isTauri: () => true,
      tauriApi: { sealVaultString, openVaultString },
    }));
    const mod = await import("../../lib/secure-vault");

    await Promise.all([
      mod.vaultSetJSON("a", { v: 1 }),
      mod.vaultSetJSON("b", { v: 2 }),
    ]);

    expect(sealVaultString).toHaveBeenCalledTimes(2);
    await expect(mod.vaultGetJSON("a")).resolves.toEqual({ v: 1 });
    await expect(mod.vaultGetJSON("b")).resolves.toEqual({ v: 2 });

    vi.doUnmock("../../lib/tauri");
  });
});
