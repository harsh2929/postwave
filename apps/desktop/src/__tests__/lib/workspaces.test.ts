// Multi-workspace switcher store (lib/workspaces.ts).
//
// Pins the contracts the WorkspaceMenu relies on:
//   - first load migrates the legacy single-workspace config into a
//     "Default" profile (existing installs keep working unchanged);
//   - API keys NEVER touch localStorage or return from native IPC;
//   - switching journals and quiesces before the broker, then verifies URL and
//     active-id stages without exposing a credential to renderer JavaScript;
//   - the active workspace cannot be removed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const credentials = new Map<string, { baseUrl: string; key: string }>();
  const broker = {
    configured: false,
    baseUrl: null as string | null,
    credentialFingerprint: null as string | null,
  };
  const fingerprintFor = (id: string): string =>
    (id === "default" ? "d" : id === "target" ? "e" : "a").repeat(64);
  return {
    credentials,
    broker,
    fingerprintFor,
    storeWorkspaceCredential: vi.fn(
      async (id: string, baseUrl: string, key: string) => {
        credentials.set(id, { baseUrl, key });
      },
    ),
    removeWorkspaceCredential: vi.fn(async (id: string) => {
      credentials.delete(id);
    }),
    workspaceCredentialStatus: vi.fn(
      async (workspaces: Array<{ id: string; baseUrl: string }>) =>
        workspaces.map((workspace) => ({
          id: workspace.id,
          configured:
            credentials.get(workspace.id)?.baseUrl === workspace.baseUrl,
          legacyReentryRequired: false,
        })),
    ),
    switchWorkspaceCredential: vi.fn(
      async (currentId: string, targetId: string) => {
        const target = credentials.get(targetId);
        broker.configured = Boolean(target);
        broker.baseUrl = target?.baseUrl ?? null;
        broker.credentialFingerprint = target ? fingerprintFor(targetId) : null;
        void currentId;
        return { ...broker, legacyReentryRequired: false };
      },
    ),
    observeApiAuthority: vi.fn(),
    invalidateApiUrlCache: vi.fn(),
    setApiConfig: vi.fn((url: string, invalidate: () => void) => {
      window.localStorage.setItem("postwave_api_url", url);
      invalidate();
    }),
    beginApiIdentityTransition: vi.fn(() => ({ generation: 1 })),
    releaseApiIdentityTransition: vi.fn(),
    resyncApiIdentityAfterTransition: vi.fn(async () => undefined),
    resetApiIdentityTransition: vi.fn(),
    parkOfflineStores: vi.fn(async () => undefined),
    clearPersistedQueryCache: vi.fn(async () => undefined),
    purgePrivateSessionState: vi.fn(),
  };
});

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    apiBrokerStatus: () => ({ ...h.broker, legacyReentryRequired: false }),
    storeWorkspaceCredential: h.storeWorkspaceCredential,
    removeWorkspaceCredential: h.removeWorkspaceCredential,
    workspaceCredentialStatus: h.workspaceCredentialStatus,
    switchWorkspaceCredential: h.switchWorkspaceCredential,
  },
}));

vi.mock("../../lib/api-identity-transition", () => ({
  apiIdentityGenerationIsCurrent: () => true,
  beginApiIdentityTransition: h.beginApiIdentityTransition,
  PENDING_WORKSPACE_SWITCH_STORAGE_KEY: "postwave.desktop.workspace-switch.v1",
  releaseApiIdentityTransition: h.releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests: h.resetApiIdentityTransition,
}));

// api-client is a large module; the store only needs its URL/offline bridges.
vi.mock("../../lib/api-client", () => ({
  invalidateApiUrlCache: h.invalidateApiUrlCache,
  syncOfflineIdentity: h.resyncApiIdentityAfterTransition,
}));

vi.mock("../../lib/api-authority", () => ({
  observeApiAuthority: h.observeApiAuthority,
}));

vi.mock("../../lib/workspace-api-url", () => ({
  persistWorkspaceApiUrl: h.setApiConfig,
}));

vi.mock("../../lib/offline-store", () => ({
  parkOfflineStores: h.parkOfflineStores,
}));

vi.mock("../../lib/query-client", () => ({
  clearPersistedQueryCache: h.clearPersistedQueryCache,
}));

