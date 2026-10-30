import type { PersistedClient } from "@tanstack/query-persist-client-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  disk: new Map<string, string>(),
  plaintextByEnvelope: new Map<string, string>(),
  envelopeCounter: 0,
}));

const idb = vi.hoisted(() => {
  const store = { name: "desktop-query-store" };
  return {
    store,
    createStore: vi.fn(() => store),
    get: vi.fn(async (key: string) => state.disk.get(key)),
    set: vi.fn(async (key: string, value: string) => {
      state.disk.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      state.disk.delete(key);
    }),
  };
});

vi.mock("idb-keyval", () => idb);

vi.mock("../../lib/api-client", () => ({
  getRememberedSession: () => null,
}));

vi.mock("../../lib/offline-store", () => ({
  getOfflineIdentity: () => null,
}));

vi.mock("../../lib/online-manager", () => ({
  getOnlineStatus: () => "online",
}));

vi.mock("../../lib/outbox", () => ({
  installOutboxMutationDefaults: vi.fn(),
}));

vi.mock("../../lib/secure-vault", () => ({
  vaultCommitEncryptedString: vi.fn(
    async (plaintext: string, commit: (envelope: string) => Promise<void>) => {
      const envelope = JSON.stringify({
        alg: "AES-GCM",
        iv: "test-iv",
        data: `ciphertext-${state.envelopeCounter++}`,
      });
      state.plaintextByEnvelope.set(envelope, plaintext);
      await commit(envelope);
    },
  ),
  vaultDecryptString: vi.fn(
    async (envelope: string) => state.plaintextByEnvelope.get(envelope) ?? null,
  ),
}));

import { idbPersister } from "../../lib/query-client";

const CACHE_KEY = "tanstack-query-cache";

beforeEach(async () => {
  await idbPersister.removeClient();
  state.disk.clear();
  state.plaintextByEnvelope.clear();
  state.envelopeCounter = 0;
  vi.clearAllMocks();
});

describe("desktop query-cache storage boundary", () => {
  it("persists customer snapshots only inside an AES-GCM envelope", async () => {
    const secret = "private-person@example.com";
    const client = {
      timestamp: Date.now(),
      buster: "test:user-a:tenant-a",
      clientState: {
        mutations: [],
        queries: [{ state: { data: { email: secret } } }],
      },
    } as unknown as PersistedClient;

    await idbPersister.persistClient(client);

    const diskValue = state.disk.get(CACHE_KEY);
    expect(diskValue).toBeTruthy();
    expect(diskValue).not.toContain(secret);
    expect(JSON.parse(diskValue ?? "{}")).toMatchObject({ alg: "AES-GCM" });
    await expect(idbPersister.restoreClient()).resolves.toEqual(client);
  });

  it("deletes a legacy plaintext IndexedDB snapshot instead of trusting it", async () => {
    state.disk.set(
      CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        buster: "legacy",
        clientState: { queries: [{ email: "legacy@example.com" }] },
      }),
    );

    await expect(idbPersister.restoreClient()).resolves.toBeUndefined();
    expect(state.disk.has(CACHE_KEY)).toBe(false);
    expect(idb.del).toHaveBeenCalledWith(CACHE_KEY, idb.store);
  });

  it("retains valid ciphertext through a temporary keychain read failure", async () => {
    const envelope = JSON.stringify({
      alg: "AES-GCM",
      iv: "valid-iv",
      data: "valid-ciphertext",
    });
    state.disk.set(CACHE_KEY, envelope);

    await expect(idbPersister.restoreClient()).resolves.toBeUndefined();
    expect(state.disk.get(CACHE_KEY)).toBe(envelope);
    expect(idb.del).not.toHaveBeenCalled();
  });
});
