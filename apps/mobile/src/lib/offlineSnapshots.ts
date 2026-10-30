export class OfflineSnapshotUnavailableError extends Error {
  readonly code = "offline_snapshot_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "OfflineSnapshotUnavailableError";
  }
}

/**
 * Resolve an identity-scoped local projection without ever constructing an
 * API client while online authorization is unavailable. When an authorized
 * request races with a network drop, the same projection is used as fallback.
 */
export async function loadOfflineCapableSnapshot<T>(input: {
  canUseNetwork: boolean;
  loadNetwork: () => Promise<T>;
  readSnapshot: () => Promise<T | null>;
  writeSnapshot?: (value: T) => Promise<void>;
  unavailableMessage: string;
  networkAvailable: () => boolean;
}): Promise<T> {
  if (!input.canUseNetwork) {
    const cached = await input.readSnapshot();
    if (cached != null) return cached;
    throw new OfflineSnapshotUnavailableError(input.unavailableMessage);
  }

  try {
    const value = await input.loadNetwork();
    // WRITING THE SNAPSHOT IS BEST EFFORT AND MUST NOT FAIL THE READ.
    //
    // It used to sit inside this try, so a failed CACHE WRITE discarded a
    // network response that had already arrived intact and rethrew — the
    // screen showed "Something went wrong loading the dashboard" while the
    // server had answered 200 with a complete payload. Observed in-app on
    // 2026-08-19: /api/v1/dashboard/stats returned 908 bytes satisfying every
    // required field, and the dashboard rendered its error state anyway.
    //
    // The snapshot exists so the NEXT launch can render offline. Failing to
    // save it costs exactly that and nothing else; it says nothing about the
    // data in hand, which is the freshest this device will ever have.
    await input.writeSnapshot?.(value).catch(() => undefined);
    return value;
  } catch (error) {
    if (!input.networkAvailable()) {
      const cached = await input.readSnapshot();
      if (cached != null) return cached;
    }
    throw error;
  }
}
