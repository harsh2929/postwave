/**
 * audienceGateNotice — the "reconnect before this screen can load" copy for
 * the audience surfaces that aren't in CachedSessionNotice's own
 * `CachedSessionSurface` union (that component is shared and owned
 * elsewhere; adding cases to it from here would be a cross-cutting edit).
 *
 * Why the notice matters at all: every audience query is gated on
 * `useOnlineQueryGate`, so with the gate closed the query never runs and
 * `isLoading` / `isError` are BOTH false with zero rows — indistinguishable
 * from a genuinely empty workspace. Without this the screen confidently
 * tells the operator they have no segments.
 *
 * Pure + RN-free so the branch logic is unit-testable.
 */

export interface AudienceGateNotice {
  title: string;
  description: string;
  staleMessage: string;
}

/**
 * Returns null when the gate is open (nothing to say), otherwise the copy
 * for the reason it is closed:
 *   - authenticated but not re-validated online → "reconnect to load X"
 *   - no workspace at all → "reconnect your workspace"
 */
export function audienceGateNotice({
  gateEnabled,
  hasTenant,
  noun,
}: {
  gateEnabled: boolean;
  hasTenant: boolean;
  /** Lowercase plural noun for the screen, e.g. "segments", "list members". */
  noun: string;
}): AudienceGateNotice | null {
  if (gateEnabled) return null;
  if (hasTenant) {
    return {
      title: `Reconnect to load ${noun}`,
      description: `This cached session has not been validated online yet. Reconnect before loading ${noun}.`,
      staleMessage: `Reconnect before refreshing ${noun}. Showing the last loaded results.`,
    };
  }
  return {
    title: "Reconnect your workspace",
    description:
      "This screen needs an authenticated workspace before it can refresh.",
    staleMessage:
      "Reconnect your workspace before refreshing. Showing anything already cached.",
  };
}
