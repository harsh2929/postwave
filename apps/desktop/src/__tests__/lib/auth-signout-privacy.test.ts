// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logoutSession: vi.fn(async () => ({ data: undefined })),
  clearApiConfig: vi.fn(async () => undefined),
  rememberSession: vi.fn(),
  clearAllWorkspaces: vi.fn(async () => undefined),
  clearOfflineStores: vi.fn(async () => undefined),
  vaultPurgeAll: vi.fn(async () => undefined),
  clearPersistedQueryCache: vi.fn(async () => undefined),
  purgePrivateSessionState: vi.fn(),
  resetTelemetry: vi.fn(),
  clearAllSessionBrokers: vi.fn(async () => undefined),
}));

vi.mock("../../lib/api-client", () => ({
  apiAuth: {
    logoutSession: mocks.logoutSession,
  },
  clearApiConfig: mocks.clearApiConfig,
  getRememberedSession: () => null,
  hasApiCredential: () => false,
  rememberSession: mocks.rememberSession,
}));
vi.mock("../../lib/workspaces", () => ({
  clearAllWorkspaces: mocks.clearAllWorkspaces,
}));
vi.mock("../../lib/offline-store", () => ({
  clearOfflineStores: mocks.clearOfflineStores,
}));
vi.mock("../../lib/secure-vault", () => ({
  vaultDelete: vi.fn(),
  vaultPurgeAll: mocks.vaultPurgeAll,
  vaultReadJSON: vi.fn(),
  vaultSetJSON: vi.fn(),
}));
vi.mock("../../lib/query-client", () => ({
  clearPersistedQueryCache: mocks.clearPersistedQueryCache,
}));
vi.mock("../../lib/private-session-state", () => ({
  purgePrivateSessionState: mocks.purgePrivateSessionState,
}));
vi.mock("../../lib/telemetry", () => ({ reset: mocks.resetTelemetry }));
vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: { clearAllSessionBrokers: mocks.clearAllSessionBrokers },
}));