vi.mock("../../lib/private-session-state", () => ({
  purgePrivateSessionState: h.purgePrivateSessionState,
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  requestLifecycleTransition: async (
    _intent: unknown,
    proceed: () => void | Promise<void>,
  ) => {
    try {
      await proceed();
      return "proceeded" as const;
    } catch {
      return "failed" as const;
    }
  },
}));

import {
  __resetWorkspacesForTests,
  addWorkspace,
  getActiveWorkspace,
  getWorkspaces,
  refreshWorkspaceKeyFlags,
  reconcilePendingWorkspaceSwitch,
  removeWorkspace,
  switchWorkspace,
} from "../../lib/workspaces";
import { resetWebhookPlaygroundFireOperationExclusionForTests } from "../../lib/webhook-playground-fire-operation";
import {
  registerVerifiedWebhookPlaygroundFireScope,
  resetVerifiedWebhookPlaygroundFireScopeForTests,
} from "../../lib/webhook-playground-fire-verified-scope";

const storage = new Map<string, string>();
const reloadMock = vi.fn();

beforeEach(() => {
  resetWebhookPlaygroundFireOperationExclusionForTests();
  resetVerifiedWebhookPlaygroundFireScopeForTests();
  storage.clear();
  h.credentials.clear();
  h.broker.configured = false;
  h.broker.baseUrl = null;
  h.broker.credentialFingerprint = null;
  __resetWorkspacesForTests();
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
  };
  vi.stubGlobal("window", {
    localStorage,
    location: { reload: reloadMock },
    crypto: globalThis.crypto,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.storeWorkspaceCredential.mockClear();
  h.removeWorkspaceCredential.mockClear();
  h.workspaceCredentialStatus.mockClear();
  h.switchWorkspaceCredential.mockClear();
  h.observeApiAuthority.mockClear();
  h.invalidateApiUrlCache.mockClear();
  h.setApiConfig.mockClear();
  h.beginApiIdentityTransition.mockClear();
  h.releaseApiIdentityTransition.mockClear();
  h.resyncApiIdentityAfterTransition.mockClear();
  h.parkOfflineStores.mockClear();
  h.clearPersistedQueryCache.mockClear();
  h.purgePrivateSessionState.mockClear();
  reloadMock.mockClear();
});

describe("migration from the single-workspace config", () => {
  it("creates a Default profile from the stored API URL", () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const s = getWorkspaces();
    expect(s.activeId).toBe("default");
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({
      id: "default",
      name: "Default",
      apiUrl: "https://api.acme.test",
    });
    // Persisted so later loads don't re-migrate.
    expect(storage.get("postwave_workspaces_v1")).toContain('"default"');
  });

  it("re-syncs the active profile URL when Settings changed it", () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    getWorkspaces();
    __resetWorkspacesForTests();
    storage.set("postwave_api_url", "https://api.acme-new.test");
    expect(getActiveWorkspace()?.apiUrl).toBe("https://api.acme-new.test");
  });

  it("does not re-sync profile URLs while switch recovery is unresolved", () => {
    storage.set(
      "postwave_workspaces_v1",
      JSON.stringify({
        activeId: "default",
        profiles: [
          {
            id: "default",
            name: "Default",
            apiUrl: "https://source.acme.test",
            hasKey: false,
          },
        ],
      }),
    );
    storage.set("postwave_api_url", "https://target.acme.test");
    storage.set("postwave.desktop.workspace-switch.v1", "{}");

    expect(getActiveWorkspace()?.apiUrl).toBe("https://source.acme.test");
  });

  it("hasKey flips true once the native broker reports an active key", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    expect(getWorkspaces().profiles[0]!.hasKey).toBe(false);
    await refreshWorkspaceKeyFlags();
    expect(getWorkspaces().profiles[0]!.hasKey).toBe(true);
  });

  it("rejects an invalid or oversized active API URL before migration", () => {
    storage.set("postwave_api_url", `https://api.test/${"x".repeat(3_000)}`);

    const loaded = getWorkspaces();

    expect(loaded.profiles[0]?.apiUrl).not.toContain("x".repeat(100));
    expect(storage.has("postwave_api_url")).toBe(false);
  });
});

