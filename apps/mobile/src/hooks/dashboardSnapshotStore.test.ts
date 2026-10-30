import { beforeEach, describe, expect, it, vi } from "vitest";

type VaultOptions = { scope?: string; ttlMs?: number };

const vaultSetJSON = vi.fn(
  async (
    _kind: string,
    _slot: string,
    _value: unknown,
    _options?: VaultOptions,
  ): Promise<void> => undefined,
);
const vaultGetJSON = vi.fn(async (): Promise<unknown> => null);

vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: (...args: Parameters<typeof vaultGetJSON>) =>
    vaultGetJSON(...args),
  vaultSetJSON: (...args: Parameters<typeof vaultSetJSON>) =>
    vaultSetJSON(...args),
  vaultScopeForClient: (input: Record<string, string>) => JSON.stringify(input),
}));

// eslint-disable-next-line import/first
import {
  DASHBOARD_SNAPSHOT_TTL_MS,
  dashboardSnapshotSlot,
  dashboardVaultScope,
  readDashboardSnapshot,
  resetDashboardSnapshotWriteLedger,
  writeDashboardSnapshot,
} from "./dashboardSnapshotStore";

const STATS = { subscribers_total: 100, campaigns_sent_30d: 3 };

beforeEach(() => {
  vaultSetJSON.mockClear();
  vaultGetJSON.mockClear();
  resetDashboardSnapshotWriteLedger();
});

describe("scope discipline", () => {
  it("writes NOTHING when the session has no identity scope", async () => {
    // `vaultSetJSON` falls back to a shared "global" scope when none is
    // given. Passing null through would file one workspace's counts where
    // every other identity on the device could read them.
    await writeDashboardSnapshot("stats-30d", null, STATS);
    expect(vaultSetJSON).not.toHaveBeenCalled();
  });

  it("reads NOTHING when the session has no identity scope", async () => {
    expect(await readDashboardSnapshot("stats-30d", null)).toBeNull();
    expect(vaultGetJSON).not.toHaveBeenCalled();
  });

  it("refuses to build a scope from an incomplete session", async () => {
    // API-key mode has no human user or role. It gets the network and
    // nothing on disk.
    expect(
      dashboardVaultScope({
        enabled: true,
        baseUrl: "https://api.test",
        tenantId: "t-1",
        userId: null,
        effectiveRole: null,
        credentialScope: "api-key:test",
        canReadOfflineSnapshots: false,
      }),
    ).toBeNull();
    expect(
      dashboardVaultScope({
        enabled: true,
        baseUrl: "https://api.test",
        tenantId: "t-1",
        userId: "u-1",
        effectiveRole: "admin",
        credentialScope: "session",
        canReadOfflineSnapshots: true,
      }),
    ).toContain("u-1");
  });
});

describe("write policy", () => {
  it("does not rewrite an unchanged projection on every 30-second poll", async () => {
    // 120 Keychain round-trips an hour to persist bytes that did not move.
    await writeDashboardSnapshot("stats-30d", "scope-a", STATS);
    await writeDashboardSnapshot("stats-30d", "scope-a", STATS);
    await writeDashboardSnapshot("stats-30d", "scope-a", { ...STATS });
    expect(vaultSetJSON).toHaveBeenCalledTimes(1);
    expect(vaultSetJSON.mock.calls[0]?.[3]).toMatchObject({
      scope: "scope-a",
      ttlMs: DASHBOARD_SNAPSHOT_TTL_MS,
    });
  });

  it("writes immediately when a figure moves — staleness is the point", async () => {
    await writeDashboardSnapshot("stats-30d", "scope-a", STATS);
    await writeDashboardSnapshot("stats-30d", "scope-a", {
      ...STATS,
      subscribers_total: 101,
    });
    expect(vaultSetJSON).toHaveBeenCalledTimes(2);
  });

  it("keeps windows and identities in separate slots", async () => {
    await writeDashboardSnapshot(dashboardSnapshotSlot("7d"), "scope-a", STATS);
    await writeDashboardSnapshot(dashboardSnapshotSlot("90d"), "scope-a", STATS);
    await writeDashboardSnapshot(dashboardSnapshotSlot("7d"), "scope-b", STATS);
    expect(vaultSetJSON).toHaveBeenCalledTimes(3);
    expect(vaultSetJSON.mock.calls.map((call) => call[1])).toEqual([
      "stats-7d",
      "stats-90d",
      "stats-7d",
    ]);
  });

  it("does not suppress the next attempt after a failed write", async () => {
    vaultSetJSON.mockRejectedValueOnce(new Error("keychain locked"));
    await expect(
      writeDashboardSnapshot("stats-30d", "scope-a", STATS),
    ).rejects.toThrow("keychain locked");
    await writeDashboardSnapshot("stats-30d", "scope-a", STATS);
    expect(vaultSetJSON).toHaveBeenCalledTimes(2);
  });

  it("leaves a good snapshot alone when nothing survived the allowlist", async () => {
    await writeDashboardSnapshot("stats-30d", "scope-a", {
      recent_audit: [{ actor: "Ava" }],
    });
    expect(vaultSetJSON).not.toHaveBeenCalled();
  });
});

describe("read path", () => {
  it("re-projects the stored blob rather than trusting it", async () => {
    vaultGetJSON.mockResolvedValueOnce({
      subscribers_total: 12,
      recent_audit: [{ actor: "Ava" }],
    });
    expect(await readDashboardSnapshot("stats-30d", "scope-a")).toEqual({
      subscribers_total: 12,
    });
  });

  it("treats an unusable blob as no snapshot", async () => {
    vaultGetJSON.mockResolvedValueOnce("not an object");
    expect(await readDashboardSnapshot("stats-30d", "scope-a")).toBeNull();
  });
});
