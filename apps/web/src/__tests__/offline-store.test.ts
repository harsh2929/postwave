import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OFFLINE_QUEUE_CHANGED_EVENT,
  clearOfflineStorage,
  cleanupOfflineStorage,
  enqueueOfflineMutation,
  hasOfflineStorageIdentity,
  isOfflineCacheableGet,
  isOnlineOnlyMutation,
  isQueueableMutation,
  readCachedResponse,
  readOfflineQueue,
  resetOfflineStorageIdentity,
  setOfflineStorageIdentity,
  writeCachedResponse,
  writeOfflineQueue,
} from "../lib/offline-store";

const TEST_NOW = new Date("2026-07-14T08:00:00.000Z");

describe("web memory-only offline-store", () => {
  const storage = new Map<string, string>();
  let dispatchEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
    storage.clear();
    dispatchEvent = vi.fn();
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
    vi.stubGlobal("window", { localStorage, dispatchEvent });
    vi.stubGlobal(
      "CustomEvent",
      class TestCustomEvent extends Event {
        detail: unknown;
        constructor(type: string, init?: CustomEventInit) {
          super(type);
          this.detail = init?.detail;
        }
      },
    );
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    });
    setOfflineStorageIdentity("user_1", "tenant_1");
  });

  afterEach(() => {
    clearOfflineStorage();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("queues only low-risk edits in tab memory", () => {
    expect(
      isQueueableMutation("PATCH", "/api/v1/forms/form_1", {
        name: "Newsletter signup",
      }),
    ).toBe(true);
    expect(isQueueableMutation("POST", "/api/v1/segments")).toBe(true);
    expect(isOnlineOnlyMutation("POST", "/api/v1/billing/checkout")).toBe(
      true,
    );
    expect(isQueueableMutation("DELETE", "/api/v1/forms/form_1")).toBe(
      false,
    );

    const item = enqueueOfflineMutation({
      method: "PATCH",
      path: "https://api.example.com/api/v1/forms/form_1?draft=1",
      body: { email: "person@example.com" },
      headers: { "If-Match": "rev-1", Authorization: "Bearer secret" },
    });

    expect(item).toMatchObject({
      path: "/api/v1/forms/form_1?draft=1",
      headers: { "if-match": "rev-1" },
      expiresAt: "2026-07-14T12:00:00.000Z",
    });
    expect(readOfflineQueue()).toHaveLength(1);
    expect(storage.size).toBe(0);
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: OFFLINE_QUEUE_CHANGED_EVENT,
        detail: { count: 1 },
      }),
    );
  });

  it("never writes customer mutation or cache payloads to Web Storage", () => {
    const sensitive = "private-person@example.com";
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { email: sensitive, name: "Private Person" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", {
      account: "Customer A",
    });

    expect(readOfflineQueue()[0]?.body).toEqual({
      email: sensitive,
      name: "Private Person",
    });
    expect(readCachedResponse("/api/v1/dashboard/stats")).toEqual({
      account: "Customer A",
    });
    expect(storage.size).toBe(0);
  });

  it("treats reload/crash as a safe cache miss", () => {
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Unsaved tab edit" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", { customer: "A" });

    resetOfflineStorageIdentity();
    setOfflineStorageIdentity("user_1", "tenant_1");

    expect(readOfflineQueue()).toEqual([]);
    expect(readCachedResponse("/api/v1/dashboard/stats")).toBeNull();
    expect(storage.size).toBe(0);
  });

  it("purges memory on account/workspace switch", () => {
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Tenant A" },
    });
    writeCachedResponse("/api/v1/dashboard/stats", { tenant: "a" });

    setOfflineStorageIdentity("user_2", "tenant_2");

    expect(readOfflineQueue()).toEqual([]);
    expect(readCachedResponse("/api/v1/dashboard/stats")).toBeNull();
  });

  it("purges memory and disables persistence on logout", () => {
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Logout purge" },
    });
    clearOfflineStorage();

    expect(hasOfflineStorageIdentity()).toBe(false);
    expect(readOfflineQueue()).toEqual([]);
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Anonymous" },
    });
    expect(readOfflineQueue()).toEqual([]);
    expect(storage.size).toBe(0);
  });

  it("expires queued mutation payloads after four hours", () => {
    writeOfflineQueue([
      {
        id: "mut_expired",
        method: "PATCH",
        path: "/api/v1/forms/form_1",
        body: { name: "Expired" },
        idempotencyKey: "idem_expired",
        queuedAt: "2026-07-14T03:59:59.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
        attempts: 0,
        status: "pending",
      },
    ]);
    expect(readOfflineQueue()).toEqual([]);
  });

  it("actively removes an in-memory queue when its expiry timer fires", async () => {
    enqueueOfflineMutation({
      method: "POST",
      path: "/api/v1/forms",
      body: { name: "Short-lived" },
    });
    expect(readOfflineQueue()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 2);

    expect(readOfflineQueue()).toEqual([]);
    expect(dispatchEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ detail: { count: 0 } }),
    );
  });

  it("keeps only the narrow cache and expires it after thirty minutes", () => {
    expect(isOfflineCacheableGet("/api/v1/dashboard/stats")).toBe(true);
    expect(isOfflineCacheableGet("/api/v1/subscribers")).toBe(false);
    writeCachedResponse("/api/v1/dashboard/stats", { subscribers: 2 });
    writeCachedResponse("/api/v1/subscribers", [{ email: "no@example.com" }]);

    expect(readCachedResponse("/api/v1/dashboard/stats")).toEqual({
      subscribers: 2,
    });
    expect(readCachedResponse("/api/v1/subscribers")).toBeNull();

    vi.setSystemTime(new Date("2026-07-14T08:30:01.000Z"));
    cleanupOfflineStorage();
    expect(readCachedResponse("/api/v1/dashboard/stats")).toBeNull();
  });

  it("purges all legacy plaintext v1 and v2 records on upgrade", () => {
    storage.set(
      "postwave.web.offline-mutations.v1",
      JSON.stringify([{ body: { email: "legacy@example.com" } }]),
    );
    storage.set(
      "postwave.web.offline-cache.v1:/api/v1/dashboard/stats",
      JSON.stringify({ customer: "legacy" }),
    );
    storage.set(
      "postwave.web.offline-mutations.v2:user:tenant",
      JSON.stringify([{ body: { name: "legacy-v2" } }]),
    );
    storage.set(
      "postwave.web.offline-cache.v2:user:tenant:/api/v1/dashboard/stats",
      JSON.stringify({ customer: "legacy-v2" }),
    );

    cleanupOfflineStorage();

    expect(storage.size).toBe(0);
  });

  it("bounds memory use by dropping oldest records first", () => {
    writeOfflineQueue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `mut_${index}`,
        method: "PATCH",
        path: `/api/v1/forms/form_${index}`,
        body: { name: "x".repeat(60 * 1024) },
        idempotencyKey: `idem_${index}`,
        queuedAt: TEST_NOW.toISOString(),
        expiresAt: "2026-07-14T12:00:00.000Z",
        attempts: 0,
        status: "pending" as const,
      })),
    );

    const kept = readOfflineQueue();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(8);
    expect(kept.at(-1)?.id).toBe("mut_7");
    expect(storage.size).toBe(0);
  });
});
