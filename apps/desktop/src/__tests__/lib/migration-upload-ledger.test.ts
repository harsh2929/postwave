import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearOfflineStores,
  offlineQueueIdle,
  setOfflineIdentity,
} from "../../lib/offline-store";
import {
  migrationUploadLedgerScope,
  newMigrationUploadID,
  readMigrationUploadLedger,
  writeMigrationUploadLedger,
} from "../../lib/migration-upload-ledger";

function testFile(body: string, name = "private-contacts.csv"): File {
  return Object.assign(new Blob([body], { type: "text/csv" }), {
    name,
    lastModified: 123,
  }) as File;
}

describe("identity-bound migration upload ledger", () => {
  const values = new Map<string, string>();

  beforeEach(async () => {
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() {
        return values.size;
      },
    } as Storage;
    vi.stubGlobal("window", {
      localStorage,
      crypto: webcrypto as unknown as Crypto,
    });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    await clearOfflineStores();
    values.clear();
    await setOfflineIdentity("migration-owner-alpha");
    await offlineQueueIdle();
  });

  afterEach(async () => {
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    await clearOfflineStores();
    await offlineQueueIdle();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("separates workspaces and same-metadata files by cryptographic content", async () => {
    const firstFile = testFile("email\na@example.com");
    const secondFile = testFile("email\nb@example.com");
    expect(firstFile.size).toBe(secondFile.size);
    const alphaFirst = await migrationUploadLedgerScope("csv", firstFile);
    const alphaSecond = await migrationUploadLedgerScope("csv", secondFile);

    await setOfflineIdentity("migration-owner-beta");
    await offlineQueueIdle();
    const betaFirst = await migrationUploadLedgerScope("csv", firstFile);

    expect(alphaFirst?.key).toMatch(
      /^postwave\.desktop\.migration-upload\.v2:[a-f0-9]{64}$/,
    );
    expect(alphaFirst?.key).not.toBe(alphaSecond?.key);
    expect(alphaFirst?.key).not.toBe(betaFirst?.key);
    expect(
      [alphaFirst?.key, alphaSecond?.key, betaFirst?.key].join(" "),
    ).not.toContain(firstFile.name);
  });

  it("never resumes when identity or WebCrypto is unavailable", async () => {
    const file = testFile("email\na@example.com");
    await clearOfflineStores();
    expect(await migrationUploadLedgerScope("csv", file)).toBeNull();

    await setOfflineIdentity("migration-owner-alpha");
    await offlineQueueIdle();
    vi.stubGlobal("crypto", { randomUUID: () => "upload-only" });
    expect(await migrationUploadLedgerScope("csv", file)).toBeNull();
  });

  it("fails closed instead of minting a predictable upload identifier", () => {
    vi.stubGlobal("crypto", {});
    expect(() => newMigrationUploadID()).toThrow(
      "Secure randomness is unavailable",
    );

    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab);
        return bytes;
      },
    });
    expect(newMigrationUploadID()).toBe(`upload-${"ab".repeat(16)}`);
  });

  it("purges v1 state without adoption and refuses cross-workspace reads", async () => {
    const file = testFile("email\na@example.com");
    values.set(
      "postwave.desktop.migration-upload.v1:csv:ambiguous:20:123",
      JSON.stringify({ uploadId: "upload-legacy", uploadedBytes: 12 }),
    );
    const alphaScope = await migrationUploadLedgerScope("csv", file);
    await writeMigrationUploadLedger(alphaScope, "upload-alpha", 12);

    expect(
      [...values.keys()].some((key) =>
        key.startsWith("postwave.desktop.migration-upload.v1:"),
      ),
    ).toBe(false);
    expect(await readMigrationUploadLedger(alphaScope)).toEqual({
      version: 2,
      uploadId: "upload-alpha",
      uploadedBytes: 12,
      updatedAt: expect.any(String),
      expiresAt: expect.any(String),
    });

    await setOfflineIdentity("migration-owner-beta");
    await offlineQueueIdle();
    expect(await readMigrationUploadLedger(alphaScope)).toBeNull();
    expect([...values.keys()].join("\n")).not.toContain(file.name);
  });

  it("expires stale state and caps abandoned renderer ledgers", async () => {
    const now = Date.now();
    for (let index = 0; index < 22; index += 1) {
      values.set(
        `postwave.desktop.migration-upload.v2:${index.toString(16).padStart(64, "0")}`,
        JSON.stringify({
          version: 2,
          uploadId: `upload-${index}`,
          uploadedBytes: 0,
          updatedAt: new Date(now - index * 1_000).toISOString(),
          expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        }),
      );
    }
    values.set(
      `postwave.desktop.migration-upload.v2:${"f".repeat(64)}`,
      JSON.stringify({
        version: 2,
        uploadId: "upload-expired",
        uploadedBytes: 0,
        updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(now - 1).toISOString(),
      }),
    );

    await migrationUploadLedgerScope("csv", testFile("email\na@example.com"));

    const ledgers = [...values.keys()].filter((key) =>
      key.startsWith("postwave.desktop.migration-upload.v2:"),
    );
    expect(ledgers).toHaveLength(20);
    expect(ledgers).not.toContain(
      `postwave.desktop.migration-upload.v2:${"f".repeat(64)}`,
    );
  });
});
