/**
 * lib/dashboardFailure.ts — one taxonomy for "the dashboard didn't load".
 *
 * The screen used to render `stats.error.message` verbatim inside a red card
 * with no retry. That is wrong twice over: it leaks transport internals
 * ("Request failed with status code 403", a stack-ish SDK string) at the user,
 * and it flattens five materially different situations into one. A viewer-role
 * user who is simply not allowed to see workspace analytics should not be told
 * the product is broken.
 *
 * Mirrors the desktop `statsTransportFailure` five-way split
 * (apps/desktop/src/pages/dashboard/useDashboardData.ts) so the two clients
 * describe the same condition the same way:
 *
 *   offline        — the device cannot reach anything. Nothing is broken.
 *   unauthenticated— the session lapsed. Signing in again fixes it.
 *   restricted     — the role is not permitted. Retrying will never help, so
 *                    no retry is offered and the copy names the boundary.
 *   invalid        — we reached the server and could not trust what came back
 *                    (see lib/dashboardStatsSchema). Usually transient.
 *   rate_limited   — too many requests; waiting fixes it.
 *   server         — a 5xx. Ours to fix, theirs to retry.
 *   unknown        — anything else.
 *
 * Pure: no React, no network, no clock. `online` is injected so the caller
 * decides how to detect connectivity (the app uses lib/connectivity).
 *
 * The COPY is in the catalogue (DASHBOARD#83). It has to be: this module is
 * the only place the user-visible words for a failed dashboard exist, so an
 * untranslated taxonomy would leave the first screen of the app English no
 * matter how much of the chrome around it was translated. Each kind keeps its
 * own title key even where English repeats the words, because the repetition
 * is an English coincidence, not a shared meaning.
 */
import { DashboardPayloadError } from "@/lib/dashboardStatsSchema";
import { msg } from "@/lib/i18n";

export type DashboardFailureKind =
  | "offline"
  | "unauthenticated"
  | "restricted"
  | "invalid"
  | "rate_limited"
  | "server"
  | "unknown";

export interface DashboardFailure {
  kind: DashboardFailureKind;
  /**
   * Heading for the notice this failure renders into. It must name the actual
   * condition: an expired session titled "Metrics are restricted" tells the
   * user their ROLE changed, which sends them to an admin instead of to the
   * sign-in screen that would actually fix it.
   */
  title: string;
  /** Stable, user-facing copy. Never the raw transport string. */
  message: string;
  /**
   * Label for the recovery affordance, or null when retrying cannot possibly
   * help — offering "Try again" on a permission boundary is a small lie.
   */
  retryLabel: string | null;
  /** HTTP status when the transport produced one; 0 otherwise. */
  status: number;
}

/** Pull a numeric status off a thrown SDK error. Non-SDK errors map to 0. */
export function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return 0;
}

function isPayloadError(error: unknown): boolean {
  if (error instanceof DashboardPayloadError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "DashboardPayloadError"
  );
}

/**
 * Matched by NAME and CODE rather than `instanceof`: the error crosses a
 * TanStack query boundary and, in a persisted/rehydrated cache, may arrive as
 * a plain object that lost its prototype.
 */
function isSnapshotUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "OfflineSnapshotUnavailableError" ||
    candidate.code === "offline_snapshot_unavailable"
  );
}

export interface ClassifyOptions {
  /** Whether the device believes it has a connection. Defaults to true. */
  online?: boolean;
}

/**
 * Map a thrown error onto the taxonomy. Returns null for "no failure", so a
 * caller can write `const failure = query.isError ? classify(...) : null`
 * without a second branch.
 */
export function classifyDashboardFailure(
  error: unknown,
  { online = true }: ClassifyOptions = {},
): DashboardFailure {
  const status = statusOf(error);

  if (isPayloadError(error)) {
    return {
      kind: "invalid",
      status,
      title: msg("dashboard.failure.invalid.title"),
      message: msg("dashboard.failure.invalid.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  if (status === 401) {
    return {
      kind: "unauthenticated",
      status,
      title: msg("dashboard.failure.unauthenticated.title"),
      message: msg("dashboard.failure.unauthenticated.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  if (status === 403) {
    return {
      kind: "restricted",
      status,
      title: msg("dashboard.failure.restricted.title"),
      message: msg("dashboard.failure.restricted.body"),
      retryLabel: null,
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limited",
      status,
      title: msg("dashboard.failure.rateLimited.title"),
      message: msg("dashboard.failure.rateLimited.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  if (status >= 500) {
    return {
      kind: "server",
      status,
      title: msg("dashboard.failure.server.title"),
      message: msg("dashboard.failure.server.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  // The offline read ran and found nothing on this device. Distinct from
  // "you're offline": the network may be fine and the SESSION may simply be
  // cached-only, in which case "something went wrong" is both wrong and
  // unactionable. This is a `offline` kind because the recovery is identical
  // — reconnect — but the sentence names the real condition.
  if (isSnapshotUnavailable(error)) {
    return {
      kind: "offline",
      status,
      title: msg("dashboard.failure.noSnapshot.title"),
      message: msg("dashboard.failure.noSnapshot.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  // No status at all means the request never reached a server: either the
  // device is offline or the connection died mid-flight.
  if (status === 0 && !online) {
    return {
      kind: "offline",
      status,
      title: msg("dashboard.failure.offline.title"),
      message: msg("dashboard.failure.offline.body"),
      retryLabel: msg("dashboard.failure.retry"),
    };
  }

  return {
    kind: "unknown",
    status,
    title: msg("dashboard.failure.unknown.title"),
    message: msg("dashboard.failure.unknown.body"),
    retryLabel: msg("dashboard.failure.retry"),
  };
}

/**
 * A restricted dashboard must not paint tiles at all: the pickers would show
 * em-dashes that read as "your workspace is empty" rather than "you can't see
 * this". Callers use this to suppress the grid.
 */
export function hidesMetrics(failure: DashboardFailure | null): boolean {
  return failure?.kind === "restricted" || failure?.kind === "unauthenticated";
}
