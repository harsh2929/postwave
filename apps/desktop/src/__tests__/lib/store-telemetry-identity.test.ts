import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiBaseUrl: "https://api.example.test/gateway",
  apiKey: "pw_test-credential",
  getAuthMe: vi.fn(),
  getApiKeySelfInfo: vi.fn(),
  deriveRecoveryScope: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getApiKeySelfInfo: mocks.getApiKeySelfInfo },
  apiAuth: { getAuthMe: mocks.getAuthMe },
  getApiKey: () => mocks.apiKey,
  getApiUrl: () => mocks.apiBaseUrl,
}));

vi.mock("../../lib/file-transfer-history", () => ({
  configureTransferHistoryIdentity: vi.fn(),
}));

vi.mock("../../lib/notification-center", () => ({
  configureNotificationCenterIdentity: vi.fn(),
}));

vi.mock("../../lib/webhook-playground-fire-recovery-scope", () => ({
  deriveWebhookPlaygroundFireRecoveryScope: mocks.deriveRecoveryScope,
}));

import {
  beginApiIdentityTransition,
  releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests,
} from "../../lib/api-identity-transition";
import { currentVerifiedWebhookPlaygroundFireScope } from "../../lib/webhook-playground-fire-verified-scope";

describe("store session identity provenance", () => {
  beforeEach(async () => {
    resetApiIdentityTransitionForTests();
    vi.clearAllMocks();
    mocks.apiBaseUrl = "https://api.example.test/gateway";
    mocks.apiKey = "pw_test-credential";
    mocks.deriveRecoveryScope.mockResolvedValue("a".repeat(64));
    const { setMe } = await import("../../lib/store");
    setMe(null, "loading");
  });

  it("never promotes either same-tenant API-key actor to a durable principal", async () => {
    const tenant = "22222222-2222-4222-8222-222222222222";
    mocks.getAuthMe.mockRejectedValue(new Error("no session"));
    mocks.getApiKeySelfInfo
      .mockResolvedValueOnce({
        data: {
          tenant_id: tenant,
          scopes: ["admin"],
          actor: "11111111-1111-4111-8111-111111111111",
        },
      })
      .mockResolvedValueOnce({
        data: {
          tenant_id: tenant,
          scopes: ["admin"],
          actor: "human",
        },
      });
    const {
      loadMe,
      readNoteRecoveryPrincipal,
      readTelemetryIdentity,
      useStore,
    } = await import("../../lib/store");

    await loadMe();
    expect(useStore).toBeTypeOf("function");
    expect(readTelemetryIdentity()).toBeNull();
    expect(readNoteRecoveryPrincipal()).toBeNull();

    await loadMe();
    expect(readTelemetryIdentity()).toBeNull();
    expect(readNoteRecoveryPrincipal()).toBeNull();
  });

  it("projects namespaced API-key write scopes to editor authority", async () => {
    mocks.getAuthMe.mockRejectedValueOnce(new Error("no session"));
    mocks.getApiKeySelfInfo.mockResolvedValueOnce({
      data: {
        tenant_id: "22222222-2222-4222-8222-222222222222",
        scopes: ["write:campaigns"],
        actor: "automation",
      },
    });
    const { canAdmin, canWrite, loadMe } = await import("../../lib/store");

    await loadMe();

    expect(canWrite()).toBe(true);
    expect(canAdmin()).toBe(false);
  });

  it("retains only a collision-resistant browser credential fingerprint and refreshes it for a different key", async () => {
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    mocks.getAuthMe.mockRejectedValue(new Error("no session"));
    const selfInfo = {
      data: {
        tenant_id: "22222222-2222-4222-8222-222222222222",
        scopes: ["admin"],
        actor: "same-actor",
      },
    };
    mocks.getApiKeySelfInfo.mockResolvedValue(selfInfo);
    const { loadMe, readCredentialFingerprint } =
      await import("../../lib/store");

    await loadMe();
    const first = readCredentialFingerprint();
    expect(first).toMatch(/^api-credential:sha256:[a-f0-9]{64}$/u);
    expect(first).not.toContain(mocks.apiKey);

    mocks.apiKey = "pw_different-credential";
    await loadMe();
    const second = readCredentialFingerprint();
    expect(second).toMatch(/^api-credential:sha256:[a-f0-9]{64}$/u);
    expect(second).not.toBe(first);
    vi.unstubAllGlobals();
  });

  it("retains the canonical session pair from auth me", async () => {
    mocks.getAuthMe.mockResolvedValueOnce({
      data: {
        user_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        role: "admin",
        effective_role: "admin",
      },
    });
    const { loadMe, readNoteRecoveryPrincipal, readTelemetryIdentity } =
      await import("../../lib/store");

    await loadMe();

    expect(readTelemetryIdentity()).toEqual({
      apiBaseUrl: "https://api.example.test/gateway",
      user: "11111111-1111-4111-8111-111111111111",
      tenant: "22222222-2222-4222-8222-222222222222",
    });
    expect(readNoteRecoveryPrincipal()).toEqual({
      apiBaseUrl: "https://api.example.test/gateway",
      apiIdentityGeneration: 0,
      user: "11111111-1111-4111-8111-111111111111",
      tenant: "22222222-2222-4222-8222-222222222222",
    });
    expect(currentVerifiedWebhookPlaygroundFireScope()).toBe(
      `v1-session-${"a".repeat(64)}`,
    );
    expect(mocks.getApiKeySelfInfo).not.toHaveBeenCalled();
  });

  it("does not qualify a session response after its API authority changed", async () => {
    let release!: (value: {
      data: {
        user_id: string;
        tenant_id: string;
        role: string;
        effective_role: string;
      };
    }) => void;
    mocks.getAuthMe.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { loadMe, readNoteRecoveryPrincipal, readTelemetryIdentity } =
      await import("../../lib/store");

    const pending = loadMe();
    mocks.apiBaseUrl = "https://other.example.test/gateway";
    release({
      data: {
        user_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        role: "admin",
        effective_role: "admin",
      },
    });
    await pending;

    expect(readTelemetryIdentity()).toBeNull();
    expect(readNoteRecoveryPrincipal()).toBeNull();
    expect(currentVerifiedWebhookPlaygroundFireScope()).toBeNull();
  });

  it("does not qualify a delayed session response after a same-base credential boundary", async () => {
    let releaseResponse!: (value: {
      data: {
        user_id: string;
        tenant_id: string;
        role: string;
        effective_role: string;
      };
    }) => void;
    mocks.getAuthMe.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseResponse = resolve;
      }),
    );
    const { loadMe, readNoteRecoveryPrincipal, readTelemetryIdentity } =
      await import("../../lib/store");

    const pending = loadMe();
    const transition = beginApiIdentityTransition();
    releaseApiIdentityTransition(transition);
    releaseResponse({
      data: {
        user_id: "11111111-1111-4111-8111-111111111111",
        tenant_id: "22222222-2222-4222-8222-222222222222",
        role: "admin",
        effective_role: "admin",
      },
    });
    await pending;

    expect(readTelemetryIdentity()).toBeNull();
    expect(readNoteRecoveryPrincipal()).toBeNull();
  });

  it("discards an API-key projection when identity changes during recovery-scope derivation", async () => {
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    mocks.getAuthMe.mockRejectedValueOnce(new Error("no session"));
    mocks.getApiKeySelfInfo.mockResolvedValueOnce({
      data: {
        tenant_id: "22222222-2222-4222-8222-222222222222",
        scopes: ["admin"],
        actor: "stale-actor",
      },
    });
    let releaseScope!: (value: string) => void;
    mocks.deriveRecoveryScope.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseScope = resolve;
      }),
    );
    const { loadMe, readCredentialSource } = await import("../../lib/store");

    const pending = loadMe();
    await vi.waitFor(() =>
      expect(mocks.deriveRecoveryScope).toHaveBeenCalledTimes(1),
    );
    const transition = beginApiIdentityTransition();
    releaseApiIdentityTransition(transition);
    releaseScope("b".repeat(64));
    await pending;

    expect(readCredentialSource()).toBeNull();
    expect(currentVerifiedWebhookPlaygroundFireScope()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("keeps malformed auth me identifiers out of both principal pairs", async () => {
    mocks.getAuthMe.mockResolvedValueOnce({
      data: {
        user_id: "SESSION-USER",
        tenant_id: "22222222-2222-4222-8222-222222222222 ",
        role: "admin",
        effective_role: "admin",
      },
    });
    const { loadMe, readNoteRecoveryPrincipal, readTelemetryIdentity } =
      await import("../../lib/store");

    await loadMe();

    expect(readTelemetryIdentity()).toBeNull();
    expect(readNoteRecoveryPrincipal()).toBeNull();
    expect(mocks.getApiKeySelfInfo).not.toHaveBeenCalled();
  });

  it("retains session credential provenance when telemetry qualification fails", async () => {
    mocks.getAuthMe.mockResolvedValueOnce({
      data: {
        user_id: "non-canonical-session-actor",
        tenant_id: "non-canonical-session-tenant",
        role: "viewer",
        effective_role: "viewer",
      },
    });
    const { loadMe, readCredentialSource, readTelemetryIdentity } =
      await import("../../lib/store");

    await loadMe();

    expect(readTelemetryIdentity()).toBeNull();
    expect(readCredentialSource()).toBe("session");
  });
});
