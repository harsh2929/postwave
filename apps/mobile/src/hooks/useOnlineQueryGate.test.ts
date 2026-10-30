import { describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({ generation: 0 }));
vi.mock("@/store/auth", () => ({ useAuthStore: vi.fn() }));
vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => {
    cryptoMocks.generation += 1;
    return `00000000-0000-4000-8000-${String(cryptoMocks.generation).padStart(12, "0")}`;
  }),
}));

// eslint-disable-next-line import/first
import {
  apiKeyLifecycleFingerprint,
  canRunOnlineOrSnapshotQuery,
  onlineQueryAuthorityOwner,
  selectOnlineQueryGate,
} from "./useOnlineQueryGate";

function authState(
  overrides: Partial<Parameters<typeof selectOnlineQueryGate>[0]> = {},
): Parameters<typeof selectOnlineQueryGate>[0] {
  return {
    apiKey: "pw_live_generation_one",
    baseUrl: "https://api.moosewave.com",
    mode: "api_key",
    tenantId: "tenant_api",
    session: null,
    canUseOnlineServices: () => true,
    ...overrides,
  };
}

describe("selectOnlineQueryGate", () => {
  it("enables queries for validated online auth", () => {
    const gate = selectOnlineQueryGate(authState());
    expect(gate).toEqual({
      enabled: true,
      baseUrl: "https://api.moosewave.com",
      tenantId: "tenant_api",
      userId: null,
      effectiveRole: null,
      credentialScope: `api-key:${apiKeyLifecycleFingerprint(
        "pw_live_generation_one",
      )}`,
      canReadOfflineSnapshots: false,
    });
    expect(canRunOnlineOrSnapshotQuery(gate)).toBe(true);
  });

  it("uses the cached session tenant when the top-level tenant is absent", () => {
    expect(
      selectOnlineQueryGate(
        authState({
          tenantId: null,
          apiKey: null,
          mode: "session",
          session: {
            email: "owner@example.com",
            userId: "user_1",
            tenantId: "tenant_session",
            role: "owner",
            effectiveRole: "owner",
            viewerMode: false,
            authProvider: "password",
            emailVerified: true,
            canUseViewerMode: true,
            totpEnabled: false,
            mfaRequired: false,
            mfaSatisfied: false,
            hasTotp: false,
            mfaStatus: "not_required",
          },
        }),
      ),
    ).toEqual({
      enabled: true,
      baseUrl: "https://api.moosewave.com",
      tenantId: "tenant_session",
      userId: "user_1",
      effectiveRole: "owner",
      credentialScope: "session",
      canReadOfflineSnapshots: true,
    });
  });

  it("disables network queries while auth cannot use online services", () => {
    const gate = selectOnlineQueryGate(
      authState({ canUseOnlineServices: () => false }),
    );
    expect(gate).toEqual({
      enabled: false,
      baseUrl: "https://api.moosewave.com",
      tenantId: "tenant_api",
      userId: null,
      effectiveRole: null,
      credentialScope: `api-key:${apiKeyLifecycleFingerprint(
        "pw_live_generation_one",
      )}`,
      canReadOfflineSnapshots: false,
    });
    expect(canRunOnlineOrSnapshotQuery(gate)).toBe(false);
  });

  it("runs an offline session snapshot without confusing it with network eligibility", () => {
    const gate = selectOnlineQueryGate(
      authState({
        apiKey: null,
        mode: "session",
        tenantId: null,
        canUseOnlineServices: () => false,
        session: {
          email: "owner@example.com",
          userId: "user_1",
          tenantId: "tenant_session",
          role: "owner",
          effectiveRole: "owner",
          viewerMode: false,
          authProvider: "password",
          emailVerified: true,
          canUseViewerMode: true,
          totpEnabled: false,
          mfaRequired: false,
          mfaSatisfied: false,
          hasTotp: false,
          mfaStatus: "not_required",
        },
      }),
    );

    expect(gate.enabled).toBe(false);
    expect(gate.canReadOfflineSnapshots).toBe(true);
    expect(canRunOnlineOrSnapshotQuery(gate)).toBe(true);
  });

  it("changes lifecycle scope when an API key rotates without exposing either key", () => {
    const firstKey = "pw_live_generation_one";
    const secondKey = "pw_live_generation_two";
    const first = selectOnlineQueryGate(authState({ apiKey: firstKey }));
    const second = selectOnlineQueryGate(authState({ apiKey: secondKey }));

    expect(first.credentialScope).not.toBe(second.credentialScope);
    expect(first.credentialScope).not.toContain(firstKey);
    expect(second.credentialScope).not.toContain(secondKey);
  });

  it("keeps one generation stable for the same key and mints a new one after rotation", () => {
    const first = apiKeyLifecycleFingerprint("pw_live_stable");
    expect(apiKeyLifecycleFingerprint("pw_live_stable")).toBe(first);
    expect(apiKeyLifecycleFingerprint("pw_live_rotated")).not.toBe(first);
  });

  it("never admits a retained human session into API-key snapshot scope", () => {
    const gate = selectOnlineQueryGate(
      authState({
        session: {
          email: "old-owner@example.com",
          userId: "old-user",
          tenantId: "old-tenant",
          role: "owner",
          effectiveRole: "owner",
          viewerMode: false,
          authProvider: "password",
          emailVerified: true,
          canUseViewerMode: true,
          totpEnabled: false,
          mfaRequired: false,
          mfaSatisfied: false,
          hasTotp: false,
          mfaStatus: "not_required",
        },
      }),
    );

    expect(gate.userId).toBeNull();
    expect(gate.effectiveRole).toBeNull();
    expect(gate.canReadOfflineSnapshots).toBe(false);
    expect(canRunOnlineOrSnapshotQuery(gate)).toBe(true);
  });

  it("canonicalizes the full settings/status owner and changes on every authority dimension", () => {
    const base = selectOnlineQueryGate(authState());
    expect(
      onlineQueryAuthorityOwner({ ...base, baseUrl: `${base.baseUrl}/` }),
    ).toBe(onlineQueryAuthorityOwner(base));

    for (const changed of [
      { ...base, baseUrl: "https://other.moosewave.com/gateway" },
      { ...base, tenantId: "tenant_other" },
      { ...base, userId: "user_other" },
      { ...base, effectiveRole: "viewer" },
      { ...base, credentialScope: "api-key:generation-other" },
    ]) {
      expect(onlineQueryAuthorityOwner(changed)).not.toBe(
        onlineQueryAuthorityOwner(base),
      );
    }
  });
});
