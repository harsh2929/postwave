// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearCampaignTemplateDesignPendingMutation,
  prepareCampaignTemplateDesignMutation,
  readCampaignTemplateDesignPendingMutation,
} from "../../lib/campaign-template-design-mutation-recovery";

const SCOPE = "0123456789abcdef";
const OTHER_SCOPE = "fedcba9876543210";
const STORAGE_KEY = `postwave.template-design-mutation.v1.${SCOPE}`;
const NOW = Date.parse("2026-07-30T00:00:00Z");

beforeEach(() => vi.setSystemTime(NOW));
afterEach(() => vi.useRealTimers());

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("campaign template design mutation recovery", () => {
  it("reuses the same durable key after a cold restart for the exact payload", async () => {
    const storage = memoryStorage();
    const payload = {
      design_id: "design-1",
      revision: 3,
      output_hash: "a".repeat(64),
      name: "Monthly update",
    };
    const first = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "save",
      payload,
      () => "save-key-one",
      storage,
      NOW,
    );
    expect(first).toMatchObject({
      ok: true,
      reused: false,
      mutation: {
        operation: "save",
        payload,
        key: "save-key-one",
      },
    });

    const mintReplacement = vi.fn(() => "must-not-be-used");
    const afterRestart = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "save",
      { ...payload },
      mintReplacement,
      storage,
      NOW + 60_000,
    );
    expect(afterRestart).toMatchObject({
      ok: true,
      reused: true,
      mutation: { key: "save-key-one" },
    });
    expect(mintReplacement).not.toHaveBeenCalled();
    await expect(
      readCampaignTemplateDesignPendingMutation(SCOPE, storage, NOW + 60_000),
    ).resolves.toMatchObject({
      state: "ready",
      mutation: { key: "save-key-one", payload },
    });
  });

  it("isolates workspaces and refuses to overwrite a different pending action", async () => {
    const storage = memoryStorage();
    const first = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "refine",
      {
        design_id: "design-1",
        instructions: "Use a warmer intro",
        base_revision: 2,
      },
      () => "refine-key",
      storage,
      NOW,
    );
    expect(first.ok).toBe(true);

    await expect(
      readCampaignTemplateDesignPendingMutation(OTHER_SCOPE, storage, NOW),
    ).resolves.toEqual({ state: "empty" });
    await expect(
      prepareCampaignTemplateDesignMutation(
        SCOPE,
        "retry",
        { design_id: "design-1", attempt_count: 1 },
        () => "retry-key",
        storage,
        NOW,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "pending-mutation-conflict",
    });
    expect(storage.getItem(STORAGE_KEY)).toContain("refine-key");
  });

  it("clears only the exact acknowledged fingerprint and key", async () => {
    const storage = memoryStorage();
    const prepared = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "create-campaign",
      {
        design_id: "design-1",
        revision: 4,
        output_hash: "b".repeat(64),
      },
      () => "campaign-key",
      storage,
      NOW,
    );
    if (!prepared.ok) throw new Error("expected a pending mutation");

    await expect(
      clearCampaignTemplateDesignPendingMutation(
        SCOPE,
        { ...prepared.mutation, key: "different-key" },
        storage,
      ),
    ).resolves.toBe(false);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
    await expect(
      clearCampaignTemplateDesignPendingMutation(
        SCOPE,
        prepared.mutation,
        storage,
      ),
    ).resolves.toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("fails closed for malformed, tampered, oversized, and unavailable storage", async () => {
    const storage = memoryStorage();
    storage.setItem(STORAGE_KEY, "{broken");
    await expect(
      readCampaignTemplateDesignPendingMutation(SCOPE, storage, NOW),
    ).resolves.toEqual({ state: "invalid" });
    await expect(
      prepareCampaignTemplateDesignMutation(
        SCOPE,
        "retry",
        { design_id: "design-1", attempt_count: 1 },
        () => "new-key",
        storage,
        NOW,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "recovery-record-invalid",
    });
    expect(storage.getItem(STORAGE_KEY)).toBe("{broken");

    storage.setItem(STORAGE_KEY, "x".repeat(64 * 1_024 + 1));
    await expect(
      readCampaignTemplateDesignPendingMutation(SCOPE, storage, NOW),
    ).resolves.toEqual({ state: "invalid" });

    const unavailable = {
      getItem: () => {
        throw new Error("disabled");
      },
      removeItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
    };
    await expect(
      prepareCampaignTemplateDesignMutation(
        SCOPE,
        "save",
        { design_id: "design-1", revision: 1 },
        () => "save-key",
        unavailable,
        NOW,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "storage-unavailable",
    });
  });

  it("encrypts authored mutation payloads in the production vault", async () => {
    window.localStorage.clear();
    const prepared = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "save",
      {
        design_id: "design-1",
        revision: 1,
        output_hash: "c".repeat(64),
        name: "Confidential board update",
        subject: "Private quarterly numbers",
      },
      () => "encrypted-save-key",
      undefined,
      NOW,
    );
    expect(prepared.ok).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    const envelope = window.localStorage.getItem(
      `postwave.desktop.vault.v1:${STORAGE_KEY}`,
    );
    expect(envelope).not.toBeNull();
    expect(envelope).not.toContain("Confidential board update");
    expect(envelope).not.toContain("Private quarterly numbers");
    await expect(
      readCampaignTemplateDesignPendingMutation(SCOPE, undefined, NOW + 60_000),
    ).resolves.toMatchObject({
      state: "ready",
      mutation: { key: "encrypted-save-key" },
    });
  });

  it("keeps a non-sensitive tombstone after corrupt ciphertext is removed", async () => {
    window.localStorage.clear();
    const prepared = await prepareCampaignTemplateDesignMutation(
      SCOPE,
      "save",
      {
        design_id: "design-1",
        revision: 2,
        output_hash: "d".repeat(64),
        subject: "Confidential recovery subject",
      },
      () => "corrupt-save-key",
      undefined,
      NOW,
    );
    if (!prepared.ok) throw new Error("expected an encrypted checkpoint");

    const envelopeKey = `postwave.desktop.vault.v1:${STORAGE_KEY}`;
    window.localStorage.setItem(envelopeKey, "{broken");
    await expect(
      readCampaignTemplateDesignPendingMutation(SCOPE, undefined, NOW + 1),
    ).resolves.toEqual({ state: "invalid" });
    expect(window.localStorage.getItem(envelopeKey)).toBeNull();
    expect(window.localStorage.getItem(`${STORAGE_KEY}.invalid`)).toBe("1");
    expect(window.localStorage.getItem(`${STORAGE_KEY}.invalid`)).not.toContain(
      "Confidential recovery subject",
    );

    const mintReplacement = vi.fn(() => "must-not-be-used");
    await expect(
      prepareCampaignTemplateDesignMutation(
        SCOPE,
        "save",
        {
          design_id: "design-1",
          revision: 2,
          output_hash: "d".repeat(64),
          subject: "Confidential recovery subject",
        },
        mintReplacement,
        undefined,
        NOW + 2,
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "recovery-record-invalid",
    });
    expect(mintReplacement).not.toHaveBeenCalled();
    await expect(
      clearCampaignTemplateDesignPendingMutation(SCOPE, prepared.mutation),
    ).resolves.toBe(false);
  });
});
