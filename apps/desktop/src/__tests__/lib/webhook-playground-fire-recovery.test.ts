// @vitest-environment happy-dom

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    read: vi.fn(
      async (
        key: string,
      ): Promise<
        | { status: "ready"; value: unknown }
        | { status: "missing" }
        | { status: "unavailable" }
        | { status: "corrupt" }
      > =>
        values.has(key)
          ? {
              status: "ready",
              value: structuredClone(values.get(key)),
            }
          : { status: "missing" },
    ),
    write: vi.fn(async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    }),
    remove: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
});

vi.mock("../../lib/secure-vault", () => ({
  vaultReadJSON: vault.read,
  vaultSetJSON: vault.write,
  vaultDelete: vault.remove,
}));

import {
  beginApiIdentityTransition,
  captureApiIdentityGeneration,
  releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests,
} from "../../lib/api-identity-transition";
import {
  createWebhookPlaygroundFireRecoveryAuthority,
  inspectWebhookPlaygroundFireRecoveryInventory,
  inspectWebhookPlaygroundFireRecoveryScopeInventory,
  webhookPlaygroundFireRecovery,
  type WebhookPlaygroundFireRecoveryAuthority,
  type WebhookPlaygroundFireSnapshot,
} from "../../lib/webhook-playground-fire-recovery";
import { deriveWebhookPlaygroundFireRecoveryScope } from "../../lib/webhook-playground-fire-recovery-scope";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const WEBHOOK = "33333333-3333-4333-8333-333333333333";
const FIRE = "018f0f9a-7b2c-7def-8abc-0123456789ab";
const API_BASE = "https://api.example.test/gateway";

const sessionMe = {
  credentialSource: "session" as const,
  tenant: TENANT,
  user: SESSION_USER,
  webhookPlaygroundRecoveryScope: "1".repeat(64),
};

const apiKeyMe = {
  credentialSource: "api-key" as const,
  credentialFingerprint: "a".repeat(64),
  tenant: TENANT,
  user: "human webhook-admin",
  webhookPlaygroundRecoveryScope: "2".repeat(64),
};

function authority(
  me: typeof sessionMe | typeof apiKeyMe = sessionMe,
  apiBaseUrl = API_BASE,
): WebhookPlaygroundFireRecoveryAuthority {
  const generation = captureApiIdentityGeneration();
  if (generation === null) throw new Error("identity transition in fixture");
  const result = createWebhookPlaygroundFireRecoveryAuthority(
    me,
    apiBaseUrl,
    generation,
  );
  if (!result) throw new Error("fixture authority was rejected");
  return result;
}

function snapshot(
  overrides: Partial<WebhookPlaygroundFireSnapshot> = {},
): WebhookPlaygroundFireSnapshot {
  return {
    fireId: FIRE,
    idempotencyKey: `webhook-playground:${FIRE}`,
    webhookId: WEBHOOK,
    expectedWebhookConfigVersion: 7,
    eventType: "campaign.sent",
    payloadJSON: '{"campaign_id":"campaign-42","nested":{"live":true}}',
    ...overrides,
  };
}

function payloadBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function storedSnapshot(value: WebhookPlaygroundFireSnapshot): unknown {
  const { payloadJSON, ...requestIdentity } = value;
  return {
    ...requestIdentity,
    payloadJSONBase64: payloadBase64(payloadJSON),
  };
}

function logicalStorageKey(
  recoveryAuthority: WebhookPlaygroundFireRecoveryAuthority,
): string {
  return `webhook-playground-fire-recovery.v1.${recoveryAuthority.scope}`;
}

function quarantineStorageKey(
  recoveryAuthority: WebhookPlaygroundFireRecoveryAuthority,
): string {
  return `postwave.webhook-playground-fire-recovery-quarantine.v1:${recoveryAuthority.scope}`;
}

