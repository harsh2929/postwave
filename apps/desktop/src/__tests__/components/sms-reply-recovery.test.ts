import { describe, expect, it, vi } from "vitest";

import { createSMSReplyRecoveryStore } from "../../components/sms/sms-reply-recovery";
import type { VaultReadResult } from "../../lib/secure-vault";

function memoryVault() {
  const values = new Map<string, unknown>();
  const quarantined = new Set<string>();
  return {
    values,
    quarantined,
    adapter: {
      read: async <T>(key: string): Promise<VaultReadResult<T>> =>
        values.has(key)
          ? { status: "ready", value: values.get(key) as T }
          : { status: "missing" },
      write: async (key: string, value: unknown): Promise<void> => {
        values.set(key, structuredClone(value));
      },
      remove: (key: string): void => {
        values.delete(key);
      },
      quarantineStatus: (key: string) =>
        quarantined.has(key) ? ("marked" as const) : ("clear" as const),
      markQuarantined: (key: string): boolean => {
        quarantined.add(key);
        return true;
      },
    },
  };
}

const input = {
  phone: "+12025550118",
  request: {
    sender_profile_id: "sender-example",
    list_id: "11111111-1111-4111-8111-111111111111",
    body: "Synthetic reply body 🔒",
  },
} as const;

describe("SMS encrypted reply intent recovery", () => {
  it("persists only a signature/key envelope and makes prepare one-shot", async () => {
    const vault = memoryVault();
    const store = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey: () => "intent-key-a",
      vault: vault.adapter,
    });

    const first = await store.prepare("identity-a", input);
    const second = await store.prepare("identity-a", input);
    expect(first).toMatchObject({
      status: "ready",
      idempotencyKey: "intent-key-a",
      recovered: false,
    });
    expect(second).toMatchObject({
      status: "held",
      idempotencyKey: "intent-key-a",
      reason: "outcome-unknown",
    });
    expect(JSON.stringify(Array.from(vault.values.values()))).not.toContain(
      input.request.body,
    );
  });

  it("holds every same-phone draft after restart with no replay or replacement-key path", async () => {
    const vault = memoryVault();
    const createKey = vi.fn(() => "original-intent-key");
    const firstRuntime = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey,
      vault: vault.adapter,
    });
    const prepared = await firstRuntime.prepare("identity-a", input);
    expect(prepared.status).toBe("ready");

    const restarted = createSMSReplyRecoveryStore({
      runtimeId: "runtime-b",
      createKey,
      vault: vault.adapter,
    });
    expect("resume" in restarted).toBe(false);
    expect("discard" in restarted).toBe(false);
    await expect(restarted.prepare("identity-a", input)).resolves.toMatchObject(
      {
        status: "held",
        reason: "recovered-after-restart",
        idempotencyKey: "original-intent-key",
      },
    );
    await expect(
      restarted.prepare("identity-a", {
        ...input,
        request: { ...input.request, body: "A different draft" },
      }),
    ).resolves.toMatchObject({
      status: "held",
      reason: "another-intent-pending",
      idempotencyKey: "original-intent-key",
    });
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it("retains unknown outcomes and isolates identities", async () => {
    const vault = memoryVault();
    const store = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey: () => "intent-key-a",
      vault: vault.adapter,
    });
    const prepared = await store.prepare("identity-a", input);
    if (prepared.status !== "ready") throw new Error("fixture did not prepare");
    await store.markUnknown("identity-a", prepared.signature);

    await expect(store.prepare("identity-a", input)).resolves.toMatchObject({
      status: "held",
      reason: "outcome-unknown",
      idempotencyKey: "intent-key-a",
    });
    await expect(store.list("identity-b")).resolves.toEqual({
      status: "ready",
      intents: [],
    });
    await store.settle("identity-a", prepared.signature);
    await expect(store.list("identity-a")).resolves.toEqual({
      status: "ready",
      intents: [],
    });
  });

  it("keeps >24h unknown intent held and clears only on authoritative persisted settlement", async () => {
    const vault = memoryVault();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const createKey = vi.fn(() => "durable-intent-key");
    const firstRuntime = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      now: () => now,
      createKey,
      vault: vault.adapter,
    });
    const prepared = await firstRuntime.prepare("identity-a", input);
    if (prepared.status !== "ready") throw new Error("fixture did not prepare");

    now += 45 * 24 * 60 * 60_000;
    const restarted = createSMSReplyRecoveryStore({
      runtimeId: "runtime-b",
      now: () => now,
      createKey,
      vault: vault.adapter,
    });
    expect("discard" in restarted).toBe(false);
    expect("resume" in restarted).toBe(false);
    await expect(restarted.prepare("identity-a", input)).resolves.toMatchObject(
      {
        status: "held",
        reason: "recovered-after-restart",
        idempotencyKey: "durable-intent-key",
      },
    );
    expect(createKey).toHaveBeenCalledTimes(1);

    expect(await restarted.markUnknown("identity-a", prepared.signature)).toBe(
      true,
    );
    now += 45 * 24 * 60 * 60_000;
    await expect(restarted.prepare("identity-a", input)).resolves.toMatchObject(
      {
        status: "held",
        reason: "outcome-unknown",
        idempotencyKey: "durable-intent-key",
      },
    );
    expect(await restarted.settle("identity-a", prepared.signature)).toBe(true);
    await expect(restarted.list("identity-a")).resolves.toEqual({
      status: "ready",
      intents: [],
    });
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it("durably holds key/request conflicts without permitting same-key replay", async () => {
    const vault = memoryVault();
    const store = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey: () => "conflicted-intent-key",
      vault: vault.adapter,
    });
    const prepared = await store.prepare("identity-a", input);
    if (prepared.status !== "ready") throw new Error("fixture did not prepare");

    expect(
      await store.markRequestIdentityConflict("identity-a", prepared.signature),
    ).toBe(true);
    await expect(store.prepare("identity-a", input)).resolves.toMatchObject({
      status: "held",
      reason: "request-identity-conflict",
      idempotencyKey: "conflicted-intent-key",
    });
    expect("resume" in store).toBe(false);
  });

  it("retains a new checkpoint when another phone intent is pending", async () => {
    const vault = memoryVault();
    const store = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey: () => "blocked-intent-key",
      vault: vault.adapter,
    });
    const prepared = await store.prepare("identity-a", input);
    if (prepared.status !== "ready") throw new Error("fixture did not prepare");

    expect(
      await store.markAnotherIntentPending("identity-a", prepared.signature),
    ).toBe(true);
    await expect(store.prepare("identity-a", input)).resolves.toMatchObject({
      status: "held",
      reason: "another-intent-pending",
      idempotencyKey: "blocked-intent-key",
    });
    await expect(store.list("identity-a")).resolves.toMatchObject({
      status: "ready",
      intents: [
        {
          state: "another-intent-pending",
          idempotencyKey: "blocked-intent-key",
        },
      ],
    });
  });

  it("fails closed when the encrypted vault is unavailable", async () => {
    const store = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey: () => "must-not-be-used",
      vault: {
        read: async () => ({ status: "unavailable" }),
        write: async () => {
          throw new Error("unavailable");
        },
        remove: () => undefined,
        quarantineStatus: () => "clear",
        markQuarantined: () => false,
      },
    });
    await expect(store.prepare("identity-a", input)).resolves.toMatchObject({
      status: "held",
      reason: "vault-unavailable",
    });
  });

  it("quarantines corrupt ciphertext so reload cannot mint a replacement key", async () => {
    const values = new Map<string, unknown>();
    const quarantined = new Set<string>();
    let firstRead = true;
    const createKey = vi.fn(() => "must-not-be-created");
    const adapter = {
      read: async <T>(key: string): Promise<VaultReadResult<T>> => {
        if (firstRead) {
          firstRead = false;
          return { status: "corrupt" };
        }
        return values.has(key)
          ? { status: "ready", value: values.get(key) as T }
          : { status: "missing" };
      },
      write: async (key: string, value: unknown): Promise<void> => {
        values.set(key, structuredClone(value));
      },
      remove: (key: string): void => {
        values.delete(key);
      },
      quarantineStatus: (key: string) =>
        quarantined.has(key) ? ("marked" as const) : ("clear" as const),
      markQuarantined: (key: string): boolean => {
        quarantined.add(key);
        return true;
      },
    };
    const firstRuntime = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey,
      vault: adapter,
    });
    await expect(firstRuntime.list("identity-a")).resolves.toEqual({
      status: "vault-corrupt",
    });
    expect(values.get("sms-reply-intents.identity-a")).toEqual({
      version: 1,
      quarantined: "corrupt-reply-intent-vault",
    });

    const restarted = createSMSReplyRecoveryStore({
      runtimeId: "runtime-b",
      createKey,
      vault: adapter,
    });
    await expect(restarted.prepare("identity-a", input)).resolves.toMatchObject(
      {
        status: "held",
        reason: "vault-corrupt",
      },
    );
    expect(createKey).not.toHaveBeenCalled();
  });

  it("keeps corruption held across reload when encrypted tombstone writing fails", async () => {
    const quarantined = new Set<string>();
    let firstRead = true;
    const createKey = vi.fn(() => "must-not-be-created");
    const adapter = {
      read: async <T>(): Promise<VaultReadResult<T>> => {
        if (firstRead) {
          firstRead = false;
          return { status: "corrupt" };
        }
        return { status: "missing" };
      },
      write: async (): Promise<void> => {
        throw new Error("keychain unavailable");
      },
      remove: (): void => undefined,
      quarantineStatus: (key: string) =>
        quarantined.has(key) ? ("marked" as const) : ("clear" as const),
      markQuarantined: (key: string): boolean => {
        quarantined.add(key);
        return true;
      },
    };

    const firstRuntime = createSMSReplyRecoveryStore({
      runtimeId: "runtime-a",
      createKey,
      vault: adapter,
    });
    await expect(
      firstRuntime.prepare("identity-a", input),
    ).resolves.toMatchObject({ status: "held", reason: "vault-corrupt" });

    const restarted = createSMSReplyRecoveryStore({
      runtimeId: "runtime-b",
      createKey,
      vault: adapter,
    });
    await expect(restarted.prepare("identity-a", input)).resolves.toMatchObject(
      { status: "held", reason: "vault-corrupt" },
    );
    expect(createKey).not.toHaveBeenCalled();
  });
});