describe("persisted profile validation", () => {
  it("fails the entire record closed when a profile contains an unknown secret field", () => {
    storage.set(
      "postwave_workspaces_v1",
      JSON.stringify({
        activeId: "client-a",
        profiles: [
          {
            id: "client-a",
            name: "Client A",
            apiUrl: "https://api.client-a.test",
            hasKey: true,
            apiKey: "pw_must_not_survive",
          },
        ],
      }),
    );

    const loaded = getWorkspaces();

    expect(loaded.activeId).toBe("default");
    expect(storage.get("postwave_workspaces_v1")).not.toContain(
      "pw_must_not_survive",
    );
  });

  it("rejects duplicate IDs, invalid URLs, non-boolean key flags, and excess profiles", () => {
    const invalidRecords = [
      {
        activeId: "same",
        profiles: [
          {
            id: "same",
            name: "One",
            apiUrl: "https://one.test",
            hasKey: false,
          },
          {
            id: "same",
            name: "Two",
            apiUrl: "https://two.test",
            hasKey: false,
          },
        ],
      },
      {
        activeId: "bad-url",
        profiles: [
          {
            id: "bad-url",
            name: "Bad URL",
            apiUrl: "file:///private/config",
            hasKey: false,
          },
        ],
      },
      {
        activeId: "bad-flag",
        profiles: [
          {
            id: "bad-flag",
            name: "Bad flag",
            apiUrl: "https://flag.test",
            hasKey: "false",
          },
        ],
      },
      {
        activeId: "ws-0",
        profiles: Array.from({ length: 21 }, (_, index) => ({
          id: `ws-${index}`,
          name: `Workspace ${index}`,
          apiUrl: `https://workspace-${index}.test`,
          hasKey: false,
        })),
      },
    ];

    for (const record of invalidRecords) {
      storage.set("postwave_workspaces_v1", JSON.stringify(record));
      __resetWorkspacesForTests();
      expect(getWorkspaces().activeId).toBe("default");
    }
  });

  it("bounds raw persisted input before parsing", () => {
    storage.set("postwave_workspaces_v1", "x".repeat(65 * 1024));

    const loaded = getWorkspaces();

    expect(loaded.activeId).toBe("default");
    expect(storage.get("postwave_workspaces_v1")?.length).toBeLessThan(1_000);
  });
});

describe("refreshWorkspaceKeyFlags stale-activeId guard", () => {
  // Regression: refreshWorkspaceKeyFlags snapshots state at entry and
  // probes the keychain async. If switchWorkspace persists a new
  // activeId while the probes are in flight, the flag refresh must NOT
  // revert it by writing back the stale snapshot's activeId.
  it("preserves a concurrent switch's activeId when probes resolve after it", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    // Active is still "default" at this point.
    expect(getWorkspaces().activeId).toBe("default");

    // Gate the status probe so we can interleave a switch while the
    // flag refresh is mid-flight, then release it.
    let releaseProbe: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const realStatus = h.workspaceCredentialStatus.getMockImplementation()!;
    h.workspaceCredentialStatus.mockImplementationOnce(async (workspaces) => {
      await gate;
      return realStatus(workspaces);
    });

    // Kick off the refresh — its first probe now blocks on the gate.
    const refreshing = refreshWorkspaceKeyFlags();

    // Concurrent switch completes and persists activeId = staging.
    await switchWorkspace(staging.id);
    expect(getWorkspaces().activeId).toBe(staging.id);

    // Now let the in-flight probes finish; the refresh persists.
    releaseProbe!();
    await refreshing;

    // The switch must survive — NOT be reverted to the stale "default".
    expect(getWorkspaces().activeId).toBe(staging.id);
  });

  it("still refreshes hasKey flags across the whole profile set", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    // staging has its own saved key; default has none yet.
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    expect(
      getWorkspaces().profiles.find((p) => p.id === "default")!.hasKey,
    ).toBe(false);

    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    await refreshWorkspaceKeyFlags();

    const ws = getWorkspaces();
    expect(ws.profiles.find((p) => p.id === staging.id)!.hasKey).toBe(true);
    expect(ws.profiles.find((p) => p.id === "default")!.hasKey).toBe(true);
  });
});

