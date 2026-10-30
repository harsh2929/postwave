import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  flushQueuedMutations,
  rememberSession,
  syncOfflineIdentity,
} from "../../lib/api-client";
import {
  clearOfflineStores,
  getOfflinePersistenceError,
  offlineQueueIdle,
  readOfflineJournal,
  readOfflineQueue,
  writeOfflineQueue,
  type OfflineMutation,
} from "../../lib/offline-store";
import * as secureVault from "../../lib/secure-vault";

function mapStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function queuedSubscriberEdit(
  id: string,
  body: Record<string, unknown>,
): OfflineMutation {
  const version = '"subscriber:subscriber-1:v1"';
  return {
    id,
    method: "PATCH",
    path: "/api/v1/subscribers/subscriber-1",
    body,
    headers: { "if-match": version },
    baseVersion: version,
    idempotencyKey: `idem_${id}`,
    queuedAt: "2026-07-19T00:00:00.000Z",
    attempts: 0,
    status: "pending",
    resource: "subscribers",
  };
}

describe("subscriber outbox replay safety", () => {
  beforeEach(async () => {
    const localStorage = mapStorage();
    vi.stubGlobal("window", {
      localStorage,
      crypto: webcrypto as unknown as Crypto,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    vi.stubGlobal("navigator", { onLine: true });
    rememberSession({
      user_id: "user-1",
      tenant_id: "tenant-1",
      email: "owner@example.test",
      role: "owner",
      auth_provider: "password",
      email_verified: true,
    });
    await syncOfflineIdentity();
    await offlineQueueIdle();
  });

  afterEach(async () => {
    await clearOfflineStores();
    await offlineQueueIdle();
    rememberSession(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("replays two same-record edits with the fresh ETag from their predecessor", async () => {
    writeOfflineQueue([
      queuedSubscriberEdit("mutation-1", { tags: ["first"] }),
      queuedSubscriberEdit("mutation-2", { display_name: "Second" }),
    ]);

    const observedVersions: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      observedVersions.push(new Headers(init.headers).get("if-match") ?? "");
      const version = `"subscriber:subscriber-1:v${observedVersions.length + 1}"`;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: version },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await flushQueuedMutations();

    expect(result).toEqual({ replayed: 2, conflicts: 0, failed: 0 });
    expect(observedVersions).toEqual([
      '"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v2"',
    ]);
    expect(readOfflineQueue()).toEqual([]);
    expect(readOfflineJournal()).toEqual([
      expect.objectContaining({ id: "mutation-2", status: "synced" }),
      expect.objectContaining({ id: "mutation-1", status: "synced" }),
    ]);
  });

  it.each([
    ["a missing ETag", undefined],
    [
      "an exact ETag owned by another subscriber",
      '"subscriber:subscriber-other:v2"',
    ],
  ])(
    "parks a dependent edit when its predecessor returns %s",
    async (_label, etag) => {
      writeOfflineQueue([
        queuedSubscriberEdit("mutation-1", { tags: ["first"] }),
        queuedSubscriberEdit("mutation-2", { display_name: "Second" }),
      ]);
      await offlineQueueIdle();

      const observedVersions: string[] = [];
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        observedVersions.push(new Headers(init.headers).get("if-match") ?? "");
        return new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...(etag ? { ETag: etag } : {}),
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await flushQueuedMutations();

      expect(result).toEqual({ replayed: 1, conflicts: 0, failed: 0 });
      expect(observedVersions).toEqual(['"subscriber:subscriber-1:v1"']);
      expect(readOfflineQueue()).toEqual([
        expect.objectContaining({
          id: "mutation-2",
          status: "conflict",
          baseVersion: '"subscriber:subscriber-1:v1"',
          lastError: expect.stringMatching(/verified revision.*refresh/i),
        }),
      ]);
    },
  );

  it("waits for the durable completion-and-rebase checkpoint before dispatching the successor", async () => {
    writeOfflineQueue([
      queuedSubscriberEdit("mutation-1", { tags: ["first"] }),
      queuedSubscriberEdit("mutation-2", { display_name: "Second" }),
    ]);
    await offlineQueueIdle();

    const observedVersions: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      observedVersions.push(new Headers(init.headers).get("if-match") ?? "");
      const version = `"subscriber:subscriber-1:v${observedVersions.length + 1}"`;
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: version },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const originalVaultSetJSON = secureVault.vaultSetJSON;
    let vaultWrites = 0;
    let markCheckpointStarted: (() => void) | undefined;
    const checkpointStarted = new Promise<void>((resolve) => {
      markCheckpointStarted = resolve;
    });
    let releaseCheckpoint: (() => void) | undefined;
    const checkpointGate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    vi.spyOn(secureVault, "vaultSetJSON").mockImplementation(
      async (key, value) => {
        vaultWrites += 1;
        if (vaultWrites === 1) {
          markCheckpointStarted?.();
          await checkpointGate;
        }
        await originalVaultSetJSON(key, value);
      },
    );

    const flush = flushQueuedMutations();
    await checkpointStarted;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mutation-1",
        status: "replaying",
        attempts: 1,
      }),
      expect.objectContaining({
        id: "mutation-2",
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
    ]);

    releaseCheckpoint?.();
    const result = await flush;

    expect(result).toEqual({ replayed: 2, conflicts: 0, failed: 0 });
    expect(observedVersions).toEqual([
      '"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v2"',
    ]);
  });

  it("keeps an accepted item and its successor retryable when the durable checkpoint fails", async () => {
    writeOfflineQueue([
      queuedSubscriberEdit("mutation-1", { tags: ["first"] }),
      queuedSubscriberEdit("mutation-2", { display_name: "Second" }),
    ]);
    await offlineQueueIdle();

    const observedVersions: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      observedVersions.push(new Headers(init.headers).get("if-match") ?? "");
      const version =
        observedVersions.length <= 2
          ? '"subscriber:subscriber-1:v2"'
          : '"subscriber:subscriber-1:v3"';
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: version },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const vaultWrite = vi
      .spyOn(secureVault, "vaultSetJSON")
      .mockRejectedValue(new Error("credential vault locked"));

    const failedResult = await flushQueuedMutations();

    expect(failedResult).toEqual({ replayed: 0, conflicts: 0, failed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getOfflinePersistenceError()).toMatch(
      /could not securely checkpoint/i,
    );
    expect(readOfflineJournal()).toEqual([]);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mutation-1",
        status: "failed",
        attempts: 0,
        lastError: expect.stringMatching(/securely checkpoint/i),
      }),
      expect.objectContaining({
        id: "mutation-2",
        status: "pending",
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
    ]);

    vaultWrite.mockRestore();
    const retryResult = await flushQueuedMutations();

    expect(retryResult).toEqual({ replayed: 2, conflicts: 0, failed: 0 });
    expect(observedVersions).toEqual([
      '"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v2"',
    ]);
    expect(readOfflineQueue()).toEqual([]);
  });

  it("does not spend HTTP retry budget across repeated checkpoint failures", async () => {
    writeOfflineQueue([
      queuedSubscriberEdit("mutation-1", { tags: ["first"] }),
      queuedSubscriberEdit("mutation-2", { display_name: "Second" }),
    ]);
    await offlineQueueIdle();

    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"subscriber:subscriber-1:v2"',
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(secureVault, "vaultSetJSON").mockRejectedValue(
      new Error("credential vault locked"),
    );

    for (let failure = 1; failure <= 8; failure += 1) {
      await expect(flushQueuedMutations()).resolves.toEqual({
        replayed: 0,
        conflicts: 0,
        failed: 1,
      });
      await offlineQueueIdle();
      expect(fetchMock).toHaveBeenCalledTimes(failure);
      expect(readOfflineQueue()).toEqual([
        expect.objectContaining({
          id: "mutation-1",
          status: "failed",
          attempts: 0,
          lastError: expect.stringMatching(/same idempotency key/i),
        }),
        expect.objectContaining({
          id: "mutation-2",
          status: "pending",
          attempts: 0,
        }),
      ]);
    }
  });
});
