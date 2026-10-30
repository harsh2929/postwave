import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  sensitiveLocalIdentityScope,
  sensitiveLocalVaultKey,
  type SanitizedLocalData,
} from "../../lib/sensitive-local-data";
import { vaultGetJSON, vaultSetJSON } from "../../lib/secure-vault";

interface SecretItem {
  id: string;
  value: string;
}

function validateItems(
  candidate: unknown,
): SanitizedLocalData<SecretItem[]> | null {
  if (!Array.isArray(candidate)) return null;
  const value = candidate.filter(
    (item): item is SecretItem =>
      !!item &&
      typeof item === "object" &&
      typeof (item as SecretItem).id === "string" &&
      (item as SecretItem).id.length <= 40 &&
      typeof (item as SecretItem).value === "string" &&
      (item as SecretItem).value.length <= 200,
  );
  return { value, altered: value.length !== candidate.length };
}

describe("sensitive local data boundary", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        key: (index: number) => Array.from(storage.keys())[index] ?? null,
        get length() {
          return storage.size;
        },
      },
      crypto: globalThis.crypto,
    });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("uses opaque user-and-workspace keys and isolates identities", async () => {
    const first = sensitiveLocalIdentityScope("alice@example.com", "acme");
    const second = sensitiveLocalIdentityScope("bob@example.com", "acme");
    expect(first).toMatch(/^[a-f0-9]{16}$/u);
    expect(second).toMatch(/^[a-f0-9]{16}$/u);
    expect(first).not.toBe(second);
    const firstKey = sensitiveLocalVaultKey("ai-prompts", first!);
    expect(firstKey).not.toContain("alice");
    expect(firstKey).not.toContain("acme");

    await saveSensitiveLocalData({
      identityScope: first,
      namespace: "ai-prompts",
      validate: validateItems,
      value: [{ id: "one", value: "private launch brief" }],
    });
    const otherIdentity = await loadSensitiveLocalData({
      identityScope: second,
      namespace: "ai-prompts",
      fallback: [] as SecretItem[],
      validate: validateItems,
    });
    expect(otherIdentity.value).toEqual([]);
    expect([...storage.values()].join("")).not.toContain(
      "private launch brief",
    );
  });

  it("purges ownership-ambiguous legacy plaintext without reading or adopting it", async () => {
    const scope = sensitiveLocalIdentityScope("alice", "workspace-1");
    const legacyKey = "legacy-sensitive-content";
    const tenantLegacyKey = "pw:tenant:workspace-1:legacy-sensitive-content";
    storage.set(
      legacyKey,
      JSON.stringify([{ id: "one", value: "reader@example.com" }]),
    );
    storage.set(
      tenantLegacyKey,
      JSON.stringify([{ id: "two", value: "other-reader@example.com" }]),
    );
    const readKeys: string[] = [];
    window.localStorage.getItem = (key: string) => {
      readKeys.push(key);
      return storage.get(key) ?? null;
    };

    const loaded = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      fallback: [] as SecretItem[],
      validate: validateItems,
      unownedLegacyKeys: [legacyKey],
      unownedTenantLegacySuffixes: ["legacy-sensitive-content"],
    });

    expect(loaded).toMatchObject({ state: "ready", value: [] });
    expect(loaded.warning).toContain("removed without importing");
    expect(readKeys).not.toContain(legacyKey);
    expect(readKeys).not.toContain(tenantLegacyKey);
    expect(storage.has(legacyKey)).toBe(false);
    expect(storage.has(tenantLegacyKey)).toBe(false);
    expect([...storage.values()].join("")).not.toContain("reader@example.com");
  });

  it("fails closed and offers recovery when an ambiguous legacy key cannot be removed", async () => {
    const scope = sensitiveLocalIdentityScope("alice", "workspace-1");
    const legacyKey = "legacy-removal-blocked";
    storage.set(
      legacyKey,
      JSON.stringify([{ id: "one", value: "do not adopt me" }]),
    );
    const originalRemove = window.localStorage.removeItem.bind(
      window.localStorage,
    );
    window.localStorage.removeItem = (key: string) => {
      if (key === legacyKey) throw new DOMException("Blocked", "SecurityError");
      originalRemove(key);
    };

    const loaded = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-prompts",
      fallback: [] as SecretItem[],
      validate: validateItems,
      unownedLegacyKeys: [legacyKey],
    });

    expect(loaded.value).toEqual([]);
    expect(loaded.retryable).toBe(true);
    expect(loaded.warning).toContain("could not be removed");
    expect(storage.has(legacyKey)).toBe(true);
    expect(storage.size).toBe(1);
  });

  it("repairs bounded encrypted records and discards malformed encrypted records", async () => {
    const scope = sensitiveLocalIdentityScope("alice", "workspace-1");
    const key = sensitiveLocalVaultKey("webhook-fixtures", scope!);
    await vaultSetJSON(key, {
      version: 1,
      value: [
        { id: "valid", value: "bounded" },
        { id: "oversized", value: "x".repeat(201) },
        { id: 42, value: "malformed" },
      ],
    });

    const repaired = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "webhook-fixtures",
      fallback: [] as SecretItem[],
      validate: validateItems,
    });

    expect(repaired.value).toEqual([{ id: "valid", value: "bounded" }]);
    expect(repaired.warning).toContain("omitted");
    expect(await vaultGetJSON(key)).toEqual({
      version: 1,
      value: [{ id: "valid", value: "bounded" }],
    });

    await vaultSetJSON(key, { version: 999, value: [] });
    const malformed = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "webhook-fixtures",
      fallback: [] as SecretItem[],
      validate: validateItems,
    });
    expect(malformed.value).toEqual([]);
    expect(malformed.warning).toContain("malformed");
    expect(await vaultGetJSON(key)).toBeNull();
  });

  it("recovers a failed encrypted save without ever falling back to plaintext", async () => {
    const scope = sensitiveLocalIdentityScope("alice", "workspace-1");
    const originalSet = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };

    await expect(
      saveSensitiveLocalData({
        identityScope: scope,
        namespace: "ai-prompts",
        validate: validateItems,
        value: [{ id: "one", value: "keep me safely" }],
      }),
    ).rejects.toThrow();
    expect([...storage.values()].join("")).not.toContain("keep me safely");

    window.localStorage.setItem = originalSet;
    await saveSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-prompts",
      validate: validateItems,
      value: [{ id: "one", value: "keep me safely" }],
    });
    const recovered = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-prompts",
      fallback: [] as SecretItem[],
      validate: validateItems,
    });
    expect(recovered).toMatchObject({
      state: "ready",
      value: [{ id: "one", value: "keep me safely" }],
    });
    expect([...storage.values()].join("")).not.toContain("keep me safely");
  });

  it("reports unavailable storage without replacing existing ciphertext", async () => {
    const scope = sensitiveLocalIdentityScope("alice", "workspace-1");
    await saveSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      validate: validateItems,
      value: [{ id: "one", value: "existing encrypted content" }],
    });
    const before = new Map(storage);
    window.localStorage.getItem = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };

    const loaded = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      fallback: [] as SecretItem[],
      validate: validateItems,
    });
    expect(loaded.state).toBe("unavailable");
    expect(storage).toEqual(before);
  });
});
