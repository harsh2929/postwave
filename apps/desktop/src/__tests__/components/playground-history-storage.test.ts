// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearHistory,
  loadPlaygroundHistory,
  recordHistoryEntry,
  removeHistoryEntry,
  sanitizePlaygroundHistory,
  subscribeToPlaygroundHistory,
} from "../../components/playground/playground-history-storage";
import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import { sensitiveLocalVaultKey } from "../../lib/sensitive-local-data";
import { vaultGetJSON, vaultSetJSON } from "../../lib/secure-vault";

const ALPHA = desktopRouteIdentityScope(
  "alice@example.com",
  "workspace-alpha",
)!;
const BETA = desktopRouteIdentityScope("bob@example.com", "workspace-beta")!;
const NAMESPACE = "api-playground-history-v2";
const VAULT_STORAGE_PREFIX = "postwave.desktop.vault.v1:";

function draft(index = 1) {
  return {
    method: "GET" as const,
    pathTemplate: "/api/v1/subscribers/{id}",
    status: 200,
    durationMs: index,
    outcome: "http" as const,
    ambiguous: false,
    parameterNamesOmitted: {
      path: ["id"],
      query: ["email"],
      header: ["X-Customer-Context"],
    },
    customHeaderNamesOmitted: ["X-Customer-Context"],
    body: "" as const,
    bodyOmitted: true,
  };
}

