import { beforeEach, describe, expect, it, vi } from "vitest";
import * as SecureStore from "expo-secure-store";
import { EVENTS } from "@postwave/telemetry";

import { createAuthClient, type AuthMeResponse } from "@/api/auth";
import { clearClient } from "@/api/sdkClient";
import { isProbablyOnline } from "@/lib/connectivity";
import { clearPendingAuthLinkStates } from "@/lib/magicLinkState";
import { queryClient, queryPersister } from "@/lib/queryClient";
import { vaultClear, vaultRecoverPendingCleanup } from "@/lib/secureVault";
import {
  clearSharedInbox,
  clearSharedInboxStrict,
} from "@/lib/sharedInbox";
import { reset as resetTelemetry, track } from "@/lib/telemetry";
import {
  clearWidgetSnapshot,
  clearWidgetSnapshotStrict,
} from "@/lib/widgetData";

import {
  LocalAuthPersistenceError,
  destinationForSession,
  mfaGateForSession,
  needsMfaSecurityStepUp,
  parseStoredSession,
  sanitizeSessionProfile,
  sessionProfileFromMe,
  type SessionProfile,
  useAuthStore,
} from "./auth";

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("@/api/sdkClient", () => ({ clearClient: vi.fn() }));
vi.mock("@/api/auth", () => ({
  createAuthClient: vi.fn(),
  setMfaRequiredObserver: vi.fn(),
}));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: vi.fn(() => true) }));
vi.mock("@/lib/magicLinkState", () => ({
  clearPendingAuthLinkStates: vi.fn(),
}));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { clear: vi.fn() },
  queryPersister: { removeClient: vi.fn() },
}));
vi.mock("@/lib/secureVault", () => ({
  vaultClear: vi.fn(),
  vaultRecoverPendingCleanup: vi.fn(),
}));
vi.mock("@/lib/sharedInbox", () => ({
  clearSharedInbox: vi.fn(),
  clearSharedInboxStrict: vi.fn(),
}));
vi.mock("@/lib/telemetry", () => ({ track: vi.fn(), reset: vi.fn() }));
vi.mock("@/lib/widgetData", () => ({
  clearWidgetSnapshot: vi.fn(),
  clearWidgetSnapshotStrict: vi.fn(),
}));

function me(overrides: Partial<AuthMeResponse> = {}): AuthMeResponse {
  return {
    email: "owner@example.com",
    user_id: "user_1",
    tenant_id: "tenant_1",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    can_use_viewer_mode: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
    totp_enabled: false,
    mfa_required: false,
    mfa_satisfied: false,
    ...overrides,
  };
}

function profile(overrides: Partial<SessionProfile> = {}): SessionProfile {
  return {
    ...sessionProfileFromMe(me()),
    ...overrides,
  };
}

