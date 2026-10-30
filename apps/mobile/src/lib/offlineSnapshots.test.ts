import { describe, expect, it, vi } from "vitest";

import { loadOfflineCapableSnapshot } from "./offlineSnapshots";

describe("identity-scoped cold-offline snapshot loading", () => {
  it("reads local data without constructing or calling a network client", async () => {
    const loadNetwork = vi.fn(async () => ({ source: "network" }));
    const readSnapshot = vi.fn(async () => ({ source: "snapshot" }));

    await expect(
      loadOfflineCapableSnapshot({
        canUseNetwork: false,
        loadNetwork,
        readSnapshot,
        networkAvailable: () => false,
        unavailableMessage: "No saved data is available offline.",
      }),
    ).resolves.toEqual({ source: "snapshot" });
    expect(loadNetwork).not.toHaveBeenCalled();
  });

  it("distinguishes an unavailable snapshot from a valid empty projection", async () => {
    await expect(
      loadOfflineCapableSnapshot({
        canUseNetwork: false,
        loadNetwork: vi.fn(),
        readSnapshot: async () => null,
        networkAvailable: () => false,
        unavailableMessage: "No saved audit snapshot is available offline.",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "offline_snapshot_unavailable",
      }),
    );

    await expect(
      loadOfflineCapableSnapshot<unknown[]>({
        canUseNetwork: false,
        loadNetwork: vi.fn(),
        readSnapshot: async () => [],
        networkAvailable: () => false,
        unavailableMessage: "missing",
      }),
    ).resolves.toEqual([]);
  });

  it("writes successful network projections to the encrypted snapshot", async () => {
    const writeSnapshot = vi.fn(async () => undefined);

    await expect(
      loadOfflineCapableSnapshot({
        canUseNetwork: true,
        loadNetwork: async () => ({ id: "safe-minimal" }),
        readSnapshot: async () => null,
        writeSnapshot,
        networkAvailable: () => true,
        unavailableMessage: "missing",
      }),
    ).resolves.toEqual({ id: "safe-minimal" });
    expect(writeSnapshot).toHaveBeenCalledWith({ id: "safe-minimal" });
  });

  it("falls back only for a real connectivity loss, not server/auth errors", async () => {
    const serverError = new Error("request failed");
    const readSnapshot = vi.fn(async () => ({ source: "snapshot" }));

    await expect(
      loadOfflineCapableSnapshot({
        canUseNetwork: true,
        loadNetwork: async () => {
          throw serverError;
        },
        readSnapshot,
        unavailableMessage: "missing",
        networkAvailable: () => true,
      }),
    ).rejects.toBe(serverError);
    expect(readSnapshot).not.toHaveBeenCalled();

    await expect(
      loadOfflineCapableSnapshot({
        canUseNetwork: true,
        loadNetwork: async () => {
          throw serverError;
        },
        readSnapshot,
        unavailableMessage: "missing",
        networkAvailable: () => false,
      }),
    ).resolves.toEqual({ source: "snapshot" });
  });
});

describe("a failed snapshot WRITE must not fail a successful read", () => {
  /**
   * The write used to sit inside the same try as the network read, so a cache
   * write that threw discarded a response that had already arrived intact.
   *
   * Observed in-app on 2026-08-19: /api/v1/dashboard/stats answered 200 with
   * 908 bytes satisfying every required field, and the dashboard still rendered
   * "Something went wrong loading the dashboard" -- because persisting the
   * snapshot failed afterwards. The freshest data the device would ever have
   * was thrown away by the failure of an optimisation for the NEXT launch.
   */
  it("returns the network value when writeSnapshot rejects", async () => {
    const write = vi.fn(async () => {
      throw new Error("SecureStore: could not write value");
    });
    const value = await loadOfflineCapableSnapshot<{ n: number }>({
      canUseNetwork: true,
      loadNetwork: async () => ({ n: 42 }),
      readSnapshot: async () => null,
      writeSnapshot: write,
      networkAvailable: () => true,
      unavailableMessage: "none",
    });
    expect(value).toEqual({ n: 42 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to a STALE snapshot when only the write failed", async () => {
    // The fresh value must win. Falling back here would silently downgrade
    // live data to whatever was cached last.
    const value = await loadOfflineCapableSnapshot<{ n: number }>({
      canUseNetwork: true,
      loadNetwork: async () => ({ n: 2 }),
      readSnapshot: async () => ({ n: 1 }),
      writeSnapshot: async () => {
        throw new Error("disk full");
      },
      networkAvailable: () => true,
      unavailableMessage: "none",
    });
    expect(value).toEqual({ n: 2 });
  });

  it("still propagates a genuine NETWORK failure", async () => {
    // The guard must not swallow the case the taxonomy exists for.
    await expect(
      loadOfflineCapableSnapshot<{ n: number }>({
        canUseNetwork: true,
        loadNetwork: async () => {
          throw new Error("upstream unavailable");
        },
        readSnapshot: async () => null,
        writeSnapshot: async () => undefined,
        networkAvailable: () => true,
        unavailableMessage: "none",
      }),
    ).rejects.toThrow(/upstream unavailable/u);
  });
});