import { fullSignOut, requestFullSignOut } from "../../lib/auth";
import {
  cancelLifecycleTransition,
  getLifecycleDecisionState,
  registerLifecycleGuard,
  resetLifecycleCoordinatorForTests,
} from "../../lib/lifecycle-coordinator";
import {
  resetInternalNoteOperationExclusionForTests,
  tryAcquireInternalNoteOperationLease,
} from "../../lib/helpdesk-internal-note-operation";
import {
  resetWebhookPlaygroundFireOperationExclusionForTests,
  tryAcquireWebhookPlaygroundFireOperationLease,
} from "../../lib/webhook-playground-fire-operation";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockClear();
  window.localStorage.clear();
  resetLifecycleCoordinatorForTests();
  resetInternalNoteOperationExclusionForTests();
  resetWebhookPlaygroundFireOperationExclusionForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("full sign-out privacy cleanup", () => {
  it("purges private process and legacy plaintext state on every sign-out", async () => {
    await fullSignOut();

    expect(mocks.logoutSession).toHaveBeenCalledTimes(1);
    expect(mocks.clearAllSessionBrokers).toHaveBeenCalledTimes(1);
    expect(mocks.purgePrivateSessionState).toHaveBeenCalledTimes(1);
    expect(mocks.clearApiConfig).toHaveBeenCalledTimes(1);
    expect(mocks.clearAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(mocks.clearOfflineStores).toHaveBeenCalledTimes(1);
    expect(mocks.vaultPurgeAll).toHaveBeenCalledTimes(1);
    expect(mocks.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
    expect(mocks.resetTelemetry).toHaveBeenCalledTimes(1);
  });

  it("does not let the internal cleanup callback bypass an active note action", async () => {
    const operation = tryAcquireInternalNoteOperationLease();
    expect(operation).not.toBeNull();

    await expect(fullSignOut()).rejects.toThrow(/internal-note operation/u);
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();
    operation?.release();
  });

  it("does not let the internal cleanup callback bypass an active webhook fire", async () => {
    const operation = tryAcquireWebhookPlaygroundFireOperationLease();
    expect(operation).not.toBeNull();

    await expect(fullSignOut()).rejects.toThrow(/webhook simulator fire/u);
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();
    operation?.release();
  });

  it("does not let the direct cleanup callback destroy a held webhook checkpoint", async () => {
    window.localStorage.setItem(
      `postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-session-${"a".repeat(64)}`,
      "encrypted-fire-checkpoint",
    );

    await expect(fullSignOut()).rejects.toThrow(/recovery evidence/u);
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();
  });

  it("does not let the direct cleanup callback bypass unverifiable webhook inventory", async () => {
    window.localStorage.setItem("force-enumeration", "1");
    const keySpy = vi
      .spyOn(window.localStorage, "key")
      .mockImplementation(() => {
        throw new Error("storage denied");
      });

    await expect(fullSignOut()).rejects.toThrow(/could not be verified/u);
    keySpy.mockRestore();
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();
  });

  it.each(["prepared", "unknown"])(
    "does not enter the privacy wipe while an internal-note key is %s",
    async (state) => {
      window.localStorage.setItem(
        "postwave.desktop.vault.v1:helpdesk-internal-note-intents.v3.v3-session-aaaaaaaaaaaaaaaa",
        `encrypted-${state}-checkpoint`,
      );

      const result = requestFullSignOut();
      await vi.waitFor(() =>
        expect(getLifecycleDecisionState().phase).toBe("review"),
      );
      expect(getLifecycleDecisionState().concerns[0]).toMatchObject({
        level: "blocking",
        canDiscard: false,
      });
      expect(mocks.logoutSession).not.toHaveBeenCalled();
      expect(mocks.clearApiConfig).not.toHaveBeenCalled();
      expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();

      cancelLifecycleTransition();
      await expect(result).resolves.toBe("cancelled");
      expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();
    },
  );

  it("does not enter the privacy wipe while an encrypted webhook fire is unresolved", async () => {
    window.localStorage.setItem(
      "postwave.desktop.vault.v1:webhook-playground-fire-recovery.v1.v1-session-aaaaaaaaaaaaaaaa",
      "encrypted-fire-checkpoint",
    );

    const result = requestFullSignOut();
    await vi.waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    expect(getLifecycleDecisionState().concerns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "blocking",
          canDiscard: false,
          detail: expect.stringMatching(/encrypted webhook Simulator fire/u),
        }),
      ]),
    );
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();

    cancelLifecycleTransition();
    await expect(result).resolves.toBe("cancelled");
  });

  it("blocks cleanup when checkpoint inventory cannot be verified", async () => {
    window.localStorage.setItem("force-enumeration", "1");
    vi.spyOn(window.localStorage, "key").mockImplementation(() => {
      throw new Error("storage denied");
    });

    const result = requestFullSignOut();
    await vi.waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.clearApiConfig).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();

    cancelLifecycleTransition();
    await expect(result).resolves.toBe("cancelled");
  });

  it("permits the reviewed sign-out path when checkpoint inventory is clear", async () => {
    await expect(requestFullSignOut()).resolves.toBe("proceeded");
    expect(mocks.vaultPurgeAll).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a note action starts after preflight inspection", async () => {
    const lateOperations: Array<
      NonNullable<ReturnType<typeof tryAcquireInternalNoteOperationLease>>
    > = [];
    const unregister = registerLifecycleGuard({
      id: "late-note-action-probe",
      label: "Late note action probe",
      kinds: ["sign-out"],
      inspect: () => null,
      prepare: () => {
        const lateOperation = tryAcquireInternalNoteOperationLease();
        if (!lateOperation) throw new Error("probe could not acquire lease");
        lateOperations.push(lateOperation);
      },
    });

    const result = requestFullSignOut();
    await vi.waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("error"),
    );
    expect(lateOperations).toHaveLength(1);
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();

    lateOperations[0]?.release();
    unregister();
    cancelLifecycleTransition();
    await expect(result).resolves.toBe("cancelled");
  });

  it("fails closed when a webhook fire starts after preflight inspection", async () => {
    const lateOperations: Array<
      NonNullable<
        ReturnType<typeof tryAcquireWebhookPlaygroundFireOperationLease>
      >
    > = [];
    const unregister = registerLifecycleGuard({
      id: "late-webhook-fire-probe",
      label: "Late webhook fire probe",
      kinds: ["sign-out"],
      inspect: () => null,
      prepare: () => {
        const lateOperation = tryAcquireWebhookPlaygroundFireOperationLease();
        if (!lateOperation) throw new Error("probe could not acquire lease");
        lateOperations.push(lateOperation);
      },
    });

    const result = requestFullSignOut();
    await vi.waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("error"),
    );
    expect(lateOperations).toHaveLength(1);
    expect(mocks.logoutSession).not.toHaveBeenCalled();
    expect(mocks.purgePrivateSessionState).not.toHaveBeenCalled();
    expect(mocks.vaultPurgeAll).not.toHaveBeenCalled();

    lateOperations[0]?.release();
    unregister();
    cancelLifecycleTransition();
    await expect(result).resolves.toBe("cancelled");
  });

  it("holds the destructive lease through asynchronous server logout and cleanup", async () => {
    let finishLogout!: () => void;
    mocks.logoutSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLogout = () => resolve({ data: undefined });
        }),
    );

    const result = requestFullSignOut();
    await vi.waitFor(() => expect(mocks.logoutSession).toHaveBeenCalledOnce());
    expect(getLifecycleDecisionState().phase).toBe("proceeding");
    expect(tryAcquireInternalNoteOperationLease()).toBeNull();
    expect(tryAcquireWebhookPlaygroundFireOperationLease()).toBeNull();

    finishLogout();
    await expect(result).resolves.toBe("proceeded");
    const afterCleanup = tryAcquireInternalNoteOperationLease();
    expect(afterCleanup).not.toBeNull();
    afterCleanup?.release();
    const webhookAfterCleanup = tryAcquireWebhookPlaygroundFireOperationLease();
    expect(webhookAfterCleanup).not.toBeNull();
    webhookAfterCleanup?.release();
  });
});