beforeEach(() => {
  resetApiIdentityTransitionForTests();
  window.localStorage.clear();
  vault.values.clear();
  vault.read.mockReset();
  vault.write.mockReset();
  vault.remove.mockReset();
  vault.read.mockImplementation(async (key: string) =>
    vault.values.has(key)
      ? ({
          status: "ready",
          value: structuredClone(vault.values.get(key)),
        } as const)
      : ({ status: "missing" } as const),
  );
  vault.write.mockImplementation(async (key: string, value: unknown) => {
    vault.values.set(key, structuredClone(value));
  });
  vault.remove.mockImplementation((key: string) => {
    vault.values.delete(key);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("webhook playground encrypted fire recovery", () => {
  it("round-trips one exact checkpoint through the secure vault", async () => {
    const recoveryAuthority = authority();
    const exactPayloadJSON = `{
  "large_integer": 9007199254740993,
  "campaign_id": "campaign-42"
}`;
    const input = snapshot({ payloadJSON: exactPayloadJSON });

    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, input),
    ).resolves.toEqual({ status: "ready", snapshot: input });
    expect(vault.write).toHaveBeenCalledTimes(1);
    expect(vault.write).toHaveBeenCalledWith(
      logicalStorageKey(recoveryAuthority),
      {
        version: 1,
        scope: recoveryAuthority.scope,
        snapshot: storedSnapshot(input),
      },
    );
    expect(vault.read).toHaveBeenLastCalledWith(
      logicalStorageKey(recoveryAuthority),
      { preserveCorrupt: true },
    );
    expect(window.localStorage.length).toBe(0);

    const loaded = await webhookPlaygroundFireRecovery.load(recoveryAuthority);
    expect(loaded).toEqual({
      status: "ready",
      snapshot: input,
    });
    if (loaded.status !== "ready") throw new Error("checkpoint was not loaded");
    expect(loaded.snapshot.payloadJSON).toBe(exactPayloadJSON);
    expect(loaded.snapshot.payloadJSON).toContain("9007199254740993");
    expect(JSON.stringify(vault.write.mock.calls[0]?.[1])).not.toContain(
      "9007199254740993",
    );
  });

  it("domain-separates session and exact API-key credentials by source and canonical API base", () => {
    const session = authority();
    const sameCanonicalSession = authority(
      sessionMe,
      "https://API.EXAMPLE.test:443/gateway/",
    );
    const apiKey = authority(apiKeyMe);
    const otherApiKey = authority({
      ...apiKeyMe,
      credentialFingerprint: "b".repeat(64),
      webhookPlaygroundRecoveryScope: "3".repeat(64),
    });
    const otherPath = authority(
      { ...sessionMe, webhookPlaygroundRecoveryScope: "4".repeat(64) },
      "https://api.example.test/other",
    );

    expect(session.scope).toMatch(/^v1-session-[0-9a-f]{64}$/u);
    expect(apiKey.scope).toMatch(/^v1-api-key-[0-9a-f]{64}$/u);
    expect(sameCanonicalSession.scope).toBe(session.scope);
    expect(apiKey.scope).not.toBe(session.scope);
    expect(otherApiKey.scope).not.toBe(apiKey.scope);
    expect(otherPath.scope).not.toBe(session.scope);
    expect(session.apiBaseUrl).toBe(API_BASE);
    expect(apiKey.principal).toBe(apiKeyMe.credentialFingerprint);
    expect(otherApiKey.principal).toBe("b".repeat(64));
    expect(
      createWebhookPlaygroundFireRecoveryAuthority(
        { ...sessionMe, user: "SESSION-USER" },
        API_BASE,
        0,
      ),
    ).toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority(
        { ...apiKeyMe, credentialFingerprint: null },
        API_BASE,
        0,
      ),
    ).toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority(
        { ...apiKeyMe, credentialFingerprint: "a".repeat(63) },
        API_BASE,
        0,
      ),
    ).toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority(
        {
          ...apiKeyMe,
          credentialFingerprint: `api-credential:sha256:${"c".repeat(64)}`,
        },
        API_BASE,
        0,
      ),
    ).not.toBeNull();
    expect(
      createWebhookPlaygroundFireRecoveryAuthority(
        { ...apiKeyMe, webhookPlaygroundRecoveryScope: null },
        API_BASE,
        0,
      ),
    ).toBeNull();
  });

  it("derives collision-resistant scopes from the exact session or API-key principal", async () => {
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    const first = await deriveWebhookPlaygroundFireRecoveryScope({
      apiBaseUrl: API_BASE,
      credentialSource: "api-key",
      principal: "a".repeat(64),
      tenant: TENANT,
    });
    const second = await deriveWebhookPlaygroundFireRecoveryScope({
      apiBaseUrl: API_BASE,
      credentialSource: "api-key",
      principal: "b".repeat(64),
      tenant: TENANT,
    });
    const session = await deriveWebhookPlaygroundFireRecoveryScope({
      apiBaseUrl: API_BASE,
      credentialSource: "session",
      principal: SESSION_USER,
      tenant: TENANT,
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(second).toMatch(/^[a-f0-9]{64}$/u);
    expect(session).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set([first, second, session]).size).toBe(3);
  });

  it("round-trips an API-key Me checkpoint with an exact opaque Unicode idempotency key", async () => {
    const apiKeyAuthority = authority(apiKeyMe);
    const sessionAuthority = authority(sessionMe);
    const exact = snapshot({ idempotencyKey: "opaque-fire-key-🔒" });

    await expect(
      webhookPlaygroundFireRecovery.prepare(apiKeyAuthority, exact),
    ).resolves.toEqual({ status: "ready", snapshot: exact });
    await expect(
      webhookPlaygroundFireRecovery.load(apiKeyAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: exact });
    await expect(
      webhookPlaygroundFireRecovery.load(sessionAuthority),
    ).resolves.toEqual({ status: "clear" });
  });

  it("requires the current API identity generation at creation and every operation", async () => {
    const original = authority();
    const transition = beginApiIdentityTransition();

    expect(
      createWebhookPlaygroundFireRecoveryAuthority(sessionMe, API_BASE, 0),
    ).toBeNull();
    await expect(webhookPlaygroundFireRecovery.load(original)).resolves.toEqual(
      { status: "held", reason: "identity-changed" },
    );

    releaseApiIdentityTransition(transition);
    const current = authority();
    expect(current.apiIdentityGeneration).toBe(1);
    await expect(webhookPlaygroundFireRecovery.load(current)).resolves.toEqual({
      status: "clear",
    });
  });

  it("isolates authorities and quarantines an envelope placed under the wrong scope", async () => {
    const first = authority();
    const second = authority(
      { ...sessionMe, webhookPlaygroundRecoveryScope: "5".repeat(64) },
      "https://staging.example.test/gateway",
    );
    const exact = snapshot();
    vault.values.set(logicalStorageKey(second), {
      version: 1,
      scope: first.scope,
      snapshot: storedSnapshot(exact),
    });

    await expect(webhookPlaygroundFireRecovery.load(first)).resolves.toEqual({
      status: "clear",
    });
    await expect(webhookPlaygroundFireRecovery.load(second)).resolves.toEqual({
      status: "held",
      reason: "vault-corrupt",
    });
    expect(vault.values.has(logicalStorageKey(second))).toBe(true);
    expect(window.localStorage.getItem(quarantineStorageKey(second))).toBe("1");
    expect(vault.remove).not.toHaveBeenCalled();
  });

  it("fails closed when any foreign encrypted recovery artifact survives", async () => {
    const current = authority();
    const foreign = authority({
      ...sessionMe,
      webhookPlaygroundRecoveryScope: "6".repeat(64),
    });
    window.localStorage.setItem(
      `postwave.desktop.vault.v1:${logicalStorageKey(foreign)}`,
      "foreign-ciphertext",
    );

    await expect(webhookPlaygroundFireRecovery.load(current)).resolves.toEqual({
      status: "held",
      reason: "foreign-checkpoint",
    });
    await expect(
      webhookPlaygroundFireRecovery.prepare(current, snapshot()),
    ).resolves.toEqual({ status: "held", reason: "foreign-checkpoint" });
    expect(vault.write).not.toHaveBeenCalled();

    vault.values.set(logicalStorageKey(current), {
      version: 1,
      scope: current.scope,
      snapshot: storedSnapshot(snapshot()),
    });
    await expect(
      webhookPlaygroundFireRecovery.settle(current, snapshot()),
    ).resolves.toEqual({ status: "held", reason: "foreign-checkpoint" });
    expect(vault.remove).not.toHaveBeenCalled();
    expect(vault.values.has(logicalStorageKey(current))).toBe(true);
  });

  it("holds both an existing exact checkpoint and a differing checkpoint without overwrite", async () => {
    const recoveryAuthority = authority();
    const first = snapshot();
    await webhookPlaygroundFireRecovery.prepare(recoveryAuthority, first);
    vault.write.mockClear();

    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, first),
    ).resolves.toEqual({ status: "held", reason: "checkpoint-exists" });
    await expect(
      webhookPlaygroundFireRecovery.prepare(
        recoveryAuthority,
        snapshot({ eventType: "subscriber.added" }),
      ),
    ).resolves.toEqual({ status: "held", reason: "checkpoint-conflict" });
    expect(vault.write).not.toHaveBeenCalled();
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: first });
  });

  it("serializes concurrent preparation so only one checkpoint can win", async () => {
    const recoveryAuthority = authority();
    const first = snapshot();
    const second = snapshot({ eventType: "subscriber.added" });

    const results = await Promise.all([
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, first),
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, second),
    ]);

    expect(results).toEqual([
      { status: "ready", snapshot: first },
      { status: "held", reason: "checkpoint-conflict" },
    ]);
    expect(vault.write).toHaveBeenCalledTimes(1);
  });

  it("fails closed when vault reads or writes are unavailable", async () => {
    const recoveryAuthority = authority();
    vault.read.mockResolvedValue({ status: "unavailable" });

    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, snapshot()),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
    await expect(
      webhookPlaygroundFireRecovery.settle(recoveryAuthority, snapshot()),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });

    vault.read.mockResolvedValue({ status: "missing" });
    vault.write.mockRejectedValue(new Error("keychain locked"));
    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, snapshot()),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
  });

  it("preserves corrupt ciphertext and durably quarantines its opaque scope", async () => {
    const recoveryAuthority = authority();
    vault.read.mockResolvedValueOnce({ status: "corrupt" });

    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.read).toHaveBeenCalledWith(
      logicalStorageKey(recoveryAuthority),
      { preserveCorrupt: true },
    );
    expect(vault.remove).not.toHaveBeenCalled();
    expect(
      window.localStorage.getItem(quarantineStorageKey(recoveryAuthority)),
    ).toBe("1");
    expect(quarantineStorageKey(recoveryAuthority)).not.toContain(FIRE);
    expect(quarantineStorageKey(recoveryAuthority)).not.toContain(
      "campaign-42",
    );

    vault.read.mockClear();
    vault.read.mockResolvedValue({ status: "missing" });
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.read).not.toHaveBeenCalled();
  });

  it("fails closed when corrupt evidence cannot be durably quarantined", async () => {
    const recoveryAuthority = authority();
    vault.read.mockResolvedValue({ status: "corrupt" });
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });

    try {
      await expect(
        webhookPlaygroundFireRecovery.load(recoveryAuthority),
      ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
      expect(vault.remove).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });

  it("quarantines decrypted envelopes with malformed snapshot data", async () => {
    const recoveryAuthority = authority();
    vault.values.set(logicalStorageKey(recoveryAuthority), {
      version: 1,
      scope: recoveryAuthority.scope,
      snapshot: storedSnapshot(snapshot({ fireId: FIRE.toUpperCase() })),
    });

    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "held", reason: "vault-corrupt" });
    expect(vault.values.has(logicalStorageKey(recoveryAuthority))).toBe(true);
    expect(
      window.localStorage.getItem(quarantineStorageKey(recoveryAuthority)),
    ).toBe("1");
  });

  it.each([
    ["non-canonical fire UUID", snapshot({ fireId: FIRE.toUpperCase() })],
    ["non-canonical webhook UUID", snapshot({ webhookId: "webhook-1" })],
    ["blank idempotency key", snapshot({ idempotencyKey: "" })],
    [
      "trimmed idempotency key",
      snapshot({ idempotencyKey: " key-with-space" }),
    ],
    [
      "control-bearing idempotency key",
      snapshot({ idempotencyKey: "key\u0000value" }),
    ],
    [
      "oversized idempotency key",
      snapshot({ idempotencyKey: "k".repeat(256) }),
    ],
    ["ill-formed idempotency key", snapshot({ idempotencyKey: "key-\ud800" })],
    ["invalid webhook revision", snapshot({ expectedWebhookConfigVersion: 0 })],
    [
      "fractional webhook revision",
      snapshot({ expectedWebhookConfigVersion: 1.5 }),
    ],
    [
      "unsafe webhook revision",
      snapshot({
        expectedWebhookConfigVersion: Number.MAX_SAFE_INTEGER + 1,
      }),
    ],
    ["invalid event token", snapshot({ eventType: "subscriber/created" })],
    ["trimmed event token", snapshot({ eventType: " subscriber.created" })],
    ["oversized event token", snapshot({ eventType: "a".repeat(201) })],
    ["empty payload JSON", snapshot({ payloadJSON: "   " })],
    ["malformed payload JSON", snapshot({ payloadJSON: '{"broken":' })],
    ["array payload JSON", snapshot({ payloadJSON: "[]" })],
    ["primitive payload JSON", snapshot({ payloadJSON: "42" })],
    [
      "duplicate payload member",
      snapshot({ payloadJSON: '{"member":1,"member":2}' }),
    ],
    [
      "nested escape-equivalent duplicate payload member",
      snapshot({
        payloadJSON: String.raw`{"nested":{"a":1,"\u0061":2}}`,
      }),
    ],
    [
      "ill-formed payload JSON text",
      snapshot({ payloadJSON: `{"value":"${"\ud800"}"}` }),
    ],
  ])("rejects a %s before reading or writing", async (_label, invalid) => {
    const recoveryAuthority = authority();

    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, invalid),
    ).resolves.toEqual({ status: "held", reason: "snapshot-invalid" });
    expect(vault.read).not.toHaveBeenCalled();
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("rejects unknown snapshot fields, oversized payload text, and excessive JSON complexity", async () => {
    const recoveryAuthority = authority();
    let deep: Record<string, unknown> = { end: true };
    for (let index = 0; index < 25; index += 1) deep = { child: deep };
    const withExtraField = {
      ...snapshot(),
      retryAutomatically: true,
    } as WebhookPlaygroundFireSnapshot;

    for (const invalid of [
      snapshot({ payloadJSON: `${" ".repeat(262_143)}{}` }),
      snapshot({ payloadJSON: JSON.stringify(deep) }),
      withExtraField,
    ]) {
      await expect(
        webhookPlaygroundFireRecovery.prepare(recoveryAuthority, invalid),
      ).resolves.toEqual({ status: "held", reason: "snapshot-invalid" });
    }
    expect(vault.read).not.toHaveBeenCalled();
    expect(vault.write).not.toHaveBeenCalled();
  });

  it("accepts the exact payload byte ceiling and a historical canonical event token", async () => {
    const recoveryAuthority = authority();
    const exactPayloadJSON = `${" ".repeat(262_142)}{}`;
    const historical = snapshot({
      eventType: "future.catalog-event_v2",
      payloadJSON: exactPayloadJSON,
    });

    await expect(
      webhookPlaygroundFireRecovery.prepare(recoveryAuthority, historical),
    ).resolves.toEqual({ status: "ready", snapshot: historical });
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: historical });
    expect(
      new TextEncoder().encode(JSON.stringify(vault.write.mock.calls[0]?.[1]))
        .byteLength,
    ).toBeLessThanOrEqual(512 * 1024);
  });

  it("deletes only a checkpoint matching the complete exact snapshot", async () => {
    const recoveryAuthority = authority();
    const exact = snapshot();
    await webhookPlaygroundFireRecovery.prepare(recoveryAuthority, exact);
    vault.remove.mockClear();

    await expect(
      webhookPlaygroundFireRecovery.settle(
        recoveryAuthority,
        snapshot({ payloadJSON: '{"campaign_id":"changed"}' }),
      ),
    ).resolves.toEqual({ status: "held", reason: "checkpoint-mismatch" });
    expect(vault.remove).not.toHaveBeenCalled();
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: exact });

    await expect(
      webhookPlaygroundFireRecovery.settle(recoveryAuthority, exact),
    ).resolves.toEqual({ status: "cleared" });
    expect(vault.remove).toHaveBeenCalledTimes(1);
    expect(vault.remove).toHaveBeenCalledWith(
      logicalStorageKey(recoveryAuthority),
    );
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "clear" });
    await expect(
      webhookPlaygroundFireRecovery.settle(recoveryAuthority, exact),
    ).resolves.toEqual({ status: "clear" });
  });

  it("keeps a matching checkpoint held when deletion storage is unavailable", async () => {
    const recoveryAuthority = authority();
    const exact = snapshot();
    await webhookPlaygroundFireRecovery.prepare(recoveryAuthority, exact);
    vault.remove.mockImplementation(() => {
      throw new Error("storage denied");
    });

    await expect(
      webhookPlaygroundFireRecovery.settle(recoveryAuthority, exact),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: exact });
  });

  it("keeps a matching checkpoint held when deletion falsely reports success", async () => {
    const recoveryAuthority = authority();
    const exact = snapshot();
    await webhookPlaygroundFireRecovery.prepare(recoveryAuthority, exact);
    vault.remove.mockImplementation(() => undefined);

    await expect(
      webhookPlaygroundFireRecovery.settle(recoveryAuthority, exact),
    ).resolves.toEqual({ status: "held", reason: "vault-unavailable" });
    await expect(
      webhookPlaygroundFireRecovery.load(recoveryAuthority),
    ).resolves.toEqual({ status: "ready", snapshot: exact });
  });

  it("reports process-wide encrypted and quarantine inventory without reading content", () => {
    expect(inspectWebhookPlaygroundFireRecoveryInventory()).toBe("clear");
    window.localStorage.setItem(
      `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-session-${"a".repeat(64)}`,
      "ciphertext",
    );
    expect(inspectWebhookPlaygroundFireRecoveryInventory()).toBe("held");

    window.localStorage.clear();
    window.localStorage.setItem(
      `postwave.webhook-playground-fire-recovery-quarantine.v1:v1-api-key-${"b".repeat(64)}`,
      "1",
    );
    expect(inspectWebhookPlaygroundFireRecoveryInventory()).toBe("held");

    window.localStorage.clear();
    window.localStorage.setItem(
      "postwave.desktop.vault.v1:unrelated-cache",
      "ciphertext",
    );
    expect(inspectWebhookPlaygroundFireRecoveryInventory()).toBe("clear");
  });

  it("classifies current, foreign, and mixed evidence by exact strong scope", () => {
    const currentScope = `v1-session-${"a".repeat(64)}`;
    const foreignScope = `v1-api-key-${"b".repeat(64)}`;
    const encryptedKey = (scope: string) =>
      `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.${scope}`;

    expect(
      inspectWebhookPlaygroundFireRecoveryScopeInventory(currentScope),
    ).toBe("clear");
    window.localStorage.setItem(encryptedKey(currentScope), "ciphertext");
    expect(
      inspectWebhookPlaygroundFireRecoveryScopeInventory(currentScope),
    ).toBe("current");
    window.localStorage.setItem(encryptedKey(foreignScope), "ciphertext");
    expect(
      inspectWebhookPlaygroundFireRecoveryScopeInventory(currentScope),
    ).toBe("mixed");
    window.localStorage.removeItem(encryptedKey(currentScope));
    expect(
      inspectWebhookPlaygroundFireRecoveryScopeInventory(currentScope),
    ).toBe("foreign");
  });

  it("reports inventory unavailable when local storage cannot be enumerated", () => {
    window.localStorage.setItem("enumeration-sentinel", "1");
    vi.spyOn(window.localStorage, "key").mockImplementation(() => {
      throw new Error("storage denied");
    });

    expect(inspectWebhookPlaygroundFireRecoveryInventory()).toBe("unavailable");
  });
});
