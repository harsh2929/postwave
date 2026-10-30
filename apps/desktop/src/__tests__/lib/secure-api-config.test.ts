import { webcrypto } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: {
    configured: false,
    baseUrl: null as string | null,
    credentialFingerprint: null as string | null,
  },
  initializeApiBroker: vi.fn(),
  initializeSessionBroker: vi.fn(),
  configureApiBroker: vi.fn(),
  reconcilePendingWorkspaceSwitch: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    initializeApiBroker: h.initializeApiBroker,
    initializeSessionBroker: h.initializeSessionBroker,
    configureApiBroker: h.configureApiBroker,
    apiBrokerStatus: () => ({ ...h.status }),
  },
}));

vi.mock("../../lib/workspaces", () => ({
  reconcilePendingWorkspaceSwitch: h.reconcilePendingWorkspaceSwitch,
}));

import {
  getApiKey,
  hasLocalNativeApiCredential,
  hydrateSecureApiConfig,
  invalidateApiUrlCache,
  rememberSession,
  SecureCredentialStorageError,
  setApiConfig,
} from "../../lib/api-client";
import { subscribeApiAuthority } from "../../lib/api-authority";
import {
  apiIdentityGenerationIsCurrent,
  captureApiIdentityGeneration,
  resetApiIdentityTransitionForTests,
} from "../../lib/api-identity-transition";
import { offlineQueueIdle } from "../../lib/offline-store";
import { credentialIdentityHash } from "../../lib/secure-api-key";
import { resetWebhookPlaygroundFireOperationExclusionForTests } from "../../lib/webhook-playground-fire-operation";
import {
  registerVerifiedWebhookPlaygroundFireScope,
  resetVerifiedWebhookPlaygroundFireScopeForTests,
} from "../../lib/webhook-playground-fire-verified-scope";