describe("addWorkspace", () => {
  beforeEach(() => {
    storage.set("postwave_api_url", "https://api.acme.test");
  });

  it("stores the key in the keychain, never in localStorage", async () => {
    const p = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test/",
      key: "pw_secret_staging",
    });
    expect(p.hasKey).toBe(true);
    // Trailing slash normalized by validateApiUrl.
    expect(p.apiUrl).toBe("https://staging.acme.test");
    expect(h.storeWorkspaceCredential).toHaveBeenCalledWith(
      p.id,
      "https://staging.acme.test",
      "pw_secret_staging",
    );
    for (const value of storage.values()) {
      expect(value).not.toContain("pw_secret_staging");
    }
    expect(getWorkspaces().profiles).toHaveLength(2);
  });

  it("allows URL-only profiles for email sign-in workspaces", async () => {
    const p = await addWorkspace({
      name: "Sessions",
      apiUrl: "https://eu.acme.test",
    });
    expect(p.hasKey).toBe(false);
    expect(h.storeWorkspaceCredential).not.toHaveBeenCalled();
  });

  it("rejects invalid input without persisting anything", async () => {
    await expect(
      addWorkspace({ name: "  ", apiUrl: "https://x.test" }),
    ).rejects.toThrow(/name/i);
    await expect(
      addWorkspace({ name: "Bad", apiUrl: "ftp://x.test" }),
    ).rejects.toThrow(/http/i);
    expect(getWorkspaces().profiles).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
  });

  it("rolls back a stored credential when profile persistence is denied", async () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    await expect(
      addWorkspace({
        name: "Private",
        apiUrl: "https://private.acme.test",
        key: "pw_private_key",
      }),
    ).rejects.toThrow(/could not store/i);

    expect(getWorkspaces().profiles).toHaveLength(1);
    expect(h.credentials.size).toBe(0);
    expect(h.removeWorkspaceCredential).toHaveBeenCalledTimes(1);
  });
});