function mockClient(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof createAuthClient> {
  return {
    baseUrl: "https://api.moosewave.com",
    getMe: vi.fn(async () => ({ data: me() })),
    logoutSession: vi.fn(async () => ({ data: undefined })),
    ...overrides,
  } as unknown as ReturnType<typeof createAuthClient>;
}

function setSessionState(
  session: SessionProfile,
  validation = "validated_online",
) {
  useAuthStore.setState({
    apiKey: null,
    baseUrl: "https://api.moosewave.com",
    tenantId: session.tenantId,
    mode: "session",
    session,
    sessionValidation: validation as "validated_online",
    hydrated: true,
    signingIn: false,
    authWarning: null,
    localCleanupPending: false,
  });
}

describe("authoritative mobile MFA state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    vi.mocked(SecureStore.setItemAsync).mockResolvedValue();
    vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue();
    vi.mocked(vaultClear).mockResolvedValue();
    vi.mocked(vaultRecoverPendingCleanup).mockResolvedValue(false);
    vi.mocked(queryPersister.removeClient).mockResolvedValue();
    vi.mocked(clearPendingAuthLinkStates).mockResolvedValue();
    vi.mocked(clearSharedInboxStrict).mockResolvedValue();
    vi.mocked(clearWidgetSnapshotStrict).mockResolvedValue();
    vi.mocked(isProbablyOnline).mockReturnValue(true);
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({ baseUrl }),
    );
    useAuthStore.setState({
      apiKey: null,
      baseUrl: null,
      tenantId: null,
      mode: null,
      session: null,
      sessionValidation: "none",
      hydrated: false,
      signingIn: false,
      authWarning: null,
      localCleanupPending: false,
    });
  });

  it.each([
    {
      name: "policy off for owner password",
      role: "owner",
      provider: "password",
      required: false,
      satisfied: false,
      enrolled: false,
      gate: "none",
      route: "/(tabs)/dashboard",
    },
    {
      name: "policy off for viewer OAuth",
      role: "viewer",
      provider: "google",
      required: false,
      satisfied: false,
      enrolled: true,
      gate: "none",
      route: "/(tabs)/dashboard",
    },
    {
      name: "required owner must enroll",
      role: "owner",
      provider: "password",
      required: true,
      satisfied: false,
      enrolled: false,
      gate: "enrollment",
      route: "/(auth)/mfa-enroll",
    },
    {
      name: "required admin must challenge",
      role: "admin",
      provider: "google",
      required: true,
      satisfied: false,
      enrolled: true,
      gate: "challenge",
      route: "/(auth)/totp",
    },
    {
      name: "required viewer is satisfied",
      role: "viewer",
      provider: "magic_link",
      required: true,
      satisfied: true,
      enrolled: true,
      gate: "none",
      route: "/(tabs)/dashboard",
    },
    {
      name: "satisfied session still enrolls when required factor is absent",
      role: "owner",
      provider: "password",
      required: true,
      satisfied: true,
      enrolled: false,
      gate: "enrollment",
      route: "/(auth)/mfa-enroll",
    },
  ])("routes $name solely from canonical fields", (testCase) => {
    const session = sessionProfileFromMe(
      me({
        role: testCase.role,
        effective_role: testCase.role,
        auth_provider: testCase.provider,
        mfa_required: testCase.required,
        mfa_satisfied: testCase.satisfied,
        totp_enabled: testCase.enrolled,
      }),
    );

    expect(mfaGateForSession(session)).toBe(testCase.gate);
    expect(destinationForSession(session)).toBe(testCase.route);
    expect(session).toMatchObject({
      totpEnabled: testCase.enrolled,
      mfaRequired: testCase.required,
      mfaSatisfied: testCase.satisfied,
      hasTotp: testCase.enrolled,
    });
  });

  it("migrates legacy cached projections conservatively", () => {
    const migrated = parseStoredSession(
      JSON.stringify({
        email: "owner@example.com",
        userId: "user_1",
        tenantId: "tenant_1",
        role: "owner",
        hasTotp: true,
        mfaStatus: "pending",
      }),
    );

    expect(migrated).toMatchObject({
      totpEnabled: true,
      hasTotp: true,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaStatus: "pending",
    });
    expect(mfaGateForSession(migrated)).toBe("challenge");
  });

  it("recomputes compatibility fields instead of accepting contradictions", () => {
    const sanitized = sanitizeSessionProfile({
      ...profile(),
      totpEnabled: false,
      hasTotp: true,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaStatus: "satisfied",
    });

    expect(sanitized).toMatchObject({
      totpEnabled: false,
      hasTotp: false,
      mfaStatus: "pending",
    });
    expect(mfaGateForSession(sanitized)).toBe("enrollment");
  });

  it("requires operation step-up to manage an enrolled factor even when policy is off", () => {
    const session = profile({
      totpEnabled: true,
      hasTotp: true,
      mfaRequired: false,
      mfaSatisfied: false,
      mfaStatus: "not_required",
    });

    expect(mfaGateForSession(session)).toBe("none");
    expect(needsMfaSecurityStepUp(session)).toBe(true);
    expect(needsMfaSecurityStepUp({ ...session, mfaSatisfied: true })).toBe(
      false,
    );
  });

  it("rejects oversized, malformed and control-character session blobs", () => {
    expect(
      parseStoredSession(
        JSON.stringify({
          email: "owner@example.com",
          userId: "user_1",
          tenantId: "tenant_1",
          filler: "x".repeat(20_000),
        }),
      ),
    ).toBeNull();
    expect(
      parseStoredSession(
        JSON.stringify({
          email: "owner@example.com\nforged",
          userId: "user_1",
          tenantId: "tenant_1",
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["enrollment", false],
    ["challenge", true],
  ] as const)(
    "keeps a required %s session out of tabs",
    async (_, enrolled) => {
      const session = sessionProfileFromMe(
        me({
          mfa_required: true,
          mfa_satisfied: false,
          totp_enabled: enrolled,
        }),
      );

      await useAuthStore.getState().signInSession({
        baseUrl: "https://api.moosewave.com",
        profile: session,
      });

      expect(useAuthStore.getState().mfaGate()).toBe(
        enrolled ? "challenge" : "enrollment",
      );
      expect(useAuthStore.getState().canEnterApp()).toBe(false);
      expect(useAuthStore.getState().canUseOnlineServices()).toBe(false);
      expect(track).toHaveBeenCalledWith(EVENTS.MOBILE_AUTH_COMPLETED, {
        outcome: "success",
        method: "session",
      });
    },
  );

  it("lets API-key authentication bypass the cookie-session MFA gate", async () => {
    await useAuthStore.getState().signIn({
      apiKey: "pw_test",
      baseUrl: "https://api.moosewave.com",
      tenantId: "tenant_1",
    });

    expect(useAuthStore.getState().mfaGate()).toBe("none");
    expect(useAuthStore.getState().canEnterApp()).toBe(true);
    expect(useAuthStore.getState().canUseOnlineServices()).toBe(true);
    expect(track).toHaveBeenCalledWith(EVENTS.MOBILE_AUTH_COMPLETED, {
      outcome: "success",
      method: "api_key",
    });
  });

  it("uses /me to replace a locally satisfied state when policy requires challenge", async () => {
    setSessionState(
      profile({
        totpEnabled: true,
        hasTotp: true,
        mfaRequired: true,
        mfaSatisfied: true,
        mfaStatus: "satisfied",
      }),
      "offline_cached",
    );
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          data: me({
            totp_enabled: true,
            mfa_required: true,
            mfa_satisfied: false,
          }),
        })),
      }),
    );

    await useAuthStore.getState().refreshSessionFromServer();

    expect(useAuthStore.getState().session).toMatchObject({
      mfaRequired: true,
      mfaSatisfied: false,
      totpEnabled: true,
      mfaStatus: "pending",
    });
    expect(useAuthStore.getState().mfaGate()).toBe("challenge");
    expect(useAuthStore.getState().canEnterApp()).toBe(false);
  });

  it("routes a newly enforced policy without enrollment to mandatory setup", async () => {
    setSessionState(profile());
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          data: me({ mfa_required: true, mfa_satisfied: false }),
        })),
      }),
    );

    await useAuthStore.getState().refreshSessionFromServer();

    expect(useAuthStore.getState().mfaGate()).toBe("enrollment");
    expect(destinationForSession(useAuthStore.getState().session)).toBe(
      "/(auth)/mfa-enroll",
    );
  });

  it("commits a verified /me profile through a write-ahead journal", async () => {
    setSessionState(
      profile({
        totpEnabled: true,
        hasTotp: true,
        mfaRequired: true,
        mfaSatisfied: false,
        mfaStatus: "pending",
      }),
    );
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          data: me({
            totp_enabled: true,
            mfa_required: true,
            mfa_satisfied: true,
          }),
        })),
      }),
    );

    await useAuthStore.getState().refreshSessionFromServer();

    expect(useAuthStore.getState().session?.mfaSatisfied).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.session_profile.pending",
      expect.stringContaining('"mfaSatisfied":true'),
      expect.any(Object),
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.session_profile",
      expect.stringContaining('"mfaSatisfied":true'),
      expect.any(Object),
    );
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      "postwave.session_profile.pending",
      expect.any(Object),
    );
  });

  it("keeps canonical live MFA state and leaves a fail-closed marker when persistence fails", async () => {
    setSessionState(
      profile({
        totpEnabled: true,
        hasTotp: true,
        mfaRequired: true,
        mfaSatisfied: false,
        mfaStatus: "pending",
      }),
    );
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          data: me({
            totp_enabled: true,
            mfa_required: true,
            mfa_satisfied: true,
          }),
        })),
      }),
    );
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.session_profile") throw new Error("keychain busy");
    });

    await expect(
      useAuthStore.getState().refreshSessionFromServer(),
    ).rejects.toBeInstanceOf(LocalAuthPersistenceError);

    expect(useAuthStore.getState().session?.mfaSatisfied).toBe(true);
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.auth_cleanup_pending",
      "1",
      expect.any(Object),
    );
  });

  it("keeps the cleanup latch set so dev auto-sign-in cannot loop", async () => {
    // THE LOOP THIS PREVENTS, observed on a simulator against a live API:
    //
    //   POST /auth/login  200
    //   GET  /auth/me     200
    //   POST /auth/logout 204     ... and again, unbounded
    //
    // persistSessionTransaction writes the durable CLEANUP_PENDING marker before
    // throwing, but cancelSession then reset the IN-MEMORY flag with
    // `loggedOutState(null, false)` -- right for an ordinary sign-out, wrong
    // here. Dev auto-sign-in guards on that in-memory flag
    // (useSignInController: `if (!DEV_AUTO_SIGN_IN || busy ||
    // localCleanupPending) return`), so clearing it let auto-sign-in retry
    // immediately against a local failure that cannot resolve on its own: three
    // server round trips per iteration, and the app never staying signed in.
    //
    // The durable marker was correct throughout. Only the in-memory copy lied,
    // which is why the banner rendered AND the retry fired.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.session_profile.pending") {
        throw new Error("keychain locked");
      }
    });

    await expect(
      useAuthStore.getState().signInSession({
        baseUrl: "https://api.moosewave.com",
        profile: profile(),
      }),
    ).rejects.toBeInstanceOf(LocalAuthPersistenceError);

    // The assertion the fix is for. Without it this reads false and the next
    // auto-sign-in tick starts the cycle over.
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
    // ...and the session really is gone, so the latch is not masking a
    // half-signed-in state.
    expect(useAuthStore.getState().mode).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
  });

  it("journals the server cookie when session sign-in cannot persist locally", async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.session_profile.pending") {
        throw new Error("keychain locked");
      }
    });
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        logoutSession: vi.fn(async () => ({
          error: { kind: "network", message: "offline" },
        })),
      }),
    );

    await expect(
      useAuthStore.getState().signInSession({
        baseUrl: "https://api.moosewave.com",
        profile: profile(),
      }),
    ).rejects.toBeInstanceOf(LocalAuthPersistenceError);

    expect(useAuthStore.getState().mode).toBeNull();
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.session_revocation_pending",
      "https://api.moosewave.com",
      expect.any(Object),
    );
    expect(useAuthStore.getState().authWarning).toMatch(/Server sign-out/);
  });

  it("globally closes the gate on mfa_required before canonical revalidation", async () => {
    setSessionState(
      profile({
        totpEnabled: true,
        hasTotp: true,
        mfaRequired: false,
        mfaSatisfied: true,
        mfaStatus: "not_required",
      }),
    );
    let observedDuringGetMe = false;
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => {
          observedDuringGetMe =
            useAuthStore.getState().mfaGate() === "challenge";
          return {
            data: me({
              totp_enabled: true,
              mfa_required: true,
              mfa_satisfied: false,
            }),
          };
        }),
      }),
    );

    await useAuthStore.getState().handleMfaRequired("https://api.moosewave.com");

    expect(observedDuringGetMe).toBe(true);
    expect(useAuthStore.getState().mfaGate()).toBe("challenge");
  });

  it("does not let an mfa_required response for another origin alter this session", async () => {
    setSessionState(profile());

    await useAuthStore
      .getState()
      .handleMfaRequired("https://other.example.com");

    expect(useAuthStore.getState().session?.mfaRequired).toBe(false);
  });

  it("clears an expired session and all local artifacts after /me 401", async () => {
    setSessionState(profile());
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          error: {
            status: 401,
            code: "no_session",
            kind: "http",
            message: "expired",
          },
        })),
      }),
    );

    await expect(
      useAuthStore.getState().refreshSessionFromServer(),
    ).rejects.toMatchObject({ code: "session_expired" });

    expect(useAuthStore.getState().mode).toBeNull();
    expect(clearClient).toHaveBeenCalled();
    expect(queryClient.clear).toHaveBeenCalled();
    expect(vaultClear).toHaveBeenCalled();
    expect(queryPersister.removeClient).toHaveBeenCalled();
  });

  it("keeps a bounded cached session offline-only on timeout", async () => {
    setSessionState(profile(), "checking");
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        getMe: vi.fn(async () => ({
          error: {
            kind: "timeout",
            code: "request_timeout",
            message: "timeout",
          },
        })),
      }),
    );

    await useAuthStore.getState().revalidateSession();

    expect(useAuthStore.getState().sessionValidation).toBe("offline_cached");
    expect(useAuthStore.getState().canEnterApp()).toBe(true);
    expect(useAuthStore.getState().canUseOnlineServices()).toBe(false);
  });

  it("revokes the server session after memory is cleared on account switch", async () => {
    setSessionState(profile());
    const logoutSession = vi.fn(async () => {
      expect(useAuthStore.getState().mode).toBeNull();
      return { data: undefined };
    });
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({ baseUrl, logoutSession }),
    );

    const result = await useAuthStore.getState().cancelSession();

    expect(logoutSession).toHaveBeenCalledOnce();
    expect(result.serverRevocationPending).toBe(false);
    expect(result.cleanup.complete).toBe(true);
    expect(useAuthStore.getState().mode).toBeNull();
    expect(resetTelemetry).toHaveBeenCalled();
    expect(clearSharedInbox).toHaveBeenCalled();
    expect(clearSharedInboxStrict).toHaveBeenCalled();
    expect(clearWidgetSnapshot).toHaveBeenCalled();
    expect(clearWidgetSnapshotStrict).toHaveBeenCalled();
    expect(clearPendingAuthLinkStates).toHaveBeenCalled();
    expect(
      vi
        .mocked(SecureStore.deleteItemAsync)
        .mock.calls.map(([key]) => key),
    ).not.toContain("postwave.mobile.helpdesk.note-intents.v2");
  });

  it("defensively refuses a replacement cookie when pre-auth cleanup was skipped", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "postwave.session_revocation_pending"
        ? "https://api.moosewave.com"
        : null,
    );
    const logoutSession = vi.fn(async () => ({ data: undefined }));
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({ baseUrl, logoutSession }),
    );

    await expect(
      useAuthStore.getState().signInSession({
        baseUrl: "https://api.moosewave.com",
        profile: profile(),
      }),
    ).rejects.toMatchObject({ code: "server_revocation_pending" });

    expect(logoutSession).toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      "postwave.session_revocation_pending",
      expect.any(Object),
    );
    expect(useAuthStore.getState().mode).toBeNull();
  });

  it("revokes a queued session before a new auth request may replace its cookie", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "postwave.session_revocation_pending"
        ? "https://api.moosewave.com"
        : null,
    );
    const logoutSession = vi.fn(async () => ({ data: undefined }));
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({ baseUrl, logoutSession }),
    );

    await useAuthStore.getState().prepareForSessionAuthentication();

    expect(logoutSession).toHaveBeenCalledOnce();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(
      "postwave.session_revocation_pending",
      expect.any(Object),
    );
  });

  it("blocks session authentication while a queued revocation is offline", async () => {
    vi.mocked(isProbablyOnline).mockReturnValue(false);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "postwave.session_revocation_pending"
        ? "https://api.moosewave.com"
        : null,
    );
    const logoutSession = vi.fn(async () => ({ data: undefined }));
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({ baseUrl, logoutSession }),
    );

    await expect(
      useAuthStore.getState().prepareForSessionAuthentication(),
    ).rejects.toMatchObject({ code: "server_revocation_pending" });
    expect(logoutSession).not.toHaveBeenCalled();
  });

  it("journals an offline server revocation without restoring local auth", async () => {
    setSessionState(profile());
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        logoutSession: vi.fn(async () => ({
          error: { kind: "network", message: "offline" },
        })),
      }),
    );

    const result = await useAuthStore.getState().cancelSession();

    expect(result.serverRevocationPending).toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "postwave.session_revocation_pending",
      "https://api.moosewave.com",
      expect.any(Object),
    );
    expect(useAuthStore.getState().authWarning).toMatch(/Server sign-out/);
    expect(useAuthStore.getState().mode).toBeNull();

    // This warning carries no retry — local cleanup SUCCEEDED, only the server
    // revocation did not — so the sign-in strip renders it with no button on
    // it. `clearAuthWarning` is what lets the user put it down, and it must
    // not touch the cleanup flag, which is a different state entirely.
    expect(useAuthStore.getState().localCleanupPending).toBe(false);
    useAuthStore.getState().clearAuthWarning();
    expect(useAuthStore.getState().authWarning).toBeNull();
    expect(useAuthStore.getState().localCleanupPending).toBe(false);
  });

  it("surfaces when an offline revocation cannot be journaled", async () => {
    setSessionState(profile());
    vi.mocked(createAuthClient).mockImplementation((baseUrl) =>
      mockClient({
        baseUrl,
        logoutSession: vi.fn(async () => ({
          error: { kind: "network", message: "offline" },
        })),
      }),
    );
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.session_revocation_pending") {
        throw new Error("keychain locked");
      }
    });

    const result = await useAuthStore.getState().cancelSession();

    expect(result.serverRevocationPending).toBe(true);
    expect(
      vi
        .mocked(SecureStore.setItemAsync)
        .mock.calls.filter(
          ([key]) => key === "postwave.session_revocation_pending",
        ),
    ).toHaveLength(2);
    expect(useAuthStore.getState().authWarning).toMatch(/retry record/);
    expect(useAuthStore.getState().mode).toBeNull();
  });

  it("retries individual cleanup failures and reports persistent failures safely", async () => {
    setSessionState(profile());
    let attempts = 0;
    vi.mocked(queryPersister.removeClient).mockImplementation(async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("disk locked");
    });

    const first = await useAuthStore.getState().cancelSession();
    expect(first.cleanup).toEqual({
      complete: false,
      failedAreas: ["query_cache"],
    });
    expect(useAuthStore.getState().localCleanupPending).toBe(true);

    const retried = await useAuthStore.getState().retryLocalCleanup();
    expect(retried.complete).toBe(true);
    expect(useAuthStore.getState().localCleanupPending).toBe(false);
  });

  it("keeps cleanup pending when auth-link state cannot be purged", async () => {
    setSessionState(profile());
    vi.mocked(clearPendingAuthLinkStates).mockRejectedValue(
      new Error("keychain locked"),
    );

    const result = await useAuthStore.getState().cancelSession();

    expect(result.cleanup.failedAreas).toContain("auth_link_states");
    expect(clearPendingAuthLinkStates).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
    expect(useAuthStore.getState().authWarning).toMatch(/cleanup is incomplete/);
  });

  it("recovers a vault purge before reading or restoring an identity", async () => {
    let recovered = false;
    vi.mocked(vaultRecoverPendingCleanup).mockImplementation(async () => {
      recovered = true;
      return true;
    });
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      expect(recovered).toBe(true);
      if (key === "postwave.base_url") return "https://api.moosewave.com";
      if (key === "postwave.session_profile") return JSON.stringify(profile());
      return null;
    });

    await useAuthStore.getState().hydrate();

    expect(vaultRecoverPendingCleanup).toHaveBeenCalledBefore(
      vi.mocked(SecureStore.getItemAsync),
    );
    expect(useAuthStore.getState().mode).toBe("session");
  });

  it("never restores credentials while an auth cleanup marker exists", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.auth_cleanup_pending") return "1";
      if (key === "postwave.api_key") return "pw_stale";
      if (key === "postwave.base_url") return "https://api.moosewave.com";
      if (key === "postwave.tenant_id") return "tenant_stale";
      return null;
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().mode).toBeNull();
    expect(useAuthStore.getState().apiKey).toBeNull();
    expect(vaultClear).toHaveBeenCalled();
  });

  it("fails closed when corrupt cached identity data cannot be deleted", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.base_url") return "https://api.moosewave.com";
      if (key === "postwave.session_profile") return "{corrupt";
      return null;
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.session_profile") {
        throw new Error("keychain locked");
      }
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().mode).toBeNull();
    expect(useAuthStore.getState().localCleanupPending).toBe(true);
    expect(useAuthStore.getState().authWarning).toMatch(/cleanup is incomplete/);
  });

  it("recovers the staged profile after an interrupted session commit", async () => {
    const staged = profile({
      totpEnabled: true,
      hasTotp: true,
      mfaRequired: true,
      mfaSatisfied: false,
      mfaStatus: "pending",
    });
    vi.mocked(isProbablyOnline).mockReturnValue(false);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "postwave.base_url") return "https://api.moosewave.com";
      if (key === "postwave.session_profile") return JSON.stringify(profile());
      if (key === "postwave.session_profile.pending") {
        return JSON.stringify({
          version: 1,
          baseUrl: "https://api.moosewave.com",
          session: staged,
        });
      }
      return null;
    });

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().session).toMatchObject({
      mfaRequired: true,
      mfaSatisfied: false,
      totpEnabled: true,
    });
    expect(useAuthStore.getState().mfaGate()).toBe("challenge");
    expect(useAuthStore.getState().canEnterApp()).toBe(false);
  });
});