describe("secure API-key migration", () => {
  const values = new Map<string, string>();
  let failApiUrlWrites = false;

  beforeEach(() => {
    resetWebhookPlaygroundFireOperationExclusionForTests();
    resetVerifiedWebhookPlaygroundFireScopeForTests();
    resetApiIdentityTransitionForTests();
    values.clear();
    h.initializeApiBroker.mockReset();
    h.initializeSessionBroker.mockReset();
    h.initializeSessionBroker.mockImplementation(async (baseUrl: string) => ({
      baseUrl,
    }));
    h.configureApiBroker.mockReset();
    h.reconcilePendingWorkspaceSwitch.mockReset();
    h.status.configured = false;
    h.status.baseUrl = null;
    h.status.credentialFingerprint = null;
    failApiUrlWrites = false;
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failApiUrlWrites && key === "postwave_api_url") {
          throw new Error("storage locked");
        }
        values.set(key, value);
      },
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
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
  });

  it("treats only an active native loopback broker as locally reachable", () => {
    h.status.configured = true;
    h.status.baseUrl = "http://127.0.0.1:8080";
    expect(hasLocalNativeApiCredential()).toBe(true);

    h.status.baseUrl = "http://localhost:8080";
    expect(hasLocalNativeApiCredential()).toBe(true);

    h.status.baseUrl = "https://api.moosewave.com";
    expect(hasLocalNativeApiCredential()).toBe(false);

    h.status.configured = false;
    h.status.baseUrl = "http://127.0.0.1:8080";
    expect(hasLocalNativeApiCredential()).toBe(false);
  });

  it("retries a legacy migration, purges plaintext, and fails closed", async () => {
    values.set("postwave_api_key", "pw_plaintext_legacy");
    h.initializeApiBroker.mockRejectedValue(
      new Error("credential vault locked"),
    );

    await expect(hydrateSecureApiConfig()).rejects.toBeInstanceOf(
      SecureCredentialStorageError,
    );
    expect(h.initializeApiBroker).toHaveBeenCalledTimes(3);
    expect(h.initializeApiBroker).toHaveBeenCalledWith(
      "http://localhost:8080",
      "pw_plaintext_legacy",
    );
    expect(values.has("postwave_api_key")).toBe(false);
    expect(getApiKey()).toBeNull();
  });

  it("uses a full SHA-256 credential partition without persisting the key", async () => {
    const first = await credentialIdentityHash(
      "https://api.example.com",
      "pw_private_one",
    );
    const second = await credentialIdentityHash(
      "https://api.example.com",
      "pw_private_two",
    );

    expect(first).toMatch(/^api-credential:sha256:[a-f0-9]{64}$/);
    expect(second).toMatch(/^api-credential:sha256:[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(Array.from(values.values()).join(" ")).not.toContain("pw_private");
  });

  it("migrates once into an origin-bound broker and never caches the bearer", async () => {
    values.set("postwave_api_key", "pw_plaintext_legacy");
    h.initializeApiBroker.mockImplementation(async (baseUrl: string) => {
      h.status.configured = true;
      h.status.baseUrl = baseUrl;
      h.status.credentialFingerprint = "a".repeat(64);
      return { ...h.status, legacyReentryRequired: false };
    });
    h.configureApiBroker.mockImplementation(
      async (baseUrl: string, apiKey: string | null) => {
        h.status.configured = Boolean(apiKey);
        h.status.baseUrl = apiKey ? baseUrl : null;
        h.status.credentialFingerprint = apiKey ? "b".repeat(64) : null;
        return { ...h.status, legacyReentryRequired: false };
      },
    );

    await hydrateSecureApiConfig();
    expect(values.has("postwave_api_key")).toBe(false);
    expect(getApiKey()).toBeNull();
    expect(h.status.configured).toBe(true);

    rememberSession({
      user_id: "user_1",
      tenant_id: "tenant_1",
      email: "owner@example.com",
      role: "owner",
      auth_provider: "password",
      email_verified: true,
    });
    await offlineQueueIdle();
    expect(
      JSON.parse(values.get("postwave.desktop.offline-identity.v2") ?? "null"),
    ).toEqual({
      version: 2,
      identity: expect.stringMatching(/^offline-identity:sha256:[a-f0-9]{64}$/),
    });
    expect(Array.from(values.entries()).join(" ")).not.toContain(
      `apikey:native:${"a".repeat(64)}`,
    );

    // Replacing a credential on the same origin must still create a new
    // offline/query partition so tenant A's queue cannot replay as tenant B,
    // even when optional URL persistence is locked down.
    failApiUrlWrites = true;
    await setApiConfig("http://localhost:8080", "pw_replacement");
    expect(h.configureApiBroker).toHaveBeenCalledWith(
      "http://localhost:8080",
      "pw_replacement",
      false,
    );
    expect(values.has("postwave.desktop.offline-identity.v1")).toBe(false);
    expect(
      JSON.parse(values.get("postwave.desktop.offline-identity.v2") ?? "null")
        .identity,
    ).toMatch(/^offline-identity:sha256:[a-f0-9]{64}$/);
    expect(Array.from(values.entries()).join(" ")).not.toContain(
      `apikey:native:${"b".repeat(64)}`,
    );
    expect(getApiKey()).toBeNull();
    expect(Array.from(values.values()).join(" ")).not.toContain(
      "pw_replacement",
    );
  });

  it("publishes the next authority before native broker mutation can interleave", async () => {
    const original = "https://api-a.example.test/path";
    const next = "https://api-b.example.test/path";
    values.set("postwave_api_url", original);
    invalidateApiUrlCache();
    const observed: Array<string | null> = [];
    const unsubscribe = subscribeApiAuthority((authority) =>
      observed.push(authority),
    );
    let release!: () => void;
    h.configureApiBroker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              configured: true,
              baseUrl: next,
              credentialFingerprint: "c".repeat(64),
              legacyReentryRequired: false,
            });
        }),
    );

    const pending = setApiConfig(next, "pw_next_origin");
    expect(observed).toEqual([null, next]);
    expect(h.configureApiBroker).toHaveBeenCalledTimes(1);

    release();
    await pending;
    expect(values.get("postwave_api_url")).toBe(next);
    unsubscribe();
  });

  it("invalidates same-base request authority before credential IPC and restores dispatch only after commit", async () => {
    const sameBase = "https://api.example.test/path";
    values.set("postwave_api_url", sameBase);
    invalidateApiUrlCache();
    const priorGeneration = captureApiIdentityGeneration();
    expect(priorGeneration).toBe(0);
    const observed: Array<string | null> = [];
    const unsubscribe = subscribeApiAuthority((authority) =>
      observed.push(authority),
    );
    let release!: () => void;
    h.configureApiBroker.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              configured: true,
              baseUrl: sameBase,
              credentialFingerprint: "f".repeat(64),
              legacyReentryRequired: false,
            });
        }),
    );

    const pending = setApiConfig(sameBase, "pw_replacement_same_base");

    expect(observed).toEqual([null, sameBase]);
    expect(captureApiIdentityGeneration()).toBeNull();
    expect(apiIdentityGenerationIsCurrent(priorGeneration!)).toBe(false);
    release();
    await pending;
    expect(captureApiIdentityGeneration()).toBe(1);
    expect(apiIdentityGenerationIsCurrent(priorGeneration!)).toBe(false);
    expect(JSON.stringify(observed)).not.toContain("pw_replacement_same_base");
    unsubscribe();
  });

  it("refuses API credential replacement before beginning an identity transition when recovery is held", async () => {
    registerVerifiedWebhookPlaygroundFireScope({
      apiIdentityGeneration: captureApiIdentityGeneration()!,
      credentialSource: "api-key",
      recoveryScope: "a".repeat(64),
    });
    values.set(
      `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-api-key-${"a".repeat(64)}`,
      "encrypted-checkpoint",
    );
    const priorGeneration = captureApiIdentityGeneration();

    await expect(
      setApiConfig("https://api.example.test/path", "pw_replacement"),
    ).rejects.toThrow(/encrypted webhook Simulator fire identity/u);

    expect(h.configureApiBroker).not.toHaveBeenCalled();
    expect(captureApiIdentityGeneration()).toBe(priorGeneration);
    expect(apiIdentityGenerationIsCurrent(priorGeneration!)).toBe(true);
  });

  it("allows credential restoration while only a foreign recovery artifact survives", async () => {
    registerVerifiedWebhookPlaygroundFireScope({
      apiIdentityGeneration: captureApiIdentityGeneration()!,
      credentialSource: "api-key",
      recoveryScope: "b".repeat(64),
    });
    values.set(
      `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-api-key-${"a".repeat(64)}`,
      "encrypted-checkpoint",
    );

    await setApiConfig("https://api.example.test/path", "pw_restore_owner");

    expect(h.configureApiBroker).toHaveBeenCalledTimes(1);
    expect(
      values.get(
        `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-api-key-${"a".repeat(64)}`,
      ),
    ).toBe("encrypted-checkpoint");
  });

  it("reconciles a pending workspace switch before adopting hydrated broker URL state", async () => {
    values.set("postwave_api_url", "https://source.example.test");
    values.set("postwave.desktop.workspace-switch.v1", "pending");
    h.initializeApiBroker.mockResolvedValue({
      configured: true,
      baseUrl: "https://target.example.test",
      credentialFingerprint: "e".repeat(64),
      legacyReentryRequired: false,
    });
    h.reconcilePendingWorkspaceSwitch.mockImplementationOnce(async (status) => {
      expect(status.baseUrl).toBe("https://target.example.test");
      expect(values.get("postwave_api_url")).toBe(
        "https://source.example.test",
      );
      values.delete("postwave.desktop.workspace-switch.v1");
    });

    await hydrateSecureApiConfig();

    expect(h.reconcilePendingWorkspaceSwitch).toHaveBeenCalledTimes(1);
    expect(values.get("postwave_api_url")).toBe("https://source.example.test");
  });
});
