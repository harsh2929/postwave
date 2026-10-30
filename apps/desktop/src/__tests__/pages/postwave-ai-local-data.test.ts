import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sanitizeChatHistory } from "../../hooks/useEncryptedChatHistory";
import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  sensitiveLocalIdentityScope,
} from "../../lib/sensitive-local-data";

describe("Moosewave AI encrypted chat history", () => {
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

  it("drops malformed, duplicate, streaming, and oversized message data", () => {
    const sanitized = sanitizeChatHistory([
      {
        id: "message-1",
        role: "user",
        content: "Plan the private launch",
        createdAt: 1,
        streaming: true,
      },
      {
        id: "message-1",
        role: "assistant",
        content: "duplicate",
        createdAt: 2,
      },
      {
        id: "message-oversized",
        role: "assistant",
        content: "x".repeat(200_001),
        createdAt: 3,
      },
      { id: "bad-role", role: "system", content: "ignore", createdAt: 4 },
    ]);

    expect(sanitized?.altered).toBe(true);
    expect(sanitized?.value).toEqual([
      {
        id: "message-1",
        role: "user",
        content: "Plan the private launch",
        createdAt: 1,
      },
    ]);
  });

  it("preserves bounded terminal detail for interrupted partial responses", () => {
    const sanitized = sanitizeChatHistory([
      {
        id: "assistant-partial",
        role: "assistant",
        content: "A useful partial answer",
        createdAt: 2,
        errored: true,
        errorMessage: "The connection ended before completion.",
      },
      {
        id: "assistant-bounded",
        role: "assistant",
        content: "No unsafe detail",
        createdAt: 3,
        errored: true,
        errorMessage: "x".repeat(1_001),
      },
    ]);

    expect(sanitized?.value[0]).toMatchObject({
      content: "A useful partial answer",
      errored: true,
      errorMessage: "The connection ended before completion.",
    });
    expect(sanitized?.value[1]).not.toHaveProperty("errorMessage");
    expect(sanitized?.altered).toBe(true);
  });

  it("round-trips chat content without leaving plaintext at rest", async () => {
    const scope = sensitiveLocalIdentityScope("writer-1", "workspace-1");
    const messages = [
      {
        id: "message-1",
        role: "user" as const,
        content: "Confidential acquisition plan for reader@example.com",
        createdAt: 1,
      },
    ];
    await saveSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      validate: sanitizeChatHistory,
      value: messages,
    });

    expect([...storage.values()].join("")).not.toContain("acquisition plan");
    expect([...storage.values()].join("")).not.toContain("reader@example.com");
    const loaded = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      fallback: [],
      validate: sanitizeChatHistory,
    });
    expect(loaded.value).toEqual(messages);
  });

  it("purges global and tenant-only chat history without adopting either", async () => {
    const scope = sensitiveLocalIdentityScope("writer-2", "workspace-1");
    const globalKey = "chat-history.v1";
    const tenantKey = "pw:tenant:workspace-1:chat-history.v1";
    const unownedMessage = {
      id: "unowned-message",
      role: "user" as const,
      content: "Previous account confidential launch plan",
      createdAt: 1,
    };
    storage.set(globalKey, JSON.stringify([unownedMessage]));
    storage.set(tenantKey, JSON.stringify([unownedMessage]));

    const loaded = await loadSensitiveLocalData({
      identityScope: scope,
      namespace: "ai-chat",
      fallback: [],
      validate: sanitizeChatHistory,
      unownedLegacyKeys: [globalKey],
      unownedTenantLegacySuffixes: [globalKey],
    });

    expect(loaded.value).toEqual([]);
    expect(loaded.warning).toContain("removed without importing");
    expect(storage.has(globalKey)).toBe(false);
    expect(storage.has(tenantKey)).toBe(false);
    expect([...storage.values()].join("")).not.toContain(
      "confidential launch plan",
    );
  });
});
