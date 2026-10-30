import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupOfflineStorage,
  clearOfflineStores,
  enqueueOfflineMutation,
  getOfflineIdentity,
  getOfflinePersistenceError,
  hydrateOfflineStores,
  isOfflineCacheableGet,
  isQueueableMutation,
  offlineQueueIdle,
  parkOfflineStores,
  readCachedResponse,
  readOfflineQueue,
  setOfflineIdentity,
  writeCachedResponse,
  writeOfflineQueue,
  type OfflineMutation,
} from "../../lib/offline-store";
import { vaultSetJSON } from "../../lib/secure-vault";
import * as secureVault from "../../lib/secure-vault";

const TEST_NOW = new Date("2026-07-14T08:00:00.000Z");
const IDENTITY_SOURCE = "user-a:tenant-a";
let identity = "";
let outboxStorageKey = "";
let legacyOutboxStorageKey = "";
let cacheStorageKey = "";

describe("desktop encrypted offline-store", () => {
  const storage = new Map<string, string>();

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
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
      crypto: webcrypto as unknown as Crypto,
    });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal("navigator", {});
    await clearOfflineStores();
    storage.clear();
    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();
    identity = getOfflineIdentity() ?? "";
    outboxStorageKey = `postwave.desktop.vault.v1:offline-outbox.v3:${identity}`;
    legacyOutboxStorageKey = `postwave.desktop.vault.v1:offline-outbox.v2:${identity}`;
    cacheStorageKey = `postwave.desktop.vault.v1:offline-cache.v2:${identity}`;
  });

  afterEach(async () => {
    await clearOfflineStores();
    await offlineQueueIdle();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("durably admits only bounded low-risk edits and strips credential headers", async () => {
    expect(
      isQueueableMutation("PATCH", "/api/v1/forms/form_1", {
        name: "Newsletter signup",
      }),
    ).toBe(true);
    expect(
      isQueueableMutation("PATCH", "/api/v1/campaigns/cmp_1", {
        status: "scheduled",
      }),
    ).toBe(false);
    expect(isQueueableMutation("POST", "/api/v1/billing/checkout")).toBe(false);
    expect(isQueueableMutation("DELETE", "/api/v1/forms/form_1")).toBe(false);

    const admission = await enqueueOfflineMutation({
      method: "PATCH",
      path: "HTTPS://api.example.com/api/v1/forms/form_1?draft=1",
      body: { name: "Newsletter signup" },
      headers: { "If-Match": "rev-1", Authorization: "Bearer pw_secret" },
    });

    expect(admission).toMatchObject({
      ok: true,
      receipt: {
        state: "pending",
        action: "Update form",
        record: "Newsletter signup",
      },
    });
    expect(readOfflineQueue()[0]).toMatchObject({
      path: "/api/v1/forms/form_1?draft=1",
      headers: { "if-match": "rev-1" },
      identity,
      actionLabel: "Update form",
      recordLabel: "Newsletter signup",
    });
    expect(readOfflineQueue()[0]).not.toHaveProperty("expiresAt");
  });

  it("persists mutation bodies only inside an AES-GCM vault envelope", async () => {
    const sensitive = "private-person@example.com";
    await enqueueOfflineMutation({
      method: "PATCH",
      path: "/api/v1/subscribers/sub_1",
      body: { email: sensitive, merge_fields: { name: "Private Person" } },
    });
    await offlineQueueIdle();

    const raw = storage.get(outboxStorageKey);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(sensitive);
    expect(raw).not.toContain("Private Person");
    expect(JSON.parse(raw as string)).toMatchObject({ alg: "AES-GCM" });
    expect(storage.has("postwave.desktop.offline-mutations.v1")).toBe(false);
  });

  it("persists only v2 opaque identity metadata and never raw account ids", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Opaque owner" },
    });
    await offlineQueueIdle();

    const metadata = storage.get("postwave.desktop.offline-identity.v2");
    expect(metadata).toBeTruthy();
    expect(JSON.parse(metadata as string)).toEqual({
      version: 2,
      identity: expect.stringMatching(/^offline-identity:sha256:[a-f0-9]{64}$/),
    });
    expect([...storage.keys()].join("\n")).not.toContain(IDENTITY_SOURCE);
    expect([...storage.values()].join("\n")).not.toContain(IDENTITY_SOURCE);
  });

  it("upgrades identity-proven encrypted v1 records before deleting raw-key copies", async () => {
    await clearOfflineStores();
    const queuedAt = TEST_NOW.toISOString();
    storage.set("postwave.desktop.offline-identity.v1", IDENTITY_SOURCE);
    await vaultSetJSON(`offline-outbox.v3:${IDENTITY_SOURCE}`, {
      version: 3,
      identity: IDENTITY_SOURCE,
      writtenAt: queuedAt,
      items: [
        {
          id: "mut_upgrade",
          method: "POST",
          path: "/api/v1/forms",
          body: { name: "Preserved upgrade" },
          idempotencyKey: "idem_upgrade",
          queuedAt,
          attempts: 0,
          status: "pending",
          identity: IDENTITY_SOURCE,
        },
      ],
      history: [],
    });
    await vaultSetJSON(`offline-cache.v2:${IDENTITY_SOURCE}`, {
      version: 2,
      identity: IDENTITY_SOURCE,
      writtenAt: queuedAt,
      entries: [
        {
          path: "/api/v1/dashboard/stats",
          identity: IDENTITY_SOURCE,
          cachedAt: queuedAt,
          expiresAt: new Date(
            TEST_NOW.getTime() + 60 * 60 * 1000,
          ).toISOString(),
          data: { owner: "Preserved upgrade" },
        },
      ],
    });

    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();
    const upgradedIdentity = getOfflineIdentity();

    expect(upgradedIdentity).toMatch(/^offline-identity:sha256:/);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mut_upgrade",
        identity: upgradedIdentity,
        body: { name: "Preserved upgrade" },
      }),
    ]);
    expect(readCachedResponse("/api/v1/dashboard/stats")).toEqual({
      owner: "Preserved upgrade",
    });
    expect(storage.has("postwave.desktop.offline-identity.v1")).toBe(false);
    expect(
      storage.has(
        `postwave.desktop.vault.v1:offline-outbox.v3:${IDENTITY_SOURCE}`,
      ),
    ).toBe(false);
    expect(
      storage.has(
        `postwave.desktop.vault.v1:offline-cache.v2:${IDENTITY_SOURCE}`,
      ),
    ).toBe(false);
    expect([...storage.keys()].join("\n")).not.toContain(IDENTITY_SOURCE);
    expect([...storage.values()].join("\n")).not.toContain(IDENTITY_SOURCE);
  });

  it("does not adopt a legacy journal without an exact authenticated owner proof", async () => {
    await clearOfflineStores();
    storage.set("postwave.desktop.offline-identity.v1", IDENTITY_SOURCE);
    await vaultSetJSON(`offline-outbox.v3:${IDENTITY_SOURCE}`, {
      version: 3,
      identity: IDENTITY_SOURCE,
      writtenAt: TEST_NOW.toISOString(),
      items: [
        {
          id: "mut_alpha",
          method: "POST",
          path: "/api/v1/forms",
          body: { name: "Alpha only" },
          idempotencyKey: "idem_alpha",
          queuedAt: TEST_NOW.toISOString(),
          attempts: 0,
          status: "pending",
          identity: IDENTITY_SOURCE,
        },
      ],
    });

    await setOfflineIdentity("user-b:tenant-b");
    await offlineQueueIdle();

    expect(readOfflineQueue()).toEqual([]);
    expect(storage.get("postwave.desktop.offline-identity.v1")).toBe(
      IDENTITY_SOURCE,
    );
    expect(
      storage.has(
        `postwave.desktop.vault.v1:offline-outbox.v3:${IDENTITY_SOURCE}`,
      ),
    ).toBe(true);
  });

  it("preserves legacy ciphertext and its proof marker when migration cannot read the vault", async () => {
    await clearOfflineStores();
    storage.set("postwave.desktop.offline-identity.v1", IDENTITY_SOURCE);
    await vaultSetJSON(`offline-outbox.v3:${IDENTITY_SOURCE}`, {
      version: 3,
      identity: IDENTITY_SOURCE,
      writtenAt: TEST_NOW.toISOString(),
      items: [],
    });
    const oldKey = `postwave.desktop.vault.v1:offline-outbox.v3:${IDENTITY_SOURCE}`;
    const ciphertext = storage.get(oldKey);
    vi.spyOn(secureVault, "vaultReadJSON").mockResolvedValue({
      status: "unavailable",
    });

    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();

    expect(storage.get(oldKey)).toBe(ciphertext);
    expect(storage.get("postwave.desktop.offline-identity.v1")).toBe(
      IDENTITY_SOURCE,
    );
    expect(getOfflinePersistenceError()).toMatch(/original ciphertext/i);
  });

  it("surfaces a fail-closed warning when encrypted persistence is unavailable", async () => {
    vi.spyOn(secureVault, "vaultSetJSON").mockRejectedValueOnce(
      new Error("credential vault locked"),
    );
    const admission = await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "In-memory only" },
    });

    await offlineQueueIdle();

    expect(admission).toMatchObject({
      ok: false,
      code: "persistence-unavailable",
      preservedDraft: { name: "In-memory only" },
    });
    expect(getOfflinePersistenceError()).toMatch(/encrypted offline storage/i);
    expect(readOfflineQueue()).toHaveLength(0);
    expect(storage.has(outboxStorageKey)).toBe(false);
  });

  it("authenticates identity metadata and restores a valid crash snapshot", async () => {
    const queuedAt = TEST_NOW.toISOString();
    const item: OfflineMutation = {
      id: "mut_recovered",
      method: "PATCH",
      path: "/api/v1/forms/form_1",
      body: { name: "Recovered draft" },
      idempotencyKey: "idem_recovered",
      queuedAt,
      expiresAt: "2026-07-14T16:00:00.000Z",
      attempts: 0,
      status: "pending",
      identity,
    };
    await vaultSetJSON(`offline-outbox.v2:${identity}`, {
      version: 2,
      identity,
      writtenAt: queuedAt,
      items: [item],
    });

    await hydrateOfflineStores();
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mut_recovered",
        body: { name: "Recovered draft" },
        identity,
      }),
    ]);
    expect(storage.has(outboxStorageKey)).toBe(true);
    expect(storage.has(legacyOutboxStorageKey)).toBe(false);

    writeOfflineQueue([]);
    await offlineQueueIdle();
    await vaultSetJSON(`offline-outbox.v2:${identity}`, {
      version: 2,
      identity: "user-b:tenant-b",
      writtenAt: queuedAt,
      items: [item],
    });
    await hydrateOfflineStores();
    expect(readOfflineQueue()).toEqual([]);
    expect(storage.has(outboxStorageKey)).toBe(false);
    expect(storage.has(legacyOutboxStorageKey)).toBe(false);
  });

  it("ignores the legacy eight-hour expiry and retains payloads until resolution", () => {
    writeOfflineQueue([
      {
        id: "mut_expired",
        method: "PATCH",
        path: "/api/v1/forms/form_1",
        body: { name: "Must disappear" },
        idempotencyKey: "idem_expired",
        queuedAt: "2026-06-01T00:00:00.000Z",
        expiresAt: "2026-06-01T08:00:00.000Z",
        attempts: 0,
        status: "pending",
      },
    ]);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mut_expired",
        body: { name: "Must disappear" },
        status: "pending",
      }),
    ]);
    expect(readOfflineQueue()[0]).not.toHaveProperty("expiresAt");
  });

  it("expires cached reads but never schedules an outbox payload purge", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Short-lived queue" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", {
      customer: "Short-lived cache",
    });
    await offlineQueueIdle();
    expect(storage.has(outboxStorageKey)).toBe(true);
    expect(storage.has(cacheStorageKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 2);
    await offlineQueueIdle();
    expect(storage.has(cacheStorageKey)).toBe(false);
    expect(storage.has(outboxStorageKey)).toBe(true);

    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60 * 1000);
    await offlineQueueIdle();
    expect(storage.has(outboxStorageKey)).toBe(true);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({ body: { name: "Short-lived queue" } }),
    ]);
  });

  it("encrypts the narrow cache, scopes it, and expires it after one hour", async () => {
    expect(isOfflineCacheableGet("/api/v1/dashboard/stats")).toBe(true);
    expect(isOfflineCacheableGet("/api/v1/subscribers")).toBe(false);
    writeCachedResponse("/api/v1/dashboard/stats", {
      subscribers: 7,
      label: "Customer A",
    });
    await offlineQueueIdle();

    expect(readCachedResponse("/api/v1/dashboard/stats")).toEqual({
      subscribers: 7,
      label: "Customer A",
    });
    const raw = storage.get(cacheStorageKey);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("Customer A");
    expect(JSON.parse(raw as string)).toMatchObject({ alg: "AES-GCM" });

    vi.setSystemTime(new Date("2026-07-14T09:00:01.000Z"));
    cleanupOfflineStorage();
    expect(readCachedResponse("/api/v1/dashboard/stats")).toBeNull();
  });

  it("purges legacy plaintext mutation and cache records on upgrade", () => {
    storage.set(
      "postwave.desktop.offline-mutations.v1",
      JSON.stringify([{ body: { email: "legacy@example.com" } }]),
    );
    storage.set(
      "postwave.desktop.offline-cache.v1:/api/v1/dashboard/stats",
      JSON.stringify({ data: { customer: "legacy" } }),
    );

    cleanupOfflineStorage();

    expect(storage.has("postwave.desktop.offline-mutations.v1")).toBe(false);
    expect(
      storage.has("postwave.desktop.offline-cache.v1:/api/v1/dashboard/stats"),
    ).toBe(false);
  });

  it("parks the previous identity securely across a workspace switch", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Tenant A only" },
    });
    await vaultSetJSON(`sensitive:${identity}:/api/v1/subscribers/sub_1`, {
      email: "private-person@example.com",
    });
    await offlineQueueIdle();
    expect(storage.has(outboxStorageKey)).toBe(true);
    expect(
      [...storage.keys()].some((key) =>
        key.startsWith(`postwave.desktop.vault.v1:sensitive:${identity}:`),
      ),
    ).toBe(true);

    await setOfflineIdentity("user-b:tenant-b");
    await offlineQueueIdle();

    expect(readOfflineQueue()).toEqual([]);
    expect(storage.has(outboxStorageKey)).toBe(true);
    expect(
      [...storage.keys()].some((key) =>
        key.startsWith(`postwave.desktop.vault.v1:sensitive:${identity}:`),
      ),
    ).toBe(true);
    expect(getOfflineIdentity()).toMatch(/^offline-identity:sha256:/);

    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({ body: { name: "Tenant A only" } }),
    ]);
  });

  it("detaches for a reload without deleting the encrypted journal", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Reload-safe draft" },
    });

    await parkOfflineStores();
    expect(getOfflineIdentity()).toBeNull();
    expect(readOfflineQueue()).toEqual([]);
    expect(storage.has(outboxStorageKey)).toBe(true);

    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({ body: { name: "Reload-safe draft" } }),
    ]);
  });

  it("never overwrites retained ciphertext when the vault cannot unlock", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Retained ciphertext" },
    });
    const encryptedBefore = storage.get(outboxStorageKey);
    await parkOfflineStores();
    vi.spyOn(secureVault, "vaultGetJSON").mockResolvedValue(null);

    await setOfflineIdentity(IDENTITY_SOURCE);
    await offlineQueueIdle();
    expect(getOfflinePersistenceError()).toMatch(/could not unlock/i);
    expect(readOfflineQueue()).toEqual([]);

    const admission = await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Must not overwrite" },
    });
    expect(admission).toMatchObject({
      ok: false,
      code: "persistence-unavailable",
      preservedDraft: { name: "Must not overwrite" },
    });
    expect(storage.get(outboxStorageKey)).toBe(encryptedBefore);
  });

  it("purges identity, ciphertext, cache, and memory on logout", async () => {
    await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Logout purge" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", { customer: "A" });
    await offlineQueueIdle();

    await clearOfflineStores();

    expect(getOfflineIdentity()).toBeNull();
    expect(readOfflineQueue()).toEqual([]);
    expect(readCachedResponse("/api/v1/dashboard/stats")).toBeNull();
    expect(storage.has(outboxStorageKey)).toBe(false);
    expect(storage.has(cacheStorageKey)).toBe(false);
    expect(storage.has("postwave.desktop.offline-identity.v1")).toBe(false);
    expect(storage.has("postwave.desktop.offline-identity.v2")).toBe(false);
  });

  it("refuses a new edit at capacity without evicting existing records", async () => {
    const acceptedIDs: string[] = [];
    let refusal: Awaited<ReturnType<typeof enqueueOfflineMutation>> | null =
      null;
    for (let index = 0; index < 12; index += 1) {
      const result = await enqueueOfflineMutation({
        method: "PATCH",
        path: `/api/v1/forms/form_${index}`,
        body: { name: `Form ${index}`, content: "x".repeat(60 * 1024) },
      });
      if (result.ok) acceptedIDs.push(result.item.id);
      else {
        refusal = result;
        break;
      }
    }

    expect(acceptedIDs.length).toBeGreaterThan(0);
    expect(refusal).toMatchObject({ ok: false, code: "capacity" });
    expect(readOfflineQueue().map((item) => item.id)).toEqual(acceptedIDs);
    expect(getOfflinePersistenceError()).toMatch(
      /existing queued changes are safe/i,
    );
  });

  it("never accepts anonymous offline customer persistence", async () => {
    await clearOfflineStores();
    const admission = await enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { email: "anonymous@example.com" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", { customer: "anonymous" });
    await offlineQueueIdle();

    expect(admission).toMatchObject({
      ok: false,
      code: "identity-unavailable",
      preservedDraft: { email: "anonymous@example.com" },
    });
    expect(readOfflineQueue()).toEqual([]);
    expect(
      [...storage.values()].some((value) => value.includes("anonymous")),
    ).toBe(false);
  });
});