describe("switchWorkspace", () => {
  it("refuses a workspace credential activation before identity transition when recovery is held", async () => {
    registerVerifiedWebhookPlaygroundFireScope({
      apiIdentityGeneration: 0,
      credentialSource: "api-key",
      recoveryScope: "a".repeat(64),
    });
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    storage.set(
      `postwave.webhook-playground-fire-recovery-quarantine.v1:v1-api-key-${"a".repeat(64)}`,
      "1",
    );

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/u);

    expect(h.beginApiIdentityTransition).not.toHaveBeenCalled();
    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
    expect(getWorkspaces().activeId).toBe("default");
  });

  it("allows switching toward an identity that owns a foreign recovery artifact", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    registerVerifiedWebhookPlaygroundFireScope({
      apiIdentityGeneration: 0,
      credentialSource: "api-key",
      recoveryScope: "b".repeat(64),
    });
    const foreignKey = `postwave.webhook-playground-fire-recovery-quarantine.v1:v1-api-key-${"a".repeat(64)}`;
    storage.set(foreignKey, "1");

    await switchWorkspace(staging.id);

    expect(h.switchWorkspaceCredential).toHaveBeenCalledTimes(1);
    expect(storage.get(foreignKey)).toBe("1");
  });

  it("switches inside the broker without returning the target key", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });

    await switchWorkspace(staging.id);

    expect(h.switchWorkspaceCredential).toHaveBeenCalledWith(
      "default",
      staging.id,
      "https://staging.acme.test",
    );
    expect(h.observeApiAuthority).toHaveBeenCalledWith(
      "https://staging.acme.test",
    );
    expect(h.observeApiAuthority.mock.invocationCallOrder[0]).toBeLessThan(
      h.switchWorkspaceCredential.mock.invocationCallOrder[0]!,
    );
    expect(h.setApiConfig).toHaveBeenCalledWith(
      "https://staging.acme.test",
      h.invalidateApiUrlCache,
    );
    expect(h.invalidateApiUrlCache).toHaveBeenCalledTimes(1);
    expect(h.parkOfflineStores).toHaveBeenCalledTimes(1);
    expect(h.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
    expect(h.purgePrivateSessionState).toHaveBeenCalledWith({
      preserveInternalNoteQuarantine: true,
    });
    expect(getWorkspaces().activeId).toBe(staging.id);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it("activates URL-only targets without passing a key through renderer JS", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const sessions = await addWorkspace({
      name: "Sessions",
      apiUrl: "https://eu.acme.test",
    });
    await switchWorkspace(sessions.id);
    expect(h.setApiConfig).toHaveBeenCalledWith(
      "https://eu.acme.test",
      expect.any(Function),
    );
  });

  it("is a no-op for the already-active workspace", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    getWorkspaces();
    await switchWorkspace("default");
    expect(h.setApiConfig).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("rejects unknown workspace ids", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    getWorkspaces();
    await expect(switchWorkspace("nope")).rejects.toThrow(/no longer exists/i);
  });

  it("does not change the native credential when the switch cannot be persisted", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/i);

    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
    expect(getWorkspaces().activeId).toBe("default");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("releases the barrier without mutation when the prepared journal is denied", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
    });
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(
      (key, value) => {
        if (key === "postwave.desktop.workspace-switch.v1") {
          throw new Error("journal storage denied");
        }
        realSetItem(key, value);
      },
    );

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/i);

    expect(h.beginApiIdentityTransition).toHaveBeenCalledTimes(1);
    expect(h.releaseApiIdentityTransition).toHaveBeenCalledTimes(1);
    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
    expect(h.parkOfflineStores).not.toHaveBeenCalled();
    expect(storage.get("postwave.desktop.workspace-switch.v1")).toBeUndefined();
  });

  it("does not issue a destructive inverse switch when native activation rejects", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    h.switchWorkspaceCredential.mockRejectedValueOnce(
      new Error("broker unavailable"),
    );

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/i);

    expect(getWorkspaces().activeId).toBe("default");
    expect(h.switchWorkspaceCredential).toHaveBeenCalledTimes(1);
    expect(h.credentials.get(staging.id)?.key).toBe("pw_staging_key");
    expect(h.setApiConfig).toHaveBeenCalledWith(
      "https://api.acme.test",
      expect.any(Function),
    );
    expect(h.releaseApiIdentityTransition).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("rolls the broker and metadata back after a post-activation failure", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    h.credentials.set("default", {
      baseUrl: "https://api.acme.test",
      key: "pw_default_key",
    });
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    h.setApiConfig.mockImplementationOnce(() => {
      throw new Error("renderer config failed");
    });

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/i);

    expect(getWorkspaces().activeId).toBe("default");
    expect(h.switchWorkspaceCredential).toHaveBeenCalledTimes(2);
    expect(h.switchWorkspaceCredential).toHaveBeenLastCalledWith(
      staging.id,
      "default",
      "https://api.acme.test",
    );
    expect(h.setApiConfig).toHaveBeenCalledWith(
      "https://api.acme.test",
      expect.any(Function),
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("keeps a durable recovery journal when rollback metadata persistence is denied", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    h.broker.configured = true;
    h.broker.baseUrl = "https://api.acme.test";
    h.broker.credentialFingerprint = "d".repeat(64);
    h.credentials.set("default", {
      baseUrl: "https://api.acme.test",
      key: "pw_default_key",
    });
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    let metadataDenied = false;
    vi.spyOn(window.localStorage, "setItem").mockImplementation(
      (key, value) => {
        if (key === "postwave_workspaces_v1") {
          const activeId = (JSON.parse(value) as { activeId?: string })
            .activeId;
          if (activeId === staging.id) metadataDenied = true;
          if (metadataDenied) throw new Error("metadata storage denied");
        }
        realSetItem(key, value);
      },
    );

    await expect(switchWorkspace(staging.id)).rejects.toThrow(/safely switch/i);

    expect(h.broker.baseUrl).toBe("https://api.acme.test");
    expect(storage.get("postwave_api_url")).toBe("https://api.acme.test");
    expect(getWorkspaces().activeId).toBe("default");
    expect(storage.get("postwave.desktop.workspace-switch.v1")).not.toBeNull();
    expect(h.releaseApiIdentityTransition).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
  });
});