function encryptedStorageKey(scope: string): string {
  return `${VAULT_STORAGE_PREFIX}${sensitiveLocalVaultKey(NAMESPACE, scope)}`;
}

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("API Playground encrypted history storage", () => {
  it("persists ciphertext under an opaque identity key and isolates accounts", async () => {
    await recordHistoryEntry(ALPHA, draft());

    const keys = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index) ?? "",
    );
    const values = keys.map((key) => localStorage.getItem(key) ?? "");
    expect(keys).toEqual([encryptedStorageKey(ALPHA)]);
    expect(keys.join(" ")).not.toContain("alice@example.com");
    expect(keys.join(" ")).not.toContain("workspace-alpha");
    expect(keys.join(" ")).not.toContain("api.example.test");
    expect(values.join(" ")).not.toContain("reader-1@example.com");
    expect(values.join(" ")).not.toContain("/api/v1/subscribers");

    const alpha = await loadPlaygroundHistory(ALPHA);
    const beta = await loadPlaygroundHistory(BETA);
    expect(alpha.entries).toHaveLength(1);
    expect(alpha.entries[0]).toMatchObject({
      parameterNamesOmitted: {
        path: ["id"],
        query: ["email"],
        header: ["X-Customer-Context"],
      },
      customHeaderNamesOmitted: ["X-Customer-Context"],
      body: "",
      bodyOmitted: true,
    });
    expect(beta.entries).toEqual([]);
  });

  it("purges every ownership-ambiguous legacy key without reading or adopting it", async () => {
    const firstLegacy = "pw_playground_history__https://api.one.test";
    const secondLegacy =
      "pw_playground_history__https://api.two.test::workspace=old-tenant";
    localStorage.setItem(
      firstLegacy,
      JSON.stringify([{ ...draft(), retiredSecret: "https://secret.invalid" }]),
    );
    localStorage.setItem(secondLegacy, "old-account-secret");
    const originalGet = localStorage.getItem.bind(localStorage);
    const reads: string[] = [];
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      reads.push(key);
      return originalGet(key);
    });

    const loaded = await loadPlaygroundHistory(ALPHA);

    expect(loaded.entries).toEqual([]);
    expect(loaded.warning).toContain("removed without reading or importing");
    expect(reads).not.toContain(firstLegacy);
    expect(reads).not.toContain(secondLegacy);
    expect(originalGet(firstLegacy)).toBeNull();
    expect(originalGet(secondLegacy)).toBeNull();
    expect(JSON.stringify(loaded)).not.toContain("old-account-secret");
  });

  it("purges the retired encrypted value-bearing namespace without reading it", async () => {
    const retiredKey =
      "postwave.desktop.vault.v1:sensitive-local.v1.api-playground-history.retired-scope";
    localStorage.setItem(retiredKey, "ciphertext-containing-retired-values");
    const originalGet = localStorage.getItem.bind(localStorage);
    const reads: string[] = [];
    vi.spyOn(localStorage, "getItem").mockImplementation((key: string) => {
      reads.push(key);
      return originalGet(key);
    });

    const loaded = await loadPlaygroundHistory(ALPHA);

    expect(loaded.warning).toContain("removed without reading or importing");
    expect(reads).not.toContain(retiredKey);
    expect(originalGet(retiredKey)).toBeNull();
  });

  it("serializes concurrent records and clear/delete mutations without lost updates", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordHistoryEntry(ALPHA, draft(index + 1)),
      ),
    );
    let loaded = await loadPlaygroundHistory(ALPHA);
    expect(loaded.entries).toHaveLength(20);
    expect(new Set(loaded.entries.map((entry) => entry.id)).size).toBe(20);

    await removeHistoryEntry(ALPHA, loaded.entries[7]!.id);
    loaded = await loadPlaygroundHistory(ALPHA);
    expect(loaded.entries).toHaveLength(19);

    await clearHistory(ALPHA);
    expect((await loadPlaygroundHistory(ALPHA)).entries).toEqual([]);
  });

  it("round-trips sanitized unknown-outcome evidence for mutations", async () => {
    await recordHistoryEntry(ALPHA, {
      ...draft(),
      method: "POST",
      status: 0,
      outcome: "timeout",
      ambiguous: true,
    });
    await recordHistoryEntry(ALPHA, {
      ...draft(),
      method: "PATCH",
      status: 503,
      outcome: "http",
      ambiguous: true,
    });

    const loaded = await loadPlaygroundHistory(ALPHA);
    expect(loaded.entries).toMatchObject([
      { method: "PATCH", status: 503, outcome: "http", ambiguous: true },
      { method: "POST", status: 0, outcome: "timeout", ambiguous: true },
    ]);
  });

  it("migrates legacy uncertain mutations to a fail-closed unknown outcome", () => {
    const now = Date.now();
    const legacy = { ...draft(), id: "legacy-uncertain", ts: now };
    delete (legacy as Partial<typeof legacy>).outcome;
    delete (legacy as Partial<typeof legacy>).ambiguous;
    Object.assign(legacy, { method: "POST", status: 0 });

    expect(sanitizePlaygroundHistory([legacy], now)).toMatchObject({
      altered: true,
      value: [{ outcome: "unknown", ambiguous: true }],
    });
  });

  it("repairs count, byte, age, method, status, duration, and field bounds", async () => {
    const now = Date.now();
    const valid = Array.from({ length: 55 }, (_, index) => ({
      ...draft(index),
      id: `valid-${index}`,
      ts: now - index,
      parameterNamesOmitted: {
        path: Array.from(
          { length: 48 },
          (_, nameIndex) => `path_${index}_${nameIndex}_${"x".repeat(100)}`,
        ),
      },
    }));
    const malformed = [
      { ...valid[0], id: "expired", ts: now - 31 * 24 * 60 * 60 * 1000 },
      { ...valid[0], id: "bad-method", method: "TRACE" },
      { ...valid[0], id: "bad-status", status: 99 },
      { ...valid[0], id: "bad-duration", durationMs: -1 },
      { ...valid[0], id: "bad-field", pathTemplate: `/${"z".repeat(2_049)}` },
    ];
    await vaultSetJSON(sensitiveLocalVaultKey(NAMESPACE, ALPHA), {
      version: 1,
      value: [...malformed, ...valid],
    });

    const loaded = await loadPlaygroundHistory(ALPHA);
    const bytes = new TextEncoder().encode(
      JSON.stringify(loaded.entries),
    ).byteLength;
    expect(loaded.entries.length).toBeLessThanOrEqual(50);
    expect(loaded.entries.length).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(128 * 1024);
    expect(loaded.entries.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([
        "expired",
        "bad-method",
        "bad-status",
        "bad-duration",
        "bad-field",
      ]),
    );
    expect(loaded.warning).toContain("omitted");
    const repaired = await vaultGetJSON<{ value: unknown[] }>(
      sensitiveLocalVaultKey(NAMESPACE, ALPHA),
    );
    expect(repaired?.value).toHaveLength(loaded.entries.length);
  });

  it("drops unknown and secret-bearing record properties during validation", () => {
    const now = Date.now();
    const sanitized = sanitizePlaygroundHistory(
      [
        {
          ...draft(),
          id: "one",
          ts: now,
          customHeaders: { "X-Unclassified": "arbitrary-secret-value" },
          unexpected: "do-not-retain",
        },
      ],
      now,
    );
    expect(sanitized?.altered).toBe(true);
    expect(JSON.stringify(sanitized?.value)).not.toContain(
      "arbitrary-secret-value",
    );
    expect(JSON.stringify(sanitized?.value)).not.toContain("do-not-retain");
    expect(
      sanitizePlaygroundHistory(
        [{ ...draft(), id: "control", ts: now, pathTemplate: "/api\nattack" }],
        now,
      )?.value,
    ).toEqual([]);
  });

  it("isolates same-scope listener failures", async () => {
    const survivingListener = vi.fn();
    const unsubscribeBroken = subscribeToPlaygroundHistory(ALPHA, () => {
      throw new Error("broken subscriber");
    });
    const unsubscribeSurviving = subscribeToPlaygroundHistory(
      ALPHA,
      survivingListener,
    );
    try {
      await recordHistoryEntry(ALPHA, draft());
      expect(survivingListener).toHaveBeenCalledWith({ error: null });
    } finally {
      unsubscribeBroken();
      unsubscribeSurviving();
    }
  });

  it("discards corrupt ciphertext and fails closed when vault reads are denied", async () => {
    localStorage.setItem(encryptedStorageKey(ALPHA), "not-an-envelope");
    const corrupt = await loadPlaygroundHistory(ALPHA);
    expect(corrupt.entries).toEqual([]);
    expect(corrupt.warning).toContain("unreadable");
    expect(localStorage.getItem(encryptedStorageKey(ALPHA))).toBeNull();

    await recordHistoryEntry(ALPHA, draft());
    const originalGet = localStorage.getItem.bind(localStorage);
    const before = originalGet(encryptedStorageKey(ALPHA));
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    const unavailable = await loadPlaygroundHistory(ALPHA);
    expect(unavailable).toMatchObject({
      entries: [],
      state: "unavailable",
      retryable: true,
    });
    expect(originalGet(encryptedStorageKey(ALPHA))).toBe(before);
  });

  it("rejects storage-denied writes without a plaintext fallback", async () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await expect(recordHistoryEntry(ALPHA, draft())).rejects.toThrow();
    expect(localStorage.length).toBe(0);
  });
});