describe("workspace switch crash reconciliation", () => {
  const phases = [
    "prepared",
    "quiesced",
    "native-activated",
    "config-activated",
    "metadata-committed",
    "rolling-back",
    "native-restored",
    "config-restored",
    "metadata-restored",
  ] as const;

  function nativeSnapshot(
    configured: boolean,
    id: "default" | "target",
    apiUrl: string,
  ): {
    configured: boolean;
    baseUrl: string | null;
    credentialFingerprint: string | null;
  } {
    return configured
      ? {
          configured: true,
          baseUrl: apiUrl,
          credentialFingerprint: h.fingerprintFor(id),
        }
      : {
          configured: false,
          baseUrl: null,
          credentialFingerprint: null,
        };
  }

  it("rolls every crash phase back for configured and URL-only source/target combinations", async () => {
    for (const sourceConfigured of [false, true]) {
      for (const targetConfigured of [false, true]) {
        for (const phase of phases) {
          storage.clear();
          h.credentials.clear();
          __resetWorkspacesForTests();
          h.switchWorkspaceCredential.mockClear();
          h.releaseApiIdentityTransition.mockClear();
          h.parkOfflineStores.mockClear();
          h.clearPersistedQueryCache.mockClear();
          h.purgePrivateSessionState.mockClear();

          const sourceUrl = "https://source.acme.test";
          const targetUrl = "https://target.acme.test";
          const sourceNative = nativeSnapshot(
            sourceConfigured,
            "default",
            sourceUrl,
          );
          const targetNative = nativeSnapshot(
            targetConfigured,
            "target",
            targetUrl,
          );
          if (sourceConfigured) {
            h.credentials.set("default", {
              baseUrl: sourceUrl,
              key: "pw_source_key",
            });
          }
          if (targetConfigured) {
            h.credentials.set("target", {
              baseUrl: targetUrl,
              key: "pw_target_key",
            });
          }

          const targetNativeActive = [
            "native-activated",
            "config-activated",
            "metadata-committed",
            "rolling-back",
          ].includes(phase);
          const targetUrlActive = [
            "config-activated",
            "metadata-committed",
            "rolling-back",
            "native-restored",
          ].includes(phase);
          const targetMetadataActive = [
            "metadata-committed",
            "rolling-back",
            "native-restored",
            "config-restored",
          ].includes(phase);
          const activeNative = targetNativeActive ? targetNative : sourceNative;
          h.broker.configured = activeNative.configured;
          h.broker.baseUrl = activeNative.baseUrl;
          h.broker.credentialFingerprint = activeNative.credentialFingerprint;

          storage.set(
            "postwave_workspaces_v1",
            JSON.stringify({
              activeId: targetMetadataActive ? "target" : "default",
              profiles: [
                {
                  id: "default",
                  name: "Source",
                  apiUrl: sourceUrl,
                  hasKey: sourceConfigured,
                },
                {
                  id: "target",
                  name: "Target",
                  apiUrl: targetUrl,
                  hasKey: targetConfigured,
                },
              ],
            }),
          );
          storage.set(
            "postwave_api_url",
            targetUrlActive ? targetUrl : sourceUrl,
          );
          storage.set(
            "postwave.desktop.workspace-switch.v1",
            JSON.stringify({
              version: 1,
              transactionId: "switch-crash-0001",
              startedAt: 1_800_000_000_000,
              phase,
              source: { id: "default", apiUrl: sourceUrl },
              target: { id: "target", apiUrl: targetUrl },
              sourceNative,
              ...([
                "native-activated",
                "config-activated",
                "metadata-committed",
                "rolling-back",
                "native-restored",
                "config-restored",
                "metadata-restored",
              ].includes(phase)
                ? { targetNative }
                : {}),
            }),
          );

          await reconcilePendingWorkspaceSwitch({
            ...activeNative,
            legacyReentryRequired: false,
          });

          expect(h.broker.configured).toBe(sourceConfigured);
          expect(h.broker.baseUrl).toBe(sourceNative.baseUrl);
          expect(h.broker.credentialFingerprint).toBe(
            sourceNative.credentialFingerprint,
          );
          expect(storage.get("postwave_api_url")).toBe(sourceUrl);
          expect(
            JSON.parse(storage.get("postwave_workspaces_v1") ?? "{}").activeId,
          ).toBe("default");
          expect(
            storage.get("postwave.desktop.workspace-switch.v1"),
          ).toBeUndefined();
          expect(h.releaseApiIdentityTransition).toHaveBeenCalledTimes(1);
          expect(h.parkOfflineStores).toHaveBeenCalledTimes(1);
          expect(h.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
          expect(h.purgePrivateSessionState).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it("fails closed on profile URL mismatch and retains the journal", async () => {
    const sourceUrl = "https://source.acme.test";
    storage.set("postwave_api_url", sourceUrl);
    storage.set(
      "postwave_workspaces_v1",
      JSON.stringify({
        activeId: "default",
        profiles: [
          {
            id: "default",
            name: "Source",
            apiUrl: sourceUrl,
            hasKey: false,
          },
          {
            id: "target",
            name: "Target",
            apiUrl: "https://profile-target.acme.test",
            hasKey: false,
          },
        ],
      }),
    );
    storage.set(
      "postwave.desktop.workspace-switch.v1",
      JSON.stringify({
        version: 1,
        transactionId: "switch-mismatch-0001",
        startedAt: 1_800_000_000_000,
        phase: "prepared",
        source: { id: "default", apiUrl: sourceUrl },
        target: { id: "target", apiUrl: "https://journal-target.acme.test" },
        sourceNative: {
          configured: false,
          baseUrl: null,
          credentialFingerprint: null,
        },
      }),
    );

    await expect(
      reconcilePendingWorkspaceSwitch({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    ).rejects.toThrow(/metadata/i);

    expect(storage.get("postwave.desktop.workspace-switch.v1")).not.toBeNull();
    expect(h.beginApiIdentityTransition).not.toHaveBeenCalled();
    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
  });

  it("fails closed when the durable API URL is outside both journal endpoints", async () => {
    const sourceUrl = "https://source.acme.test";
    const targetUrl = "https://target.acme.test";
    storage.set("postwave_api_url", "https://unexpected.acme.test");
    storage.set(
      "postwave_workspaces_v1",
      JSON.stringify({
        activeId: "default",
        profiles: [
          {
            id: "default",
            name: "Source",
            apiUrl: sourceUrl,
            hasKey: false,
          },
          {
            id: "target",
            name: "Target",
            apiUrl: targetUrl,
            hasKey: false,
          },
        ],
      }),
    );
    storage.set(
      "postwave.desktop.workspace-switch.v1",
      JSON.stringify({
        version: 1,
        transactionId: "switch-url-mismatch-0001",
        startedAt: 1_800_000_000_000,
        phase: "config-activated",
        source: { id: "default", apiUrl: sourceUrl },
        target: { id: "target", apiUrl: targetUrl },
        sourceNative: {
          configured: false,
          baseUrl: null,
          credentialFingerprint: null,
        },
        targetNative: {
          configured: false,
          baseUrl: null,
          credentialFingerprint: null,
        },
      }),
    );

    await expect(
      reconcilePendingWorkspaceSwitch({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    ).rejects.toThrow(/API URL/i);

    expect(storage.get("postwave.desktop.workspace-switch.v1")).toBeDefined();
    expect(h.beginApiIdentityTransition).not.toHaveBeenCalled();
    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
  });

  it("bounds and validates recovery records without deleting uncertain state", async () => {
    storage.set("postwave.desktop.workspace-switch.v1", "x".repeat(9 * 1024));

    await expect(
      reconcilePendingWorkspaceSwitch({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    ).rejects.toThrow(/oversized/i);

    expect(storage.get("postwave.desktop.workspace-switch.v1")?.length).toBe(
      9 * 1024,
    );
    expect(h.switchWorkspaceCredential).not.toHaveBeenCalled();
  });
});

describe("removeWorkspace", () => {
  it("refuses to remove the active workspace", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    getWorkspaces();
    await expect(removeWorkspace("default")).rejects.toThrow(/active/i);
    expect(getWorkspaces().profiles).toHaveLength(1);
  });

  it("keeps the profile and credential when durable removal is denied", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const removable = await addWorkspace({
      name: "Removable",
      apiUrl: "https://remove.acme.test",
      key: "pw_remove_key",
    });
    h.removeWorkspaceCredential.mockClear();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });

    await expect(removeWorkspace(removable.id)).rejects.toThrow(
      /could not remove/i,
    );

    expect(getWorkspaces().profiles.some((p) => p.id === removable.id)).toBe(
      true,
    );
    expect(h.credentials.has(removable.id)).toBe(true);
    expect(h.removeWorkspaceCredential).not.toHaveBeenCalled();
  });

  it("removes the profile and deletes its keychain entry", async () => {
    storage.set("postwave_api_url", "https://api.acme.test");
    const staging = await addWorkspace({
      name: "Staging",
      apiUrl: "https://staging.acme.test",
      key: "pw_staging_key",
    });
    await removeWorkspace(staging.id);
    expect(h.removeWorkspaceCredential).toHaveBeenCalledWith(staging.id);
    expect(h.credentials.has(staging.id)).toBe(false);
    expect(getWorkspaces().profiles.map((p) => p.id)).toEqual(["default"]);
  });
});
